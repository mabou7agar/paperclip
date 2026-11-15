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
        packet = Packet(packet_bytes, plan['request']['packetSha256'], plan['profile'])
        root.mkdir(mode=0o700)
        packet_root = root / 'packet'
        packet_root.mkdir(mode=0o700)
        for name, raw in packet.files.items():
            target = packet_root / name
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            write_once(target, raw, raw=True)
        # Preserve the exact compressed input, not a re-packed substitute.
        write_once(root / 'packet.tar.gz', packet_bytes, raw=True)
        write_once(root / 'plan.json', {k: v for k, v in plan.items() if k != 'packet'})
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
    if (root / 'attempt.json').exists() and (not saved or saved.get('status') == 'unknown' or saved.get('cleanupComplete') is False):
        # Read-only reconciliation after an interrupted connection/process.
        # Never run a controller, test, cleanup script or new systemd unit here.
        unit = subprocess.run(['systemctl', 'show', '--property=SubState', '--value',
                               'paperclip-runner-job-' + identity], capture_output=True, timeout=10)
        if unit.returncode == 0 and unit.stdout.strip() in [b'exited', b'dead', b'failed']:
            plan = read_json(root / 'plan.json', 2 * 1024 * 1024)
            if plan['request']['kind'] == 'reviewed_controller':
                packet = Packet((root / 'packet.tar.gz').read_bytes(), plan['request']['packetSha256'], plan['profile'])
                current = controller_result(plan, packet, None)
                if current.get('cleanupComplete') and current.get('auditComplete'):
                    try: write_once(root / 'reconciled.json', current)
                    except FileExistsError: pass
                    return {'phase': 'terminal', 'result': read_json(root / 'reconciled.json')}
    if saved:
        return {'phase': 'terminal', 'result': saved}
    return {'phase': 'attempted' if (root / 'attempt.json').exists() else 'staged'}


def launch(identity):
    root = root_for(identity)
    trusted_root(root)
    with (root / 'launch.lock').open('a+b') as lock:
        os.chmod(lock.name, 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX)
        state = inspect(identity)
        if state['phase'] in ['terminal', 'attempted']:
            return state
        require((root / 'plan.json').is_file(), 'remote_plan_missing')
        # A retained unit name AND the exclusive attempt below prevent a late
        # or repeated launch RPC from executing the controller a second time.
        result = subprocess.run(['systemd-run', '--quiet', '--unit=paperclip-runner-job-' + identity,
                                 '--property=Type=oneshot', '--property=RemainAfterExit=yes',
                                 '--property=UMask=0077', '--property=RuntimeMaxSec=2400', '--property=TimeoutStopSec=660',
                                 sys.executable, '-I', '-B', str(INSTALL / 'remote_worker.py'), '--run', identity],
                                capture_output=True, timeout=20)
        if result.returncode:
            unit = subprocess.run(['systemctl', 'show', '--property=LoadState', '--value', 'paperclip-runner-job-' + identity],
                                  capture_output=True, timeout=10)
            require(unit.returncode == 0 and unit.stdout.strip() == b'loaded', 'remote_launch_unconfirmed')
        return {'phase': 'submitted'}


