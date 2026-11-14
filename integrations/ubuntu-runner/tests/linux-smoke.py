#!/usr/bin/env python3
"""New Linux-only gateway journey in temporary state, with no global DNS writes."""
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

root_source = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root_source / 'preview'))
from certificates import ProjectCertificates
from service import PreviewService
from processes import identity
from repository import LeaseRepository
from server import serve


def free_port(excluded):
    # Keep proxy listeners outside the application's allocated port range.
    for port in range(61000, 65000):
        if port in excluded:
            continue
        with socket.socket() as connection:
            try:
                connection.bind(('127.0.0.1', port))
                return port
            except OSError:
                continue
    raise AssertionError('No isolated smoke proxy port is free.')


def wait_for(probe, message):
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        if probe():
            return
        time.sleep(0.1)
    raise AssertionError(message)


def curl(host, port, authority, path='/', expected=200):
    result = subprocess.run(['curl', '--disable', '--noproxy', '*', '--silent', '--show-error', '--max-time', '2',
                             '--cacert', str(authority), '--resolve', f'{host}:{port}:127.0.0.1',
                             '-w', '\n%{http_code}', f'https://{host}:{port}{path}'],
                            capture_output=True, text=True, timeout=4)
    if result.returncode:
        return None
    body, status = result.stdout.rsplit('\n', 1)
    if int(status) != expected:
        return None
    return json.loads(body) if body else {}


