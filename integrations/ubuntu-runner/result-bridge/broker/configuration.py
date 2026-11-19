"""All privileged policy is operator-owned, outside candidate workspaces."""
import json
import os
import pathlib
import re
import stat
from urllib.parse import urlsplit
from contracts import require, digest, UUID, SHA, KEY, closed_json


def private_file(path):
    p = pathlib.Path(path)
    for ancestor in [p, *p.parents]:
        require(not ancestor.is_symlink(), "operator_path_symlink")
    st = p.lstat()
    require(stat.S_ISREG(st.st_mode) and st.st_uid == os.getuid() and
            stat.S_IMODE(st.st_mode) == 0o600 and st.st_size <= 2 * 1024 * 1024, "operator_file_untrusted")
    return p


def validate_required_packet_inputs(profile):
    if 'requiredPacketInputs' not in profile:
        return
    required_inputs = profile['requiredPacketInputs']
    path_pattern = r'[A-Za-z0-9][A-Za-z0-9_.-]*(?:/[A-Za-z0-9][A-Za-z0-9_.-]*)*'
    require(profile['allowReviewedController'] and isinstance(required_inputs, dict) and
            0 < len(required_inputs) <= 128 and
            all(isinstance(name, str) and len(name) <= 240 and name.count('{key}') <= 1 and
                re.fullmatch(path_pattern, name.replace('{key}', 'key')) and
                isinstance(sha, str) and SHA.fullmatch(sha) for name, sha in required_inputs.items()),
            'broker_required_packet_inputs_invalid')


def load(path):
    config = closed_json(private_file(path).read_bytes())
    base = {"stateRoot", "socketPath", "socketGid", "pluginAuthFile", "apiBaseUrl", "tokenFile", "databaseContainer",
            "databaseUser", "databaseName", "callbackUrl", "profiles"}
    require(base <= set(config) <= base | {'nativeQueue'}, "broker_configuration_invalid")
    if 'nativeQueue' in config:
        require(config['callbackUrl']=='','native_queue_legacy_callback_forbidden')
        value = config['nativeQueue']
        require(isinstance(value,dict) and {'pluginId','signingKeyFile','isolationReceiptFile','isolationReceiptSha256','agentPolicyFile'} <= set(value) <= {'pluginId','signingKeyFile','isolationReceiptFile','isolationReceiptSha256','agentPolicyFile','applicationContainer'} and
                UUID.fullmatch(value['pluginId']) and SHA.fullmatch(value['isolationReceiptSha256']), 'native_queue_configuration_invalid')
        private_file(value['signingKeyFile']); private_file(value['isolationReceiptFile'])
        private_file(value['agentPolicyFile'])
        require(isinstance(value.get('applicationContainer','paperclip-paperclip-1'),str)and re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}',value.get('applicationContainer','paperclip-paperclip-1')),'native_event_container_invalid')
    url = urlsplit(config["apiBaseUrl"])
    require(url.scheme in ["http", "https"] and url.hostname in ["127.0.0.1", "localhost"] and
            not url.username and not url.password and not url.query and not url.fragment and url.path in ["", "/"], "broker_api_not_loopback")
    for key in ["databaseContainer", "databaseUser", "databaseName"]:
        require(re.fullmatch(r"[a-zA-Z0-9_.-]+", config[key]), "broker_database_binding_invalid")
    require(type(config["socketGid"]) is int and config["socketGid"] == 0, "broker_socket_group_invalid")
    require(isinstance(config["profiles"], dict) and 1 <= len(config["profiles"]) <= 32, "broker_profiles_invalid")
    private_file(config["tokenFile"])
    private_file(config["pluginAuthFile"])
    if config["callbackUrl"]:
        target = urlsplit(config["callbackUrl"])
        require((target.scheme, target.netloc) == (url.scheme, url.netloc) and
                re.fullmatch(r"/api/plugins/[a-f0-9-]{36}/webhooks/terminal", target.path) and
                not target.username and not target.password and not target.query and not target.fragment, "broker_callback_invalid")
    owned_namespaces = {}
    for key, profile in config['profiles'].items():
        validate_profile(key, profile)
        if profile.get('setupContainment'):
            value = profile['setupContainment']
            scope = (profile['sshTarget'], profile['fixedTrialFields'].get('mysql'))
            names = {'schema:' + name for name in value['databases']} | {'account:' + value['account']}
            require(not names & owned_namespaces.get(scope, set()), 'broker_setup_namespace_overlap')
            owned_namespaces.setdefault(scope, set()).update(names)
        profile['policyDigest'] = digest(profile)
    return config


