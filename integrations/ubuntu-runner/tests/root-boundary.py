#!/usr/bin/env python3
"""Run ONLY in a disposable network-none container from the prepared image.

Requires an explicit operator marker and a dedicated /preview-state tmpfs.
Never run in the actual execution container: this fixture changes /etc and UIDs.
"""
import hashlib
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
sys.path.insert(0, str(SOURCE / 'preview'))
from processes import identity

ENV = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': '/root', 'LANG': 'C.UTF-8'}
PROJECT = '00000000-0000-4000-8000-000000000001'
COMPANY = '00000000-0000-4000-8000-000000000002'
children, checks = [], []


def command(args, data=None, expected=0):
    p = subprocess.run(args, input=data, capture_output=True, text=True, env=ENV, timeout=60)
    if p.returncode != expected:
        # This fixture has synthetic state only. Keep failed installer diagnostics
        # rather than deleting the only cause with the disposable container.
        print(json.dumps({'event': 'failed-command', 'command': args[:5],
                          'stdout': p.stdout[-1000:], 'stderr': p.stderr[-4000:]}), file=sys.stderr, flush=True)
    assert p.returncode == expected, 'Boundary command failed: ' + str(args[:2]) + ' exit=' + str(p.returncode)
    return p


def wait(probe):
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        if probe():
            return
        time.sleep(.1)
    raise AssertionError('Bounded readiness check expired.')


def passed(name):
    checks.append(name)
    print(json.dumps({'event': 'passed', 'case': name}), flush=True)


def client(action, data, success=True, uid=1001):
    p = subprocess.run(['sudo', '-n', '-u', '#' + str(uid), 'env', '-i',
                        'PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/nonexistent',
                        'paperclip-preview', action], input=json.dumps(data), capture_output=True,
                       text=True, env=ENV, timeout=15)
    assert (p.returncode == 0) == success, 'Unexpected sudo boundary outcome.'
    if success:
        return json.loads(p.stdout)
    assert 'Traceback' not in p.stderr
    return None


def spawn(args, **kwargs):
    environment = kwargs.pop('env', ENV)
    child = subprocess.Popen(args, env=environment, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **kwargs)
    children.append(child)
    return child


def guard():
    child = spawn(['/usr/bin/python3', '-E', '-s', '-B', '/opt/paperclip-ubuntu-runner/preview/server.py'])
    wait(lambda: child.poll() is None and Path('/preview-state/state/server.json').exists()
         and json.loads(Path('/preview-state/state/server.json').read_text()).get('ready') is True
         and json.loads(Path('/preview-state/state/server.json').read_text()).get('pid') == child.pid)
    return child


def request(key):
    return {'id': key * 32, 'projectId': PROJECT, 'workspace': '/preview-workspace', 'aliases': ['tenant']}


