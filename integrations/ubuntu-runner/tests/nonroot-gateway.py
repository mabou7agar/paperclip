#!/usr/bin/env python3
"""Only the previously incomplete proxy-UID rejection; reuse the eight passed root cases."""
import json
import os
import pwd
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SOURCE / 'tests'))
from disposable import assert_disposable
assert_disposable()
env = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': '/root', 'LANG': 'C.UTF-8'}
try:
    actor = pwd.getpwuid(1001)
except KeyError:
    subprocess.run(['/usr/sbin/useradd', '-u', '1001', '-m', '-s', '/bin/bash', 'preview-1001'], check=True, capture_output=True)
    actor = pwd.getpwuid(1001)
workspace = Path('/preview-workspace'); workspace.mkdir(); os.chown(workspace, 1001, actor.pw_gid)
Path('/preview-state').chmod(0o755)
for name, mode in [('state', 0o700), ('routes', 0o755)]:
    Path('/preview-state', name).mkdir(mode=mode)
gateway = Path('/usr/local/libexec/paperclip-fixture-traefik')
gateway.parent.mkdir(parents=True, exist_ok=True); gateway.parent.chmod(0o755)
shutil.copyfile(shutil.which('traefik'), gateway); os.chown(gateway, 0, 0); gateway.chmod(0o555)
config = json.loads((SOURCE / 'example.json').read_text())
config.update(state_root='/preview-state/state', state_mount='/preview-state', routes_root='/preview-state/routes',
              gateway_binary=str(gateway), principals={}, projects={})
path = Path('/preview-state/operator.json'); path.write_text(json.dumps(config)); path.chmod(0o600)
with Path('/preview-state/nonroot-proxy.private.log').open('w') as log:
    proxy = subprocess.Popen([str(gateway), '--entrypoints.preview-tls.address=127.0.0.1:38443',
        '--providers.file.directory=/preview-state/routes', '--log.level=ERROR'],
        cwd=workspace, env={**env, 'HOME': actor.pw_dir}, user=1001, group=actor.pw_gid,
        extra_groups=[], stdout=log, stderr=log)
    try:
        deadline = time.monotonic() + 8
        while True:
            with socket.socket() as sock:
                if sock.connect_ex(('127.0.0.1', 38443)) == 0:
                    break
            assert proxy.poll() is None, 'Non-root proxy exited: ' + Path('/preview-state/nonroot-proxy.private.log').read_text()[-2000:]
            assert time.monotonic() < deadline, 'Non-root proxy readiness expired.'
            time.sleep(.1)
        result = subprocess.run(['/usr/bin/python3', '-E', '-s', '-B', str(SOURCE / 'install.py'), '--config', str(path)],
                                capture_output=True, text=True, env=env, timeout=20)
        assert result.returncode == 1 and 'Configured gateway requires UID 0' in result.stderr, result.stderr[-2000:]
        assert not Path('/opt/paperclip-ubuntu-runner').exists()
        print(json.dumps({'status': 'passed', 'case': 'nonroot-proxy-permission-model-rejected-explicitly',
                          'earlierRootCasesReexecuted': 0, 'applicationOrMcpTests': 0}))
    finally:
        proxy.terminate(); proxy.wait(timeout=5)
