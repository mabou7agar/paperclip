#!/usr/bin/env python3
"""One new targeted header-privacy check on a temporary local Traefik route."""
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'preview'))
from certificates import ProjectCertificates
from routing import internal_routes

assert sys.platform == 'linux' and os.getuid() != 0


def port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


seen = []
class Guard(BaseHTTPRequestHandler):
    def do_GET(self):
        seen.append({key: self.headers.get(key) for key in ['Cookie', 'Authorization', 'X-Forwarded-Host']})
        self.send_response(200); self.end_headers()
    def log_message(self, *_):
        pass


class Backend(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.end_headers(); self.wfile.write(b'OK')
    def log_message(self, *_):
        pass


servers, proxy = [], None
with tempfile.TemporaryDirectory(prefix='paperclip-forward-auth-') as temporary:
    root = Path(temporary)
    issuer = ProjectCertificates(root / 'state', root / 'public')
    issuer.initialize()
    key = 'a' * 32
    certificate, _ = issuer.issue(key, ['header-agent.test'])
    for handler in [Guard, Backend]:
        server = ThreadingHTTPServer(('127.0.0.1', 0), handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        servers.append(server)
    tls = port()
    routes = root / 'routes'; routes.mkdir()
    lease = {'id': key, 'private_hosts': {'app': 'header-agent.test'}, 'port': servers[1].server_port, 'certificate': certificate}
    (routes / 'route.yml').write_text(json.dumps(internal_routes(lease, {'guard_address': f'http://127.0.0.1:{servers[0].server_port}'})))
    try:
        proxy = subprocess.Popen(['traefik', f'--entrypoints.preview-tls.address=127.0.0.1:{tls}',
                                  '--providers.file.directory=' + str(routes), '--providers.providersthrottleduration=100ms',
                                  '--log.level=ERROR'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.monotonic() + 8
        while True:
            result = subprocess.run(['curl', '--disable', '--silent', '--show-error', '--fail', '--noproxy', '*',
                '--max-time', '1', '--cacert', str(root / 'public/ca-bundle.crt'), '--resolve', f'header-agent.test:{tls}:127.0.0.1',
                '-H', 'Authorization: Bearer synthetic-private-header', '-H', 'Cookie: syntheticPrivate=never-forward',
                f'https://header-agent.test:{tls}/'], capture_output=True, timeout=2)
            if result.returncode == 0:
                break
            assert time.monotonic() < deadline, 'Temporary proxy did not become ready.'
            time.sleep(.1)
        assert seen and all(x['Cookie'] is None and x['Authorization'] is None for x in seen)
        assert all(x['X-Forwarded-Host'] == f'header-agent.test:{tls}' for x in seen)
        print(json.dumps({'status': 'passed', 'checks': ['Cookie-not-forwarded', 'Authorization-not-forwarded',
                          'explicit-harmless-header-reaches-guard'], 'applicationOrMcpTests': 0}))
    finally:
        if proxy:
            proxy.terminate(); proxy.wait(timeout=5)
        for server in servers:
            server.shutdown(); server.server_close()
