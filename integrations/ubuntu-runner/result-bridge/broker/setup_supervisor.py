"""Independent setup lease and one owned-resource cleanup, never a task scheduler.

The registered packet must tag application exec environments with the run ID and
use the protected SQL transport before their first DDL.
No candidate/test execution is started by this module.
"""
import hashlib
import dataclasses
import os
import pathlib
import subprocess
import sys
import time

HERE = pathlib.Path(__file__).absolute().parent
if __name__ == '__main__':
    if not sys.flags.isolated or not sys.dont_write_bytecode or os.getuid() != 0 or str(HERE) != '/opt/paperclip-ubuntu-runner-results' or HERE.is_symlink() or HERE.stat().st_uid != 0 or HERE.stat().st_mode & 0o022:
        raise RuntimeError('setup_operator_boundary_required')
sys.path.insert(0, str(HERE))
from contracts import canonical, digest, require, UUID, Refusal
from configuration import private_file
from supervision_policy import SetupOwnership
from ownership_ledger import OwnershipLedger, measurement, process_identity
from owned_resources import OwnedResourceRepository
from mysql_connections import MysqlConnectionRepository
from managed_mysql import ManagedMysqlService
from bounded_process import capture


def driver_alive(lease):
    try:
        return process_identity(lease['driverPid']) == lease['driverStartTicks']
    except (FileNotFoundError, ProcessLookupError, Refusal):
        return False


def write_external_once(path, value):
    path = pathlib.Path(path)
    info = path.parent.lstat()
    require(path.parent.is_dir() and not path.parent.is_symlink() and info.st_uid == 0 and
            info.st_mode & 0o777 == 0o700, 'setup_receipt_parent_untrusted')
    # Reuse the same exclusive private-file repository, not a replaceable app file.
    return OwnershipLedger(path.parent).once(path.name, value)


