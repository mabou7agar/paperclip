#!/usr/bin/env python3
"""Local forward-auth guard and lease expiry; never wakes Paperclip agents."""
import json
import os
import signal
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit
from configuration import load, secure_directories
from repository import LeaseRepository
from service import PreviewService
from processes import identity, matches


def initialize(config, repository):
    service = PreviewService(repository, config)
    with repository.locked():
        # A guard restart withdraws all old listener authority. It starts no app.
        for lease in repository.all():
            repository.remove(lease['id'])
        service.issuer.remove_orphans()
        service.issuer.initialize()
    return service


def existing_guard(repository, require_ready=False):
    path = repository.root / 'server.json'
    if not path.exists():
        return False
    record = json.loads(path.read_text())
    if not matches(record, {'uid': 0}) or (require_ready and record.get('ready') is not True):
        return False
    from pathlib import Path
    try:
        return b'/opt/paperclip-ubuntu-runner/preview/server.py' in (Path('/proc') / str(record['pid']) / 'cmdline').read_bytes().split(b'\0')
    except OSError:
        return False


def serve(config, repository, service, managed=False):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            valid = False
            try:
                mode, key = urlsplit(self.path).path.strip('/').split('/')
                valid = mode == 'authorize' and service.ready(key)
            except (ValueError, OSError, KeyError):
                pass
            body = json.dumps({'state': 'ready' if valid else 'unavailable'}).encode()
            self.send_response(200 if valid else 410)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_):
            pass

    def collect():
        while True:
            try:
                with repository.locked():
                    service.collect()
            except (OSError, ValueError):
                pass  # Request-time ownership/expiry checks remain fail-closed.
            time.sleep(5)

    threading.Thread(target=collect, daemon=True).start()
    address = urlsplit(config['guard_address'])
    http = ThreadingHTTPServer((address.hostname, address.port), Handler)
    if managed:
        with repository.locked():
            record = identity(os.getpid())
            record['ready'] = True
            LeaseRepository.atomic(repository.root / 'server.json', record)
    http.serve_forever()


if __name__ == '__main__':
    os.umask(0o077)
    if os.geteuid() != 0:
        raise SystemExit('Run the installed guard as the runner operator.')
    config = load()
    secure_directories(config)
    repository = LeaseRepository(config['state_root'], config['routes_root'], config['hosts_file'])
    with repository.locked():
        if existing_guard(repository):
            raise SystemExit('A Paperclip guard already owns this state.')
        LeaseRepository.atomic(repository.root / 'server.json', identity(os.getpid()))
    def stop(_signum, _frame):
        raise SystemExit(0)
    signal.signal(signal.SIGTERM, stop)
    try:
        serve(config, repository, initialize(config, repository), managed=True)
    finally:
        with repository.locked():
            for lease in repository.all():
                repository.remove(lease['id'])
            (repository.root / 'server.json').unlink(missing_ok=True)
