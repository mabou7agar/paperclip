#!/usr/bin/env python3
"""Small sudo boundary. Candidate input selects registered previews, never code."""
import json
import os
import sys
from configuration import load, secure_directories
from repository import LeaseRepository
from service import PreviewService
from server import existing_guard


def main():
    os.umask(0o077)
    if os.geteuid() != 0:
        raise ValueError('Use the installed Paperclip preview command.')
    caller = os.environ.get('SUDO_UID', '')
    if not caller.isdigit() or int(caller) < 1:
        raise ValueError('A non-root runner principal is required.')
    if len(sys.argv) != 2 or sys.argv[1] not in ['acquire', 'activate', 'release', 'read']:
        raise ValueError('Unsupported preview operation.')
    raw = sys.stdin.buffer.read(8193)
    if len(raw) > 8192:
        raise ValueError('Preview request is too large.')
    data = json.loads(raw)
    config = load()
    secure_directories(config)
    if caller not in config['principals']:
        raise ValueError('Caller is not registered on this runner.')
    repository = LeaseRepository(config['state_root'], config['routes_root'], config['hosts_file'])
    service = PreviewService(repository, config, admission_guard=lambda: existing_guard(repository, require_ready=True))
    action, uid = sys.argv[1], int(caller)
    if action == 'acquire':
        result = service.acquire(data, uid)
    elif action == 'activate':
        result = service.activate(data, uid)
    else:
        if not isinstance(data, dict) or set(data) != {'id'}:
            raise ValueError('Expected a preview identity.')
        if action == 'release':
            result = service.release(data['id'], uid)
        else:
            with repository.locked():
                service.collect()
                lease = service.owned(data['id'], uid)
                result = service.public(lease) if lease else {'id': data['id'], 'state': 'expired'}
    print(json.dumps(result))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print(json.dumps({'error': 'Preview operation rejected; inspect the registered project, ownership and lease state.'}))
        sys.exit(1)