class SetupSupervisorService:
    def __init__(self, root, plan, packet):
        self.root, self.plan, self.packet = pathlib.Path(root), plan, packet
        self.ledger = OwnershipLedger(root)
        self.spec = SetupOwnership.from_plan(plan, packet)
        self.resources = OwnedResourceRepository(self.spec, registry=MysqlConnectionRepository(root))

    def start(self):
        require(not pathlib.Path(self.spec.owner_root).exists(), 'setup_owner_already_exists')
        proof = measurement(self.spec, HERE)
        self.resources.exact_absence()
        self.resources.private_absence()
        self.ledger.admit(self.spec, self.plan['admission']['admission'], proof, self.resources.bindings)
        unit = 'paperclip-runner-owner-' + self.spec.job_id
        result = subprocess.run(['systemd-run', '--quiet', '--no-block', '--unit=' + unit,
            '--property=Type=exec', '--property=Restart=no', '--property=RuntimeMaxSec=2500',
            '--property=TimeoutStopSec=10', '--property=UMask=0077', sys.executable, '-I', '-B',
            str(HERE / 'setup_supervisor.py'), '--watch', self.spec.job_id], capture_output=True, timeout=20)
        require(result.returncode == 0, 'setup_supervisor_launch_unconfirmed')
        for _ in range(100):
            if (self.root / 'ownership-startup.json').exists():
                startup = self.ledger.read('ownership-startup.json')
                require(driver_alive({'driverPid': startup['supervisorPid'], 'driverStartTicks': startup['supervisorStartTicks']}),
                        'setup_supervisor_not_alive')
                return {'path': self.spec.receipt_path, 'receiptSha256': digest(startup), **proof}
            time.sleep(.1)
        raise RuntimeError('setup_supervisor_startup_pending')

    def startup(self, lease):
        spec = self.spec
        value = {'schema': spec.schema, 'jobId': spec.job_id, 'candidate': self.plan['profile']['candidate'],
            'continuationId': self.packet.trial['continuationId'], 'runId': spec.run_id,
            'runner': spec.runner, 'mysql': spec.mysql, 'uid': spec.uid, 'gid': spec.gid,
            'sourceRoot': spec.source_root, 'ownerRoot': spec.owner_root,
            'ownedDatabases': list(spec.databases), 'account': spec.account,
            'admissionCoreSha256': lease['admissionCoreSha256'],
            'wholePacketSha256': self.plan['request']['packetSha256'],
            'recipeManifestSha256': self.plan['admission']['admission']['recipeManifestSha256'],
            **{key: lease[key] for key in ['installedBridgeSha256', 'cancellationEvidenceSha256', 'supervisorCodeSha256']},
            'setupCoveredBeforeFirstMutation': True, 'noRetry': True,
            'containerCancellationOwner': 'protected-reviewed-bridge', 'containerGroupTerminationVerified': True,
            'cleanupIndependentOfDriver': True, 'cleanupIncludesPartialDDL': True, 'inflightMysqlCancellationCovered': True,
            'startedUnix': lease['startedUnix'], 'expiresUnix': lease['expiresUnix'],
            'supervisorPid': os.getpid(), 'supervisorStartTicks': process_identity(os.getpid())}
        # The booleans above are accepted measurements of this exact installed
        # code, not assertions that future work has already terminated.
        measurement(spec, HERE)
        write_external_once(spec.receipt_path, value)
        self.ledger.once('ownership-startup.json', value)
        return value

    def watch(self):
        lease = self.ledger.read('ownership-lease.json')
        require(digest(lease['spec']) == digest(dataclasses.asdict(self.spec)) and
                lease['admissionCoreSha256'] == digest(self.plan['admission']['admission']), 'setup_lease_changed')
        require(self.resources.bindings == lease['containers'], 'setup_container_changed_before_start')
        remaining = max(0, lease['expiresUnix'] - time.time())
        deadline = time.monotonic() + min(remaining, self.spec.lease_seconds)
        self.startup(lease)
        while driver_alive(lease) and time.monotonic() < deadline:
            if (self.root / 'result.json').exists():break
            time.sleep(.25)
        return self.cleanup()

    def host_work_empty(self):
        unit = 'paperclip-runner-job-' + self.spec.job_id
        value = subprocess.run(['systemctl', 'show', '--property=ControlGroup', '--value', unit],
                               capture_output=True, timeout=5)
        require(value.returncode == 0 and len(value.stdout) < 512, 'setup_host_group_unconfirmed')
        group = value.stdout.decode().strip() or '/system.slice/' + unit + '.service'
        require(group == '/system.slice/' + unit + '.service', 'setup_host_group_identity_changed')
        events = pathlib.Path('/sys/fs/cgroup' + group) / 'cgroup.events'
        if not events.exists():return True
        fields = dict(line.split() for line in events.read_text().splitlines())
        require(fields.get('populated') in ['0', '1'], 'setup_host_group_state_invalid')
        return fields['populated'] == '0'

    def stop_host_work(self):
        unit = 'paperclip-runner-job-' + self.spec.job_id
        subprocess.run(['systemctl', 'stop', '--no-block', unit], capture_output=True, timeout=15)
        for _ in range(80):
            if self.host_work_empty():return
            time.sleep(.25)
        # Only the exact retained job's unit is fenced, never another workload.
        value = subprocess.run(['systemctl', 'kill', '--kill-whom=all', '--signal=KILL', unit], capture_output=True, timeout=10)
        require(value.returncode == 0, 'setup_host_termination_unconfirmed')
        for _ in range(40):
            if self.host_work_empty():return
            time.sleep(.1)
        raise RuntimeError('setup_host_work_still_active')

    def cleanup(self):
        if (self.root / 'ownership-final.json').exists():return self.ledger.read('ownership-final.json')
        self.ledger.once('ownership-cleanup-attempt.json', {'jobId': self.spec.job_id, 'attempt': 1})
        outcome = {'jobId': self.spec.job_id, 'cleanupComplete': False, 'auditComplete': False,
                   'executionRepeated': False, 'code': 'setup_cleanup_unconfirmed'}
        try:
            self.stop_host_work()
            require(not self.resources.processes(cancel=True), 'setup_container_work_still_active')
            self.resources.cancel_sessions()
            owner = pathlib.Path(self.spec.owner_root)
            template_audited = False
            if (owner / 'ledger.json').exists():
                try:
                    cleanup = self.root / 'packet' / self.packet.directory / 'cleanup.py'
                    result = capture([sys.executable, '-I', '-B', str(cleanup)], timeout=240, grace=10)
                    # An old zero-exit already-cleaned ledger does not by itself
                    # establish that its earlier evidence audit passed.
                    import json
                    saved_cleanup = json.loads(private_file(owner / 'ledger.json').read_bytes()).get('cleanup', {})
                    template_audited = result['exit'] == 0 and not result['timedOut'] and saved_cleanup.get('auditComplete') is True
                except Exception:
                    template_audited = False
            # A partial fixture can die before its own cleanup metadata is
            # complete. The independent lease proved exact initial absence and
            # holds cleanup authority for these resources even in that case.
            require(not self.resources.processes(cancel=True), 'setup_container_work_still_active')
            self.resources.cancel_sessions()
            self.resources.remove_databases(ManagedMysqlService(self.resources, self.resources.registry))
            self.resources.private_runtime(erase=True)
            connection = owner / 'private-connection.json'
            if connection.exists():
                private_file(connection).unlink()
            self.resources.exact_absence()
            self.resources.private_absence()
            outcome['auditComplete'] = template_audited or not (owner / 'ledger.json').exists()
            outcome.update(cleanupComplete=True, code='setup_owned_resources_absent')
        except Exception:
            # One cleanup attempt, retained closed result, no resource/job reset.
            pass
        self.ledger.once('ownership-final.json', outcome)
        return outcome


def main(identity):
    require(UUID.fullmatch(identity), 'setup_job_id_invalid')
    from remote_worker import root_for, trusted_root, read_json
    from packet import Packet
    root = root_for(identity);trusted_root(root)
    plan = read_json(root / 'plan.json', 2 * 1024 * 1024)
    packet = Packet((root / 'packet.tar.gz').read_bytes(), plan['request']['packetSha256'], plan['profile'], privileged=True)
    return SetupSupervisorService(root, plan, packet).watch()


if __name__ == '__main__':
    require(len(sys.argv) == 3 and sys.argv[1] == '--watch', 'setup_operation_invalid')
    main(sys.argv[2])
