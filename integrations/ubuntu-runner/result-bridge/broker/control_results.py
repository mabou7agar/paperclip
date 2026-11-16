"""Validated control completion survives cleanup and a prior-release interruption.

Only root-private completion records or the original stopped, owned, confined
container supply facts. Recovery never starts a container, recipe or provider.
"""
from bounded_process import capture
from contracts import closed_json, closed_diagnostic, digest, require, Refusal
from ownership_ledger import OwnershipLedger
from packet import Packet

NAME = 'control-completion.json'


def validated_result(plan, packet, facts):
    facts = closed_diagnostic(facts)
    profile, request = plan['profile'], plan['request']
    require(facts['uid'] == profile['uid'] and facts['network'] == 'none' and
            facts['workspaceMounts'] == 0 and facts['scratchRemoved'] is True and
            facts['overflow'] is False and facts['timedOut'] is False and
            type(facts['exit']) is int, 'control_boundary_failed')
    return {'status': 'passed' if facts['exit'] == 0 else 'failed', 'kind': 'control_checks',
            'recipeSha256': packet.file_sha(request['recipe']), 'facts': facts,
            'controlDigest': plan['admission']['controlDigest'],
            'preparedImageSha256': profile['preparedImage'].removeprefix('sha256:'),
            'cleanupComplete': False, 'auditComplete': True}


def preserve_completion(root, plan, value):
    OwnershipLedger(root).once(NAME, {'schema': 'paperclip.control-completion.v1',
        'jobId': plan['jobId'], 'planSha256': digest(plan), 'result': value})


def recover_completion(root, plan, current):
    saved = (root / NAME).exists()
    if not saved and (current is None or current.get('running') is not False or current.get('exit') != 0):
        return None
    packet = Packet((root / 'packet.tar.gz').read_bytes(), plan['request']['packetSha256'], plan['profile'])
    if saved:
        stored = OwnershipLedger(root).read(NAME)
        require(stored['schema'] == 'paperclip.control-completion.v1' and
                stored['jobId'] == plan['jobId'] and stored['planSha256'] == digest(plan), 'control_completion_scope_changed')
        value = validated_result(plan, packet, stored['result']['facts'])
        require(value == stored['result'], 'control_completion_changed')
        return value
    # The original container may predate private completion records. A label or
    # a test's claimed network setting alone cannot establish its confinement.
    profile = plan['profile']
    require(current['job'] == plan['jobId'] and current['plan'] == digest(plan) and
            current['image'] == profile['preparedImage'] and
            current['user'] == str(profile['uid']) + ':' + str(profile['gid']) and
            current['network'] == 'none' and current['readonly'] is True and
            current['privileged'] is False and current['mountCount'] == 0 and
            current['capDrop'] == ['ALL'] and
            any(x in ['no-new-privileges', 'no-new-privileges:true'] for x in current['securityOpt']),
            'control_recovery_boundary_changed')
    name = 'paperclip-controls-' + plan['jobId']
    logs = capture(['docker', 'logs', name], timeout=20)
    require(logs['exit'] == 0 and not logs['timedOut'] and not logs['stdout']['overflow'] and
            not logs['stderr']['overflow'] and logs['stderr']['bytes'] == 0, 'control_completion_unavailable')
    try:
        facts = closed_json(logs['stdout']['retained'])
    except (ValueError, UnicodeError):
        raise Refusal('control_completion_unavailable') from None
    value = validated_result(plan, packet, facts)
    preserve_completion(root, plan, value)
    return value