def validate_profile(key, profile):
    required = {'concurrency', 'sshIdentityFile', 'sshKnownHostsFile', 'sshTarget', 'remoteInstall', 'remoteState', 'runner', 'uid', 'gid',
                'fixedTrialFields', 'sourceAuthority', 'companyId', 'projectId', 'taskIds', 'agentId',
                'scopeAgentId', 'scopeIssueIds', 'reviewerAgentIds', 'savedSessions', 'candidate',
                'targetDocumentKey', 'reviewDocumentKey', 'actualAcpDocumentKey', 'allowedModes',
                'sourceDecisionFingerprints', 'authorityRoot', 'trialRoot', 'continuationPattern',
                'executionIdPattern', 'authoritySchemaTemplate', 'allowReviewedController', 'privilegedCodeDigests', 'privilegedCodeApproval', 'allowControlChecks', 'controlInputs', 'preparedImage'}
    optional = {'setupContainment', 'requiredPacketInputs'}
    require(isinstance(profile, dict) and required <= set(profile) <= required | optional, 'broker_profile_fields_invalid')
    require(KEY.fullmatch(key), 'broker_profile_key_invalid')
    require(type(profile['concurrency']) is int and profile['concurrency'] == 1, 'broker_profile_concurrency_invalid')
    require(re.fullmatch(r'[a-zA-Z0-9_.@-]+', profile['sshTarget']) and not profile['sshTarget'].startswith('-'), 'broker_ssh_target_invalid')
    private_file(profile['sshIdentityFile'])
    private_file(profile['sshKnownHostsFile'])
    require(profile['remoteInstall'] == '/opt/paperclip-ubuntu-runner-results' and
            profile['remoteState'] == '/var/lib/paperclip-ubuntu-runner-results', 'broker_remote_paths_invalid')
    require(re.fullmatch(r'[a-zA-Z0-9_][a-zA-Z0-9_.-]*', profile['runner']), 'broker_runner_invalid')
    require(type(profile['uid']) is int and profile['uid'] > 0 and type(profile['gid']) is int and profile['gid'] >= 0,
            'broker_principal_invalid')
    for name in ['companyId', 'projectId', 'agentId', 'scopeAgentId']:
        require(isinstance(profile[name], str) and UUID.fullmatch(profile[name]), 'broker_scope_invalid')
    for name in ['taskIds', 'scopeIssueIds', 'reviewerAgentIds']:
        require(isinstance(profile[name], list) and 0 < len(profile[name]) <= 64 and
                all(isinstance(x, str) and UUID.fullmatch(x) for x in profile[name]), 'broker_scope_invalid')
    actors = {profile['agentId'], profile['scopeAgentId'], *profile['reviewerAgentIds']}
    require(isinstance(profile['savedSessions'], dict) and actors <= set(profile['savedSessions']) and
            all(UUID.fullmatch(x) and isinstance(y, str) and 1 <= len(y) <= 160 for x, y in profile['savedSessions'].items()),
            'broker_saved_sessions_invalid')
    require(re.fullmatch(r'[a-f0-9]{40}', profile['candidate']), 'broker_candidate_invalid')
    for name in ['targetDocumentKey', 'reviewDocumentKey', 'actualAcpDocumentKey']:
        require(KEY.fullmatch(profile[name]), 'broker_document_key_invalid')
    for name in ['authorityRoot', 'trialRoot']:
        value = pathlib.PurePosixPath(profile[name])
        require(value.is_absolute() and '..' not in value.parts and str(value) == profile[name] and len(value.parts) >= 3 and
                re.fullmatch(r'/[a-zA-Z0-9_./-]+', profile[name]), 'broker_root_invalid')
    for name in ['continuationPattern', 'executionIdPattern']:
        require(isinstance(profile[name], str) and len(profile[name]) <= 160, 'broker_pattern_invalid')
        re.compile(profile[name])
    require(re.fullmatch(r'[a-z0-9-]+-\{key\}-[a-z0-9.-]+', profile['authoritySchemaTemplate']), 'broker_schema_template_invalid')
    require(isinstance(profile['allowedModes'], list) and 0 < len(profile['allowedModes']) <= 8 and
            all(KEY.fullmatch(x.replace('_', '-')) for x in profile['allowedModes']), 'broker_modes_invalid')
    require(type(profile['allowControlChecks']) is bool and isinstance(profile['controlInputs'], list) and
            1 <= len(profile['controlInputs']) <= 64 and
            all(re.fullmatch(r'[a-z][a-z0-9_.-]{0,95}', x) for x in profile['controlInputs']), 'broker_control_inputs_invalid')
    require(re.fullmatch(r'sha256:[a-f0-9]{64}', profile['preparedImage']), 'broker_prepared_image_invalid')
    require(isinstance(profile['fixedTrialFields'], dict) and isinstance(profile['sourceAuthority'], dict) and
            isinstance(profile['sourceDecisionFingerprints'], dict) and 0 < len(profile['sourceDecisionFingerprints']) <= 16,
            'broker_authority_policy_invalid')
    require(profile['fixedTrialFields'].get('uid') == profile['uid'] and profile['fixedTrialFields'].get('gid') == profile['gid'] and
            profile['fixedTrialFields'].get('runner') == profile['runner'] and
            profile['fixedTrialFields'].get('companyId') == profile['companyId'] and
            profile['fixedTrialFields'].get('harnessIssueId') in profile['taskIds'], 'broker_trial_identity_invalid')

    require(type(profile['allowReviewedController']) is bool, 'broker_controller_policy_invalid')
    validate_required_packet_inputs(profile)
    pins = profile['privilegedCodeDigests']
    require(isinstance(pins, dict) and 1 <= len(pins) <= 128 and
            all(re.fullmatch(r'[a-z][a-z0-9_.{}-]+\.py', name) and SHA.fullmatch(sha) for name, sha in pins.items()),
            'broker_privileged_code_manifest_invalid')
    approval = profile['privilegedCodeApproval']
    require(isinstance(approval, dict) and set(approval) == {'issueId', 'documentKey', 'reviewerAgentId'} and
            UUID.fullmatch(approval['issueId']) and UUID.fullmatch(approval['reviewerAgentId']) and KEY.fullmatch(approval['documentKey']),
            'broker_privileged_code_approval_invalid')

    if 'setupContainment' in profile:
        value = profile['setupContainment']
        require(isinstance(value, dict) and set(value) == {'schema', 'databases', 'account', 'receiptName',
                'evidencePath', 'evidenceSha256', 'privatePaths', 'privateRoot'} and isinstance(value['databases'], list) and
                1 <= len(value['databases']) <= 8 and len(set(value['databases'])) == len(value['databases']) and
                all(isinstance(x, str) and re.fullmatch(r'[a-z][a-z0-9]{0,63}', x) for x in value['databases']) and
                SHA.fullmatch(value['evidenceSha256']), 'broker_setup_containment_policy_invalid')
