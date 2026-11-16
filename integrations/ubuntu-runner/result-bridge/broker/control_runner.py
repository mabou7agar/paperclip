"""Non-root disposable pure checks and owned orphan reconciliation."""
import base64
import pathlib
import subprocess
from bounded_process import capture
from contracts import canonical, closed_json, closed_diagnostic, digest, require, Refusal
from control_results import validated_result, preserve_completion, recover_completion
INSTALL = pathlib.Path('/opt/paperclip-ubuntu-runner-results')


def lookup_control(name):
    template = ('{"job":{{json (index .Config.Labels "paperclip.runner.job")}},'
                '"plan":{{json (index .Config.Labels "paperclip.runner.plan")}},'
                '"running":{{json .State.Running}},"exit":{{json .State.ExitCode}},'
                '"image":{{json .Image}},"user":{{json .Config.User}},'
                '"network":{{json .HostConfig.NetworkMode}},"readonly":{{json .HostConfig.ReadonlyRootfs}},'
                '"privileged":{{json .HostConfig.Privileged}},"mountCount":{{len .Mounts}},'
                '"capDrop":{{json .HostConfig.CapDrop}},"securityOpt":{{json .HostConfig.SecurityOpt}}}')
    result = subprocess.run(['docker', 'inspect', '--type=container', '--format', template, name], capture_output=True, timeout=15)
    if result.returncode == 0:
        require(len(result.stdout) <= 1024, 'control_identity_unavailable')
        return closed_json(result.stdout)
    # A healthy empty exact-name lookup proves absence. A daemon/transport
    # failure must never be confused with cleanup completion.
    present = subprocess.run(['docker', 'container', 'ls', '-a', '--filter', 'name=^/' + name + '$', '--format', '{{.ID}}'],
                             capture_output=True, timeout=15)
    require(present.returncode == 0 and not present.stdout.strip(), 'control_identity_unavailable')
    return None


def remove_owned_control(name, plan):
    current = lookup_control(name)
    if current is None:
        return
    require(current['job'] == plan['jobId'] and current['plan'] == digest(plan), 'control_identity_conflict')
    subprocess.run(['docker', 'rm', '-f', name], capture_output=True, timeout=20)
    require(lookup_control(name) is None, 'control_cleanup_not_confirmed')


def reconcile_control(root, plan, write_once):
    name = 'paperclip-controls-' + plan['jobId']
    current = lookup_control(name)
    # Preserve completion BEFORE cleanup. Old releases may have lost the return
    # value when finally raised, while the original stopped container kept it.
    completion = recover_completion(root, plan, current)
    if current is not None:
        try:
            write_once(root / 'orphan-cleanup-attempt.json', {'jobId': plan['jobId'], 'kind': 'owned_control_cleanup'})
        except FileExistsError:
            return {'status': 'unknown', 'kind': 'control_checks', 'code': 'control_cleanup_not_confirmed'}
        remove_owned_control(name, plan)
    if completion:
        return {**completion, 'cleanupComplete': True, 'containerRemoved': True,
                'recoveredCompletion': True, 'executionRepeated': False}
    return {'status': 'failed', 'kind': 'control_checks', 'code': 'control_unit_terminated',
            'cleanupComplete': True, 'auditComplete': False, 'executionStarted': True, 'testOutcome': 'unavailable'}


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
            '--security-opt=no-new-privileges', '--label=paperclip.runner.job=' + plan['jobId'],
            '--label=paperclip.runner.plan=' + digest(plan), '--pids-limit=128', '--cpus=1', '--memory=512m',
            '--tmpfs=/tmp:rw,nosuid,nodev,mode=1777,size=268435456', '--user=' + str(profile['uid']) + ':' + str(profile['gid']),
            '--tmpfs=/workspace:rw,nosuid,nodev,mode=0700,size=1048576',
            '--tmpfs=/home:rw,nosuid,nodev,mode=0700,size=1048576',
            '--tmpfs=/root:rw,nosuid,nodev,mode=0700,size=1048576',
            '--tmpfs=/run:rw,nosuid,nodev,mode=0700,size=1048576', '--workdir=/tmp',
            '-i', '--entrypoint=/usr/bin/env', image, '-i',
            'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
            'HOME=/tmp', 'TMPDIR=/tmp', 'python3', '-I', '-B', '-c', script]
    require(lookup_control(name) is None, 'control_name_already_owned')
    try:
        result = capture(args, input_bytes=canonical({'uid': profile['uid'], 'recipe': request['recipe'],
                         'collector': base64.b64encode((INSTALL / 'bounded_process.py').read_bytes()).decode(),
                         'packet': base64.b64encode((root / 'packet.tar.gz').read_bytes()).decode()}), timeout=150)
        require(result['exit'] == 0 and not result['timedOut'] and
                not result['stdout']['overflow'] and not result['stderr']['overflow'], 'control_process_failed')
        raw = result['stdout']['retained']
        value = validated_result(plan, packet, closed_json(raw))
        preserve_completion(root, plan, value)
        return {**value, 'cleanupComplete': True, 'containerRemoved': True}
    except Refusal as error:
        return {'status': 'failed', 'kind': 'control_checks', 'code': error.code, 'cleanupComplete': True}
    finally:
        remove_owned_control(name, plan)
