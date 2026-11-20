"""Installed root-owned on the execution host. It is not an agent shell.

The main-host operator broker supplies an independently validated immutable
plan. A remote exclusive attempt and retained systemd identity survive SSH loss.
Application/test processes retain their existing non-root execution boundary.
"""
import base64
import datetime
import fcntl
import hashlib
import io
import json
import os
import pathlib
import signal
import stat
import subprocess
import sys
import tarfile

_HERE = pathlib.Path(os.path.abspath(__file__)).parent
if __name__ == '__main__':
    _st = _HERE.lstat()
    if (not sys.flags.isolated or not sys.dont_write_bytecode or os.getuid() != 0 or
            str(_HERE) != '/opt/paperclip-ubuntu-runner-results' or _HERE.is_symlink() or
            _st.st_uid != 0 or _st.st_mode & 0o022):
        raise RuntimeError('remote_code_boundary_invalid')
sys.path.insert(0, str(_HERE))
from contracts import UUID, canonical, closed_json, closed_diagnostic, digest, require, Refusal, SHA
from packet import Packet
from bounded_process import capture
from evidence import inventory, descriptors, private_bytes, LIMIT
from control_runner import control_checks, reconcile_control

STATE = pathlib.Path('/var/lib/paperclip-ubuntu-runner-results')
INSTALL = pathlib.Path('/opt/paperclip-ubuntu-runner-results')


def write_once(path, value, raw=False):
    data = value if raw else canonical(value)
    with path.open('xb') as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())
    path.chmod(0o600)
    directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def trusted_root(path):
    st = path.lstat()
    require(path.is_dir() and not path.is_symlink() and st.st_uid == 0 and
            stat.S_IMODE(st.st_mode) == 0o700, 'remote_state_untrusted')


def root_for(identity):
    require(UUID.fullmatch(identity), 'remote_job_id_invalid')
    trusted_root(STATE)
    jobs = STATE / 'jobs'
    jobs.mkdir(mode=0o700, exist_ok=True)
    trusted_root(jobs)
    return jobs / identity


