#!/usr/bin/env python3
"""Host-supervisor state transitions with a fake Docker CLI, inside the disposable fixture."""
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

source = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(source / 'tests'))
from disposable import assert_disposable
assert_disposable()
target = Path('/opt/paperclip-ubuntu-runner-integration')
shutil.copytree(source, target, ignore=shutil.ignore_patterns('__pycache__', 'node_modules', '.e2e'))
config = Path('/etc/paperclip-ubuntu-runner/config.json')
config.parent.mkdir(mode=0o700)
config.write_text('{}')
with tempfile.TemporaryDirectory(prefix='paperclip-supervisor-fixture-') as tmp:
    root = Path(tmp)
    docker = root / 'docker'
    clock = root / 'clock'
    log = root / 'calls'
    clock.write_text('2026-01-01T00:00:00Z')
    docker.write_text('''#!/usr/bin/python3
import json,os,pathlib,sys
r=pathlib.Path(os.environ['FAKE_DOCKER_ROOT']);args=sys.argv[1:]
with(r/'calls').open('a')as f:f.write(json.dumps(args)+'\\n')
if args[:2]==['inspect','--format']:
 print((r/'clock').read_text()if args[2]=='{{.State.StartedAt}}'else'true')
elif args[:3]==['exec','prepared-fixture','mktemp']:
 print('/opt/paperclip-preview-install.FIXTURE01')
''')
    docker.chmod(0o755)
    env = {'PATH': str(root) + ':/usr/bin:/bin', 'HOME': '/root', 'FAKE_DOCKER_ROOT': str(root),
           'PAPERCLIP_UBUNTU_CONTAINER': 'prepared-fixture'}
    def run():
        subprocess.run(['sh', str(target / 'supervise.sh')], env=env, capture_output=True, check=True, timeout=10)
    run()
    run()
    calls = [json.loads(x) for x in log.read_text().splitlines()]
    installs = [x for x in calls if any(y.endswith('/install.py') for y in x)]
    assert len(installs) == 1 and '--new-container' not in installs[0]
    clock.write_text('2026-01-01T01:00:00Z')
    run()
    calls = [json.loads(x) for x in log.read_text().splitlines()]
    installs = [x for x in calls if any(y.endswith('/install.py') for y in x)]
    assert len(installs) == 2 and '--new-container' in installs[-1]
    assert all('restart' not in x and 'build' not in x and 'run' not in x for x in calls)
    print(json.dumps({'status': 'passed', 'checks': ['same-binding-skips-install', 'new-Docker-start-reinstalls-once',
          'no-build-container-restart-or-job-admission'], 'docker': 'fake CLI, not a live Docker lifecycle test'}))