def main():
    assert sys.platform == 'linux' and os.geteuid() != 0, 'Use an existing non-root runner user.'
    assert shutil.which('traefik'), 'Use the prepared runner; do not install tools for this smoke.'
    children, leases, checks = [], [], []

    def passed(case):
        checks.append(case)
        print(json.dumps({'event': 'case', 'case': case, 'status': 'passed'}), flush=True)

    with tempfile.TemporaryDirectory(prefix='paperclip-ubuntu-domains-') as temporary:
        root = Path(temporary).resolve()
        private_home = root / 'browser-home'
        private_home.mkdir(mode=0o700)
        for name in ['cache', 'config', 'run', 'tmp']:
            (private_home / name).mkdir(mode=0o700)
        state, public = root / 'state', root / 'public'
        state.mkdir(mode=0o700)
        (state / 'routes').mkdir(mode=0o700)
        public.mkdir()
        hosts = root / 'hosts'
        hosts.write_text('127.0.0.1 localhost\n192.0.2.1 unrelated.test\n')
        issuer = ProjectCertificates(state, public)
        issuer.initialize()
        authority = public / 'ca-bundle.crt'
        reserved = []
        for _ in range(3):
            reserved.append(free_port(reserved))
        proxy_http, proxy_tls, guard = reserved
        project_ids = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002']
        company = '00000000-0000-4000-8000-000000000003'
        workspace_root = root / 'workspaces'
        workspace_root.mkdir()
        config = {'state_root': str(state), 'routes_root': str(state / 'routes'), 'hosts_file': str(hosts),
                  'tls_public': str(public), 'domain_template': '{project}-agent.test',
                  'principals': {str(os.getuid()): {'company_id': company, 'workspace_roots': [str(workspace_root)]}},
                  'projects': {project_ids[0]: {'company_id': company, 'label': 'first'},
                               project_ids[1]: {'company_id': company, 'label': 'second', 'concurrent': True}},
                  'port_min': 30000, 'port_max': 60000, 'lease_seconds': 120, 'starting_seconds': 60,
                  'guard_address': f'http://127.0.0.1:{guard}'}
        repository = LeaseRepository(state, state / 'routes', hosts)
        controller = PreviewService(repository, config)
        threading.Thread(target=serve, args=(config, repository, controller), daemon=True).start()
        try:
            for number in [1, 2]:
                workspace = workspace_root / str(number)
                workspace.mkdir(parents=True)
                lease = controller.acquire({'id': str(number) * 32, 'projectId': project_ids[number-1],
                                            'workspace': str(workspace), 'aliases': ['tenant']}, os.getuid())
                leases.append(lease)
                backend = subprocess.Popen([sys.executable, '-u', '-c',
                    'from http.server import BaseHTTPRequestHandler,HTTPServer\n'
                    'import json,sys\n'
                    'class H(BaseHTTPRequestHandler):\n'
                    ' def do_GET(self):\n'
                    '  self.send_response(200);self.end_headers();self.wfile.write(json.dumps({"project":sys.argv[2],"host":self.headers["Host"],"proto":self.headers.get("X-Forwarded-Proto"),"cookie":self.headers.get("Cookie","")}).encode())\n'
                    ' def log_message(self,*args):pass\n'
                    'HTTPServer(("127.0.0.1",int(sys.argv[1])),H).serve_forever()\n',
                    str(lease['port']), str(number)], cwd=workspace, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                children.append(backend)

                def listening():
                    with socket.socket() as connection:
                        return connection.connect_ex(('127.0.0.1', lease['port'])) == 0

                wait_for(listening, 'Synthetic backend did not start.')
                controller.activate({'id': lease['id'], 'process': {k:v for k,v in identity(backend.pid).items() if k in ['pid','start_identity']}}, os.getuid())
                assert 'starting_expires_at' not in repository.read(lease['id'])
            with (root / 'proxy.log').open('w') as log:
                proxy = subprocess.Popen(['traefik', f'--entrypoints.preview.address=127.0.0.1:{proxy_http}',
                    f'--entrypoints.preview-tls.address=127.0.0.1:{proxy_tls}',
                    '--providers.file.directory=' + str(state / 'routes'), '--providers.file.watch=true',
                    '--providers.providersthrottleduration=100ms', '--log.level=ERROR'], stdout=log, stderr=log)
                children.append(proxy)
                wait_for(lambda: curl('first-agent.test', proxy_tls, authority), 'TLS gateway did not become ready.')
                for number, lease in enumerate(leases, 1):
                    for hostname in lease['private_hosts'].values():
                        data = curl(hostname, proxy_tls, authority)
                        assert data and data['project'] == str(number) and data['proto'] == 'https'
                    assert lease['private_hosts']['app'] in hosts.read_text()
                passed('two-projects-and-declared-tenants-over-verified-Traefik-HTTPS')
                assert 'unrelated.test' in hosts.read_text() and 'unknown.first-agent.test' not in hosts.read_text()
                assert curl('unknown.first-agent.test', proxy_tls, authority) is None
                passed('unknown-host-fails-TLS-and-unrelated-DNS-record-preserved')
                try:
                    controller.acquire({'id': '3' * 32, 'projectId': project_ids[0], 'workspace': leases[0]['workspace'], 'aliases': []}, os.getuid())
                    raise AssertionError('Stable hostname collision was admitted.')
                except ValueError as error:
                    assert 'occupied' in str(error)
                passed('collision-rejected-once-without-route-takeover')
                browser = root / 'browser.mjs'
                browser.write_text('''
import assert from 'node:assert/strict';
const {chromium}=await import(process.env.PAPERCLIP_PREVIEW_PLAYWRIGHT);
const [url,pin,otherUrl,otherPin]=process.argv.slice(2);
const resolver=[url,otherUrl].map(value=>`MAP ${new URL(value).hostname} 127.0.0.1`).join(', ');
for (const trusted of [true,false]) {
 const browser=await chromium.launch({headless:true,args:['--no-sandbox','--no-proxy-server',`--host-resolver-rules=${resolver}`,...(trusted?[`--ignore-certificate-errors-spki-list=${pin},${otherPin}`]:[])]});
 try {
  const page=await browser.newPage(); let failure;
  const response=await page.goto(url,{timeout:10000}).catch(e=>{failure=e;return null;});
  if(trusted){
   assert.equal(failure,undefined);assert.equal(response.status(),200);assert.equal(JSON.parse(await page.locator('body').innerText()).project,'1');
   await page.evaluate(()=>{document.cookie='sameProjectCookie=positive;Path=/;Secure';});
   await page.reload();assert.ok(JSON.parse(await page.locator('body').innerText()).cookie.includes('sameProjectCookie=positive'));
   await page.goto(otherUrl,{timeout:10000});assert.equal(JSON.parse(await page.locator('body').innerText()).project,'2');
   await page.evaluate(()=>{document.cookie='crossProjectCookie=bad;Domain=first-agent.test;Path=/';document.cookie='parentCookie=bad;Domain=test;Path=/';});
   await page.goto(url,{timeout:10000});const body=JSON.parse(await page.locator('body').innerText());
   assert.ok(!body.cookie.includes('crossProjectCookie') && !body.cookie.includes('parentCookie'));
  }
  else assert.ok(failure && /ERR_CERT/.test(failure.message));
 } finally {await browser.close();}
}
console.log('PASS exact-leaf Chromium trust; unknown CA rejected');
''')
                result = subprocess.run(['node', str(browser), f'https://first-agent.test:{proxy_tls}/', leases[0]['tls_spki'],
                    f"https://{leases[1]['private_hosts']['app']}:{proxy_tls}/", leases[1]['tls_spki']],
                    env={'PATH': os.environ.get('PATH', '/usr/local/bin:/usr/bin:/bin'), 'HOME': str(private_home),
                         'XDG_CACHE_HOME': str(private_home / 'cache'), 'XDG_CONFIG_HOME': str(private_home / 'config'),
                         'XDG_RUNTIME_DIR': str(private_home / 'run'), 'TMPDIR': str(private_home / 'tmp'),
                         'LANG': 'C.UTF-8', 'PLAYWRIGHT_BROWSERS_PATH': '/opt/ms-playwright',
                         'PAPERCLIP_PREVIEW_PLAYWRIGHT': os.environ['PAPERCLIP_PREVIEW_PLAYWRIGHT']},
                    capture_output=True, text=True, timeout=30)
                assert result.returncode == 0, 'Isolated Chromium trust check failed: ' + result.stderr[-1500:]
                passed('real-Chromium-exact-leaf-pin-and-untrusted-CA-rejection')
                passed('cross-project-cookie-scope-isolation')
                old_key = leases[0]['id']
                controller.release(old_key, os.getuid())
                wait_for(lambda: not controller.ready(old_key), 'Revoked lease stayed authorized.')
                wait_for(lambda: curl('first-agent.test', proxy_tls, authority) is None, 'Traefik still serves a revoked project.')
                assert not (state / 'tls/project-leases' / old_key).exists()
                assert 'first-agent.test' not in hosts.read_text()
                assert curl(leases[1]['private_hosts']['app'], proxy_tls, authority)['project'] == '2'
                passed('release-removes-only-owned-leaf-and-other-project-still-serves')
        finally:
            cleanup_errors = []
            for lease in leases:
                try:
                    controller.release(lease['id'], os.getuid())
                except Exception as error:
                    cleanup_errors.append(type(error).__name__)
            for child in reversed(children):
                if child.poll() is None:
                    child.terminate()
            for child in children:
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(timeout=5)
            print(json.dumps({'event': 'cleanup', 'errors': cleanup_errors,
                              'childExitCodes': [child.returncode for child in children],
                              'remainingLeaseFiles': len(list((state / 'leases').glob('*.json'))),
                              'remainingLeafDirectories': len(list((state / 'tls/project-leases').iterdir()))}), flush=True)
            assert not cleanup_errors, 'Synthetic lease cleanup failed: ' + ','.join(cleanup_errors)
        assert not repository.all() and not list((state / 'tls/project-leases').iterdir())
        print(json.dumps({'status': 'passed', 'checks': checks, 'uid': os.getuid(),
                          'cleanup': {'leases': 0, 'leafKeys': 0, 'childExitCodes': [c.returncode for c in children]},
                          'dnsScope': 'isolated hosts ledger plus explicit client resolution; global host DNS unchanged',
                          'applicationOrMcpTests': 0}))


if __name__ == '__main__':
    main()