def stage(plan):
    root = root_for(plan['jobId'])
    with (STATE / 'stage.lock').open('a+b') as lock:
        os.chmod(lock.name, 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX)
        if root.exists():
            trusted_root(root)
            saved = closed_json((root / 'plan.json').read_bytes())
            require(digest(saved) == digest({k: v for k, v in plan.items() if k != 'packet'}), 'remote_job_plan_conflict')
            return {'staged': True, 'replayed': True}
        packet_bytes = base64.b64decode(plan['packet'], validate=True)
        packet = Packet(packet_bytes, plan['request']['packetSha256'], plan['profile'], privileged=plan['request']['kind'] == 'reviewed_controller')
        import shutil
        temporary = root.parent / ('.staging-' + plan['jobId'])
        if temporary.exists():
            trusted_root(temporary)
            shutil.rmtree(temporary)  # Data-only interrupted staging; never an attempt.
        try:
            temporary.mkdir(mode=0o700)
            packet_root = temporary / 'packet'
            packet_root.mkdir(mode=0o700)
            for name, raw in packet.files.items():
                target = packet_root / name
                target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                write_once(target, raw, raw=True)
            # Preserve the exact compressed input, not a re-packed substitute.
            write_once(temporary / 'packet.tar.gz', packet_bytes, raw=True)
            write_once(temporary / 'plan.json', {k: v for k, v in plan.items() if k != 'packet'})
            temporary.rename(root)
            descriptor = os.open(root.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try: os.fsync(descriptor)
            finally: os.close(descriptor)
        finally:
            if temporary.exists():
                shutil.rmtree(temporary)
        return {'staged': True, 'replayed': False}


def read_json(path, limit=128 * 1024):
    st = path.lstat()
    require(stat.S_ISREG(st.st_mode) and st.st_uid == 0 and stat.S_IMODE(st.st_mode) == 0o600 and st.st_size <= limit,
            'remote_receipt_untrusted')
    return closed_json(path.read_bytes())


def inspect(identity):
    root = root_for(identity)
    if not root.exists():
        return {'phase': 'not_staged'}
    trusted_root(root)
    if (root / 'reconciled.json').exists():
        return {'phase': 'terminal', 'result': read_json(root / 'reconciled.json')}
    saved = read_json(root / 'result.json') if (root / 'result.json').exists() else None
    if saved:
        plan = read_json(root / 'plan.json', 2 * 1024 * 1024)
        from ownership_result import settle
        saved = settle(root, plan, saved)
        if saved is None:return {'phase': 'attempted', 'cleanupPending': True}
    if (root / 'attempt.json').exists() and (not saved or saved.get('status') == 'unknown' or saved.get('cleanupComplete') is False):
        # Read-only reconciliation after an interrupted connection/process.
        # Never run a controller, test, cleanup script or new systemd unit here.
        unit = subprocess.run(['systemctl', 'show', '--property=SubState', '--value',
                               'paperclip-runner-job-' + identity], capture_output=True, timeout=10)
        if unit.returncode == 0 and unit.stdout.strip() in [b'exited', b'dead', b'failed']:
            plan = read_json(root / 'plan.json', 2 * 1024 * 1024)
            if plan['request']['kind'] == 'reviewed_controller':
                packet = Packet((root / 'packet.tar.gz').read_bytes(), plan['request']['packetSha256'], plan['profile'], privileged=True)
                current = controller_result(plan, packet, None)
                from ownership_result import settle
                current = settle(root, plan, current)
                if current is None:return {'phase': 'attempted', 'cleanupPending': True}
            else:
                current = reconcile_control(root, plan, write_once)
            if current.get('cleanupComplete') and (current.get('auditComplete') or plan['profile'].get('setupContainment') or plan['request']['kind'] == 'control_checks'):
                # Positive resource absence releases execution ownership even
                # when evidence audit is a recorded failure. Native review and
                # acceptance still see failed/auditComplete=false, never pass.
                try: write_once(root / 'reconciled.json', current)
                except FileExistsError: pass
                return {'phase': 'terminal', 'result': read_json(root / 'reconciled.json')}
    if saved:
        return {'phase': 'terminal', 'result': saved}
    if not (root / 'attempt.json').exists():
        unit = subprocess.run(['systemctl', 'show', '--property=LoadState', '--property=SubState',
                               'paperclip-runner-job-' + identity], capture_output=True, timeout=10)
        require(unit.returncode == 0 and len(unit.stdout) <= 1024, 'remote_unit_identity_unavailable')
        fields = dict(line.split('=', 1) for line in unit.stdout.decode().splitlines() if '=' in line)
        if fields.get('LoadState') == 'not-found':
            return {'phase': 'staged'}
        if fields.get('SubState') in ['exited', 'dead', 'failed']:
            return {'phase': 'terminal', 'result': {'status': 'failed', 'kind': read_json(root / 'plan.json', 2 * 1024 * 1024)['request']['kind'],
                'code': 'remote_unit_did_not_start', 'executionStarted': False, 'cleanupComplete': True}}
        return {'phase': 'submitted'}
    return {'phase': 'attempted'}


def has_execution_record(root):
    return any(os.path.lexists(root / name) for name in ('attempt.json', 'result.json'))


def readiness(identity):
    root = root_for(identity);trusted_root(root)
    plan = read_json(root / 'plan.json', 2 * 1024 * 1024)
    if plan['request']['kind'] != 'reviewed_controller' or not plan['profile'].get('setupContainment'):
        return {'ready': True}
    if has_execution_record(root):
        return {'ready': True}
    try:
        from supervision_policy import SetupOwnership
        from ownership_ledger import measurement
        packet = Packet((root / 'packet.tar.gz').read_bytes(), plan['request']['packetSha256'], plan['profile'], privileged=True)
        assert_fresh_reviewed_paths(plan, packet)
        measurement(SetupOwnership.from_plan(plan, packet), _HERE)
    except Refusal as error:
        if error.code == 'reviewed_attempt_already_exists' and has_execution_record(root):
            # A concurrent launch may have created its own paths since this
            # read started. Let the retained identity reach normal inspection.
            return {'ready': True}
        return {'ready': False, 'code': error.code if error.code == 'reviewed_attempt_already_exists'
                else 'setup_readiness_not_accepted'}
    except (FileNotFoundError, KeyError, ValueError, TypeError):
        return {'ready': False, 'code': 'setup_readiness_not_accepted'}
    return {'ready': True}


def launch(identity):
    root = root_for(identity)
    trusted_root(root)
    with (root / 'launch.lock').open('a+b') as lock:
        os.chmod(lock.name, 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX)
        state = inspect(identity)
        if state['phase'] in ['terminal', 'attempted', 'submitted']:
            return state
        require((root / 'plan.json').is_file(), 'remote_plan_missing')
        # A retained unit name AND the exclusive attempt below prevent a late
        # or repeated launch RPC from executing the controller a second time.
        result = subprocess.run(['systemd-run', '--quiet', '--no-block', '--unit=paperclip-runner-job-' + identity,
                                 '--property=Type=oneshot', '--property=RemainAfterExit=yes',
                                 '--property=UMask=0077', '--property=Restart=no', '--property=TimeoutStartSec=2140', '--property=KillMode=mixed', '--property=TimeoutStopSec=660',
                                 sys.executable, '-I', '-B', str(INSTALL / 'remote_worker.py'), '--run', identity],
                                capture_output=True, timeout=20)
        if result.returncode:
            unit = subprocess.run(['systemctl', 'show', '--property=LoadState', '--value', 'paperclip-runner-job-' + identity],
                                  capture_output=True, timeout=10)
            require(unit.returncode == 0 and unit.stdout.strip() == b'loaded', 'remote_launch_unconfirmed')
        return {'phase': 'submitted'}



def assert_fresh_reviewed_paths(plan, packet):
    owner = pathlib.Path(plan['profile']['authorityRoot'])
    trusted_root(owner)
    for name in ['ownerRoot', 'driverReceiptPath', 'runtimeReceiptRoot', 'externalAuthorityPath',
                 'preexecutionAdmissionPath', 'caseArchivePath']:
        require(not os.path.lexists(packet.trial[name]), 'reviewed_attempt_already_exists')


def reviewed_preflight(root, plan, packet):
    assert_fresh_reviewed_paths(plan, packet)
    control = root / 'packet' / packet.directory / 'execute_qualification.py'
    preflight = capture([sys.executable, '-I', '-B', str(control), '--preflight-only'], timeout=40)
    require(preflight['exit'] == 0 and not preflight['timedOut'] and
            not preflight['stdout']['overflow'] and not preflight['stderr']['overflow'], 'reviewed_preflight_failed')
    assert_fresh_reviewed_paths(plan, packet)


def reviewed_controller(root, plan, packet):
    trial = packet.trial
    control = root / 'packet' / packet.directory / 'execute_qualification.py'
    # The independently verified native records are written once outside
    # Phase A. None is fabricated from a package's own asserted permission.
    effective_admission = dict(plan['admission']['admission'])
    if plan['profile'].get('setupContainment'):
        from setup_supervisor import SetupSupervisorService
        effective_admission['setupContainment'] = SetupSupervisorService(root, plan, packet).start()
    write_once(root / 'effective-admission.json', effective_admission)
    write_once(pathlib.Path(trial['externalAuthorityPath']), plan['admission']['authority'])
    write_once(pathlib.Path(trial['preexecutionAdmissionPath']), effective_admission)
    write_once(pathlib.Path(trial['caseArchivePath']), packet.files[packet.case_name], raw=True)
    write_once(root / 'controller-started.json', {'jobId': plan['jobId'], 'kind': 'reviewed_controller'})
    result = capture([sys.executable, '-I', '-B', str(control)], timeout=2100, limit=1024 * 1024, grace=620)
    return controller_result(plan, packet, result['exit'])


def controller_result(plan, packet, exit_code):
    trial = packet.trial
    driver_path = pathlib.Path(trial['driverReceiptPath'])
    job_root = root_for(plan['jobId'])
    ownership_path = job_root / 'ownership-final.json'
    ownership = read_json(ownership_path) if ownership_path.exists() else None
    if ownership:
        require(ownership['jobId'] == plan['jobId'] and ownership.get('executionRepeated') is False,
                'controller_ownership_receipt_mismatch')
    if not driver_path.exists():
        if ownership and ownership.get('cleanupComplete') is True:
            return {'status': 'failed', 'kind': 'reviewed_controller', 'code': 'controller_terminated_with_owned_cleanup',
                    'exit': exit_code, 'cleanupComplete': True, 'auditComplete': ownership.get('auditComplete') is True,
                    'supervisorReceiptSha256': hashlib.sha256(ownership_path.read_bytes()).hexdigest()}
        return {'status': 'unknown', 'kind': 'reviewed_controller', 'code': 'controller_receipt_missing', 'exit': exit_code}
    driver = read_json(driver_path)
    raw = driver_path.read_bytes()
    require(driver['wholePacketSha256'] == plan['request']['packetSha256'] and
            driver['continuationId'] == trial['continuationId'] and driver['attempt'] == driver['maxAttempts'] == 1,
            'controller_receipt_binding_failed')
    cleanup = driver.get('cleanup') or {}
    passed = driver.get('status') in ['passed', 'diagnostic_collected'] and cleanup.get('complete') is True and cleanup.get('auditComplete') is True
    outcome = {'status': 'passed' if passed else 'failed', 'kind': 'reviewed_controller',
               'controllerStatus': driver.get('status', 'unknown'), 'driverSha256': hashlib.sha256(raw).hexdigest(),
               'attempt': 1, 'maxAttempts': 1, 'exit': exit_code,
               'steps': [{'phase': x['name'].removesuffix('.py'), 'exit': x.get('exit')} for x in driver.get('steps', [])],
               'cleanupComplete': cleanup.get('complete') is True, 'auditComplete': cleanup.get('auditComplete') is True,
               'functionalCasesStarted': driver.get('functionalCasesStarted') is True,
               'featurePassed': driver.get('featurePassed') is True, 'diagnostic': None}
    failure = pathlib.Path(trial['runtimeReceiptRoot']) / 'auth-failure-receipt.json'
    if failure.exists():
        value = read_json(failure)
        job_root = root_for(plan['jobId'])
        effective = read_json(job_root / 'effective-admission.json') if (job_root / 'effective-admission.json').exists() else plan['admission']['admission']
        expected = hashlib.sha256(canonical(effective)).hexdigest()
        require(value['caseAdmissionSha256'] == expected and value['candidate'] == plan['profile']['candidate'] and
                value['continuationId'] == trial['continuationId'], 'failure_receipt_binding_failed')
        try:
            outcome['diagnostic'] = closed_diagnostic(value['inner']['diagnostic'])
        except Refusal:
            outcome['diagnostic'] = {'status': 'diagnostic_unavailable', 'receipt': None}
    if ownership and ownership.get('cleanupComplete') is True and not outcome['cleanupComplete']:
        # Positive independent cleanup may settle ownership, but cannot invent
        # a passing test/feature verdict from an interrupted driver.
        outcome.update(status='failed', cleanupComplete=True, auditComplete=ownership.get('auditComplete') is True,
                       supervisorReceiptSha256=hashlib.sha256(ownership_path.read_bytes()).hexdigest())
    outcome['artifacts'] = descriptors(inventory(packet, driver))
    return outcome


def artifact(identity, sha):
    require(SHA.fullmatch(sha), 'artifact_digest_invalid')
    root = root_for(identity)
    trusted_root(root)
    plan = read_json(root / 'plan.json', 2 * 1024 * 1024)
    require(plan['request']['kind'] == 'reviewed_controller', 'artifact_kind_invalid')
    packet = Packet((root / 'packet.tar.gz').read_bytes(), plan['request']['packetSha256'], plan['profile'], privileged=plan['request']['kind'] == 'reviewed_controller')
    driver = read_json(pathlib.Path(packet.trial['driverReceiptPath']))
    require(driver['wholePacketSha256'] == plan['request']['packetSha256'] and
            driver['continuationId'] == packet.trial['continuationId'], 'artifact_job_binding_changed')
    entries = inventory(packet, driver)
    require(sha in entries, 'artifact_not_manifest_approved')
    return private_bytes(entries[sha]['_file'], pathlib.Path(packet.trial['ownerRoot']), LIMIT)


def run(identity):
    root = root_for(identity)
    trusted_root(root)
    attempt = root / 'attempt.json'
    result = root / 'result.json'
    with (root / 'launch.lock').open('a+b') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if has_execution_record(root):
            return inspect(identity)
        plan = read_json(root / 'plan.json', 2 * 1024 * 1024)
        kind = plan['request']['kind']
        reviewed = kind == 'reviewed_controller'
        try:
            packet = Packet((root / 'packet.tar.gz').read_bytes(), plan['request']['packetSha256'],
                            plan['profile'], privileged=reviewed)
            if reviewed:
                reviewed_preflight(root, plan, packet)
        except Refusal as error:
            outcome = {'status': 'failed', 'code': error.code, 'kind': kind, 'executionStarted': False,
                       'cleanupComplete': True, 'auditComplete': False}
            write_once(result, outcome)
            return {'phase': 'terminal', 'result': outcome}
        # The retained marker fences mutation and controller execution. Read-only
        # readiness refusals settle durably before the attempt is consumed.
        try:
            write_once(attempt, {'jobId': identity, 'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()})
        except FileExistsError:
            return inspect(identity)
    def cancelled(*_):
        raise InterruptedError('job_cancelled')
    previous = signal.signal(signal.SIGTERM, cancelled)
    try:
        outcome = (control_checks if plan['request']['kind'] == 'control_checks' else reviewed_controller)(root, plan, packet)
    except InterruptedError:
        outcome = controller_result(plan, packet, 130) if plan['request']['kind'] == 'reviewed_controller' else {
            'status': 'cancelled', 'kind': 'control_checks', 'cleanupComplete': True}
    except Refusal as error:
        unstarted = plan['request']['kind'] == 'reviewed_controller' and not (root / 'controller-started.json').exists()
        outcome = {'status': 'failed' if unstarted else 'unknown', 'code': error.code, 'kind': plan['request']['kind'],
                   'executionStarted': not unstarted, 'cleanupComplete': unstarted, 'auditComplete': unstarted}
    except Exception:
        # A launch or cleanup uncertainty must never become a clean failure
        # eligible for an automatic repeat of the same execution.
        outcome = {'status': 'unknown', 'code': 'remote_execution_unreconciled', 'kind': plan['request']['kind']}
    finally:
        signal.signal(signal.SIGTERM, previous)
    write_once(root / 'result.json', outcome)
    return {'phase': 'terminal', 'result': outcome}


def cancel(identity):
    root = root_for(identity)
    trusted_root(root)
    if (root / 'result.json').exists():
        return inspect(identity)
    # Terminate only the unit owned by this job. The controller owns its
    # cleanup; a forced or unconfirmed termination remains unknown.
    result = subprocess.run(['systemctl', 'stop', '--no-block', 'paperclip-runner-job-' + identity], capture_output=True, timeout=15)
    return {'cancellationRequested': result.returncode == 0}


if __name__ == '__main__':
    os.umask(0o077)
    require(os.getuid() == 0, 'operator_broker_required')
    operation = sys.argv[1]
    if operation == '--artifact':
        sys.stdout.buffer.write(artifact(sys.argv[2], sys.argv[3]))
        raise SystemExit(0)
    if operation == '--stage':
        result = stage(closed_json(sys.stdin.buffer.read(24 * 1024 * 1024 + 1)))
    elif operation == '--run':
        result = run(sys.argv[2])
    elif operation == '--readiness':
        result = readiness(sys.argv[2])
    elif operation == '--launch':
        result = launch(sys.argv[2])
    elif operation == '--inspect':
        result = inspect(sys.argv[2])
    elif operation == '--cancel':
        result = cancel(sys.argv[2])
    else:
        raise Refusal('remote_operation_refused')
    print(canonical(result).decode())