def control_checks(root, plan, packet):
    profile, request = plan['profile'], plan['request']
    name = 'paperclip-controls-' + plan['jobId']
    image = profile['preparedImage']
    require(image.startswith('sha256:') and len(image) == 71, 'control_image_not_pinned')
    require(request['recipe'] in packet.files and request['recipe'].endswith('-new.py'), 'control_recipe_missing')
    # No workspaces, secrets, Docker socket, production/database volumes or
    # network are mounted. Reuse the prepared image; never build an image.
    script = r'''import sys,pathlib,tempfile,tarfile,io,json,base64,hashlib,os,shutil
payload=json.load(sys.stdin);assert os.getuid()==payload['uid'];os.umask(0o077)
collector={};exec(base64.b64decode(payload['collector']),collector)
scratch=pathlib.Path(tempfile.mkdtemp(prefix='paperclip-controls-'));out={'uid':os.getuid(),'network':'none','workspaceMounts':0}
try:
 with tarfile.open(fileobj=io.BytesIO(base64.b64decode(payload['packet'],validate=True)))as archive:
  for m in archive.getmembers():
   p=pathlib.PurePosixPath(m.name);assert not p.is_absolute()and'..'not in p.parts and(m.isdir()or m.isfile())
   target=scratch/m.name
   if m.isdir():target.mkdir(parents=True,exist_ok=True)
   else:target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(archive.extractfile(m).read());target.chmod(0o600)
 env={'PATH':'/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin','HOME':str(scratch),'TMPDIR':str(scratch),'PYTHONDONTWRITEBYTECODE':'1'}
 r=collector['capture']([sys.executable,'-I','-B',str(scratch/payload['recipe']),str(scratch),str(payload['uid'])],cwd=scratch,env=env,timeout=120)
 out.update(exit=r['exit'],timedOut=r['timedOut'],stdoutBytes=r['stdout']['bytes'],stdoutSha256=r['stdout']['sha256'],stderrBytes=r['stderr']['bytes'],stderrSha256=r['stderr']['sha256'],overflow=r['stdout']['overflow']or r['stderr']['overflow'])
 if r['exit']==0 and not out['overflow']and not out['timedOut']:out['checks']=json.loads(r['stdout']['retained'])
finally:
 shutil.rmtree(scratch);out['scratchRemoved']=not scratch.exists()
print(json.dumps(out))
'''
    args = ['docker', 'run', '--name', name, '--network=none', '--read-only', '--cap-drop=ALL',
            '--security-opt=no-new-privileges', '--pids-limit=128', '--cpus=1', '--memory=512m',
            '--tmpfs=/tmp:rw,nosuid,nodev,mode=1777,size=268435456', '--user=' + str(profile['uid']) + ':' + str(profile['gid']),
            '--tmpfs=/workspace:rw,nosuid,nodev,mode=0700,size=1048576',
            '--tmpfs=/home:rw,nosuid,nodev,mode=0700,size=1048576',
            '--tmpfs=/root:rw,nosuid,nodev,mode=0700,size=1048576',
            '--tmpfs=/run:rw,nosuid,nodev,mode=0700,size=1048576', '--workdir=/tmp',
            '-i', '--entrypoint=/usr/bin/env', image, '-i',
            'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
            'HOME=/tmp', 'TMPDIR=/tmp', 'python3', '-I', '-B', '-c', script]
    try:
        result = capture(args, input_bytes=canonical({'uid': profile['uid'], 'recipe': request['recipe'],
                         'collector': base64.b64encode((INSTALL / 'bounded_process.py').read_bytes()).decode(),
                         'packet': base64.b64encode((root / 'packet.tar.gz').read_bytes()).decode()}), timeout=150)
        require(result['exit'] == 0 and not result['timedOut'] and
                not result['stdout']['overflow'] and not result['stderr']['overflow'], 'control_process_failed')
        raw = result['stdout']['retained']
        facts = closed_diagnostic(closed_json(raw))
        require(facts['uid'] == profile['uid'] and facts['network'] == 'none' and facts['scratchRemoved'] is True and facts['overflow'] is False and facts['timedOut'] is False,
                'control_boundary_failed')
        return {'status': 'passed' if facts['exit'] == 0 else 'failed', 'kind': 'control_checks',
                'recipeSha256': packet.file_sha(request['recipe']), 'facts': facts,
                'preparedImageSha256': image.removeprefix('sha256:'), 'containerRemoved': True}
    except Refusal as error:
        return {'status': 'failed', 'kind': 'control_checks', 'code': error.code, 'cleanupComplete': True}
    finally:
        stopped = subprocess.run(['docker', 'rm', '-f', name], capture_output=True, timeout=20)
        require(stopped.returncode == 0, 'control_cleanup_not_confirmed')


def reviewed_controller(root, plan, packet):
    trial = packet.trial
    owner = pathlib.Path(plan['profile']['authorityRoot'])
    trusted_root(owner)
    for name in ['ownerRoot', 'driverReceiptPath', 'runtimeReceiptRoot', 'externalAuthorityPath',
                 'preexecutionAdmissionPath', 'caseArchivePath']:
        require(not pathlib.Path(trial[name]).exists(), 'reviewed_attempt_already_exists')
    control = root / 'packet' / packet.directory / 'execute_qualification.py'
    preflight = capture([sys.executable, '-I', '-B', str(control), '--preflight-only'], timeout=40)
    require(preflight['exit'] == 0 and not preflight['timedOut'] and
            not preflight['stdout']['overflow'] and not preflight['stderr']['overflow'], 'reviewed_preflight_failed')
    # The independently verified native records are written once outside
    # Phase A. None is fabricated from a package's own asserted permission.
    write_once(pathlib.Path(trial['externalAuthorityPath']), plan['admission']['authority'])
    write_once(pathlib.Path(trial['preexecutionAdmissionPath']), plan['admission']['admission'])
    write_once(pathlib.Path(trial['caseArchivePath']), packet.files[packet.case_name], raw=True)
    result = capture([sys.executable, '-I', '-B', str(control)], timeout=2100, limit=1024 * 1024, grace=620)
    return controller_result(plan, packet, result['exit'])


