"""Typed operator policy for a single pre-setup ownership lease.

Resource identities are configuration, never application-selected commands.
The reviewed-controller adapter supplies its existing root receipt schema.
"""
from dataclasses import dataclass
import pathlib
import re
from contracts import require, digest, SHA, UUID


@dataclass(frozen=True)
class SetupOwnership:
    job_id: str
    schema: str
    runner: str
    mysql: str
    uid: int
    gid: int
    source_root: str
    owner_root: str
    run_id: str
    databases: tuple
    account: str
    private_root: str
    private_paths: tuple
    receipt_path: str
    lease_seconds: int
    evidence_path: str
    evidence_sha256: str

    @classmethod
    def from_plan(cls, plan, packet):
        profile, trial = plan['profile'], packet.trial
        require(UUID.fullmatch(plan['jobId']), 'setup_job_id_invalid')
        value = profile.get('setupContainment')
        require(isinstance(value, dict) and set(value) == {'schema', 'databases', 'account', 'receiptName',
                'evidencePath', 'evidenceSha256', 'privatePaths', 'privateRoot'}, 'setup_policy_required')
        require(re.fullmatch(r'[a-z0-9][a-z0-9.-]{0,95}', value['schema']), 'setup_schema_invalid')
        require(isinstance(value['databases'], list) and 1 <= len(value['databases']) <= 8 and
                len(set(value['databases'])) == len(value['databases']) and
                all(isinstance(x, str) and re.fullmatch(r'[a-z][a-z0-9]{0,63}', x) for x in value['databases']),
                'setup_exact_databases_invalid')
        private_root = pathlib.PurePosixPath(value['privateRoot'])
        require(private_root.is_absolute() and '..' not in private_root.parts and len(private_root.parts) >= 3 and
                str(private_root) == value['privateRoot'] and pathlib.PurePosixPath(trial['sourceRoot']).is_relative_to(private_root),
                'setup_private_root_invalid')
        require(isinstance(value['privatePaths'], list) and 1 <= len(value['privatePaths']) <= 32 and
                all(isinstance(x, str) and x and not pathlib.PurePosixPath(x).is_absolute() and
                    '..' not in pathlib.PurePosixPath(x).parts and '.' != x and
                    re.fullmatch(r'[a-zA-Z0-9_./-]+', x) for x in value['privatePaths']), 'setup_private_paths_invalid')
        require(value['databases'] == trial.get('ownedDatabases'), 'setup_trial_databases_mismatch')
        require(re.fullmatch(r'[a-z][a-z0-9_]{0,31}', value['account']) and
                value['account'] == trial['dbUser'], 'setup_account_invalid')
        require(re.fullmatch(r'[a-z0-9-]{1,80}\.json', value['receiptName']) and
                SHA.fullmatch(value['evidenceSha256']), 'setup_receipt_binding_invalid')
        evidence = pathlib.PurePosixPath(value['evidencePath'])
        require(evidence.is_absolute() and '..' not in evidence.parts and str(evidence).startswith('/etc/paperclip-runner-results/'),
                'setup_evidence_path_invalid')
        require(trial['ttlSeconds'] == 1800 and trial['uid'] == profile['uid'] and trial['gid'] == profile['gid'] and
                re.fullmatch(r'[a-zA-Z0-9-]{1,96}', trial['operatorExecutionId']), 'setup_runtime_identity_invalid')
        for name in ['sourceRoot', 'ownerRoot']:
            path = pathlib.PurePosixPath(trial[name])
            require(path.is_absolute() and '..' not in path.parts and str(path) == trial[name] and len(path.parts) >= 4,
                    'setup_owned_path_invalid')
        require(trial['runner'] == profile['runner'] and re.fullmatch(r'[a-zA-Z0-9_][a-zA-Z0-9_.-]*', trial['mysql']),
                'setup_container_identity_invalid')
        return cls(plan['jobId'], value['schema'], profile['runner'], trial['mysql'], profile['uid'], profile['gid'],
                   trial['sourceRoot'], trial['ownerRoot'], trial['operatorExecutionId'], tuple(value['databases']),
                   value['account'], value['privateRoot'], tuple(value['privatePaths']), profile['authorityRoot'] + '/' + value['receiptName'], 1800,
                   str(evidence), value['evidenceSha256'])

    @property
    def resource_digest(self):
        return digest([self.runner, self.mysql, self.uid, self.gid, self.source_root, self.owner_root,
                       self.run_id, self.databases, self.account, self.private_root, self.private_paths])