try:
    for uid in [1001, 1002]:
        try:
            pwd.getpwuid(uid)
        except KeyError:
            command(['/usr/sbin/useradd', '-u', str(uid), '-m', '-s', '/bin/bash', 'preview-' + str(uid)])
    workspace = Path('/preview-workspace')
    workspace.mkdir(mode=0o755)
    os.chown(workspace, 1001, pwd.getpwuid(1001).pw_gid)
    for directory in ['state', 'routes']:
        Path('/preview-state', directory).mkdir(mode=0o700)
    # Use an operator-owned copy of the prepared gateway. Some prepared images
    # keep the tool download owned by their build UID; do not weaken the real
    # installer's executable-owner check to accommodate that fixture metadata.
    prepared_gateway = Path(shutil.which('traefik'))
    gateway = Path('/usr/local/libexec/paperclip-fixture-traefik')
    gateway.parent.mkdir(parents=True, exist_ok=True)
    gateway.parent.chmod(0o755)
    shutil.copyfile(prepared_gateway, gateway); os.chown(gateway, 0, 0); gateway.chmod(0o555)
    assert hashlib.sha256(gateway.read_bytes()).digest() == hashlib.sha256(prepared_gateway.read_bytes()).digest()
    proxy = spawn([str(gateway), '--entrypoints.preview-tls.address=127.0.0.1:38443',
                   '--providers.file.directory=/preview-state/routes', '--providers.file.watch=true',
                   '--providers.providersthrottleduration=100ms', '--log.level=ERROR'])
    config = json.loads((SOURCE / 'example.json').read_text())
    config.update(state_root='/preview-state/state', state_mount='/preview-state', routes_root='/preview-state/routes',
                  gateway_binary=str(gateway),
                  guard_address='http://127.0.0.1:39888', port_min=39000, port_max=39100,
                  principals={'1001': {'company_id': COMPANY, 'workspace_roots': ['/preview-workspace']}},
                  projects={PROJECT: {'company_id': COMPANY, 'label': 'boundary'}})
    operator = Path('/preview-state/operator.json')
    operator.write_text(json.dumps(config)); operator.chmod(0o600)
    install = ['/usr/bin/python3', '-E', '-s', '-B', str(SOURCE / 'install.py'), '--config', str(operator)]
    wait(lambda: proxy.poll() is None)
    command(install)
    passed('real-installer-and-visudo-registration')
    ca = Path('/preview-state/state/tls/project-authority/ca.crt')
    ca_before = hashlib.sha256(ca.read_bytes()).hexdigest()
    client('acquire', request('1'), success=False)
    active_guard = guard()
    client('acquire', request('1'), success=False, uid=1002)
    lease = client('acquire', request('1'))
    passed('sudo-nonroot-command-and-unregistered-principal-rejection')
    actor = pwd.getpwuid(1001)
    backend = spawn(['/usr/bin/python3', '-m', 'http.server', str(lease['port']), '--bind', '127.0.0.1'],
                    cwd=workspace, user=1001, group=actor.pw_gid, extra_groups=[])
    def listening(port):
        with socket.socket() as s:
            return s.connect_ex(('127.0.0.1', port)) == 0
    wait(lambda: listening(lease['port']))
    process = {k: v for k, v in identity(backend.pid).items() if k in ['pid', 'start_identity']}
    client('activate', {'id': lease['id'], 'process': process})
    wait(lambda: subprocess.run(['curl', '--disable', '--noproxy', '*', '--silent', '--fail',
        '--max-time', '1', '--cacert', str(ca), '--resolve', 'boundary-agent.test:38443:127.0.0.1',
        'https://boundary-agent.test:38443/'], capture_output=True).returncode == 0)
    passed('root-to-agent-listener-child-and-real-root-proxy-TLS')
    command(install, expected=1)
    passed('running-guard-upgrade-rejected-before-copy')
    active_guard.kill(); active_guard.wait(timeout=5)
    client('acquire', request('2'), success=False)
    command(install)
    assert not list(Path('/preview-state/state/leases').glob('*.json'))
    assert backend.poll() is None
    assert hashlib.sha256(ca.read_bytes()).hexdigest() == ca_before
    passed('crash-upgrade-revokes-stale-leases-without-app-stop-or-CA-rotation')
    active_guard = guard()
    ipv6 = client('acquire', request('3'))
    script = 'import http.server,socket,sys\nclass V(http.server.HTTPServer):address_family=socket.AF_INET6\nV(("::1",int(sys.argv[1])),http.server.SimpleHTTPRequestHandler).serve_forever()'
    ipv6_backend = spawn(['/usr/bin/python3', '-c', script, str(ipv6['port'])], cwd=workspace,
                         user=1001, group=actor.pw_gid, extra_groups=[])
    def ipv6_listening():
        with socket.socket(socket.AF_INET6) as s:
            return s.connect_ex(('::1', ipv6['port'])) == 0
    wait(ipv6_listening)
    record = {k: v for k, v in identity(ipv6_backend.pid).items() if k in ['pid', 'start_identity']}
    client('activate', {'id': ipv6['id'], 'process': record}, success=False)
    passed('IPv6-only-listener-rejected-before-IPv4-proxy-publication')
    command(['/usr/bin/python3', '-E', '-s', '-B', '/opt/paperclip-ubuntu-runner/preview/stop.py'])
    active_guard.wait(timeout=5)
    client('acquire', request('4'), success=False)
    assert backend.poll() is None and ipv6_backend.poll() is None
    passed('real-stop-and-maintenance-window-do-not-stop-apps-or-admit-work')
    Path('/opt/paperclip-ubuntu-runner/preview/retired.py').write_text('removed implementation')
    command(install)
    assert not Path('/opt/paperclip-ubuntu-runner/preview/retired.py').exists()
    passed('upgrade-removes-retired-code-and-keeps-private-authority')
    proxy.terminate(); proxy.wait(timeout=5)
    Path('/preview-state').chmod(0o755)
    Path('/preview-state/routes').chmod(0o755)
    nonroot_proxy = spawn([str(gateway), '--entrypoints.preview-tls.address=127.0.0.1:38443',
                           '--providers.file.directory=/preview-state/routes', '--log.level=ERROR'],
                          user=1001, group=actor.pw_gid, extra_groups=[], cwd=workspace, env={**ENV, 'HOME': actor.pw_dir})
    wait(lambda: listening(38443))
    rejection = command(install, expected=1)
    assert 'Configured gateway requires UID 0' in rejection.stderr
    passed('nonroot-proxy-permission-model-rejected-explicitly')
    print(json.dumps({'status': 'passed', 'checks': checks, 'candidateTests': 0, 'providerCalls': 0,
                      'rootScope': 'disposable network-none container only', 'caPreserved': True}), flush=True)
finally:
    for child in reversed(children):
        if child.poll() is None:
            child.terminate()
    for child in children:
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill(); child.wait(timeout=5)