def controller_result(plan, packet, exit_code):
    trial = packet.trial
    driver_path = pathlib.Path(trial['driverReceiptPath'])
    if not driver_path.exists():
        return {'status': 'unknown', 'kind': 'reviewed_controller', 'code': 'controller_receipt_missing', 'exit': exit_code}
    raw = driver_path.read_bytes()
    require(len(raw) <= 128 * 1024, 'controller_receipt_too_large')
    driver = closed_json(raw)
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
        expected = hashlib.sha256(canonical(plan['admission']['admission'])).hexdigest()
        require(value['caseAdmissionSha256'] == expected and value['candidate'] == plan['profile']['candidate'] and
                value['continuationId'] == trial['continuationId'], 'failure_receipt_binding_failed')
        try:
            outcome['diagnostic'] = closed_diagnostic(value['inner']['diagnostic'])
        except Refusal:
            outcome['diagnostic'] = {'status': 'diagnostic_unavailable', 'receipt': None}
    outcome['artifacts'] = descriptors(inventory(packet, driver))
    return outcome


def artifact(identity, sha):
    require(SHA.fullmatch(sha), 'artifact_digest_invalid')
    root = root_for(identity)
    trusted_root(root)
    plan = read_json(root / 'plan.json', 2 * 1024 * 1024)
    require(plan['request']['kind'] == 'reviewed_controller', 'artifact_kind_invalid')
    packet = Packet((root / 'packet.tar.gz').read_bytes(), plan['request']['packetSha256'], plan['profile'])
    driver = read_json(pathlib.Path(packet.trial['driverReceiptPath']))
    require(driver['wholePacketSha256'] == plan['request']['packetSha256'] and
            driver['continuationId'] == packet.trial['continuationId'], 'artifact_job_binding_changed')
    entries = inventory(packet, driver)
    require(sha in entries, 'artifact_not_manifest_approved')
    return private_bytes(entries[sha]['_file'], pathlib.Path(packet.trial['ownerRoot']), LIMIT)


def run(identity):
    root = root_for(identity)
    trusted_root(root)
    # This exclusive marker is the final defence against repeated systemd/SSH
    # dispatch. Never remove it, even if the controller never produced a result.
    try:
        write_once(root / 'attempt.json', {'jobId': identity, 'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()})
    except FileExistsError:
        return inspect(identity)
    plan = read_json(root / 'plan.json', 2 * 1024 * 1024)
    packet = Packet((root / 'packet.tar.gz').read_bytes(), plan['request']['packetSha256'], plan['profile'])
    def cancelled(*_):
        raise InterruptedError('job_cancelled')
    previous = signal.signal(signal.SIGTERM, cancelled)
    try:
        outcome = (control_checks if plan['request']['kind'] == 'control_checks' else reviewed_controller)(root, plan, packet)
    except InterruptedError:
        outcome = controller_result(plan, packet, 130) if plan['request']['kind'] == 'reviewed_controller' else {
            'status': 'cancelled', 'kind': 'control_checks', 'cleanupComplete': True}
    except Refusal as error:
        outcome = {'status': 'unknown', 'code': error.code, 'kind': plan['request']['kind']}
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
    result = subprocess.run(['systemctl', 'kill', '--kill-whom=main', '--signal=SIGTERM',
                             'paperclip-runner-job-' + identity], capture_output=True, timeout=15)
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
    elif operation == '--launch':
        result = launch(sys.argv[2])
    elif operation == '--inspect':
        result = inspect(sys.argv[2])
    elif operation == '--cancel':
        result = cancel(sys.argv[2])
    else:
        raise Refusal('remote_operation_refused')
    print(canonical(result).decode())
