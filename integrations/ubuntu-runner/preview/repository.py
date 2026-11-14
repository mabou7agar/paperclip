"""Root-owned Paperclip leases and persistent origin ownership."""
import contextlib
import fcntl
import json
import os
import shutil
import sqlite3
from pathlib import Path
from requests import lease_key


class LeaseRepository:
    def __init__(self, root, routes, hosts):
        self.root, self.routes, self.hosts = Path(root), Path(routes), Path(hosts)
        if not self.root.is_dir() or not self.routes.is_dir():
            raise ValueError('Pre-provision the persistent state and watched routes directory.')
        (self.root / 'leases').mkdir(exist_ok=True, mode=0o700)

    @contextlib.contextmanager
    def locked(self):
        with (self.root / 'lock').open('a') as handle:
            fcntl.flock(handle, fcntl.LOCK_EX)
            yield

    def read(self, key):
        path = self.root / 'leases' / (lease_key(key) + '.json')
        return json.loads(path.read_text()) if path.exists() else None

    def all(self):
        return [json.loads(p.read_text()) for p in (self.root / 'leases').glob('*.json')]

    @staticmethod
    def atomic(path, value):
        temporary = path.with_suffix('.tmp')
        with temporary.open('w') as handle:
            json.dump(value, handle)
            handle.flush()
            os.fsync(handle.fileno())
        temporary.chmod(0o600)
        temporary.replace(path)

    def write(self, lease):
        self.atomic(self.root / 'leases' / (lease_key(lease['id']) + '.json'), lease)

    def publish(self, lease, route):
        self.atomic(self.routes / ('paperclip-' + lease_key(lease['id']) + '.yml'), route)

    def reserve_origin(self, host, company, project, uid, key):
        with contextlib.closing(sqlite3.connect(self.root / 'origins.sqlite')) as db:
            (self.root / 'origins.sqlite').chmod(0o600)
            with db:
                db.execute('CREATE TABLE IF NOT EXISTS origins (host TEXT PRIMARY KEY, company TEXT NOT NULL, project TEXT NOT NULL, uid INTEGER NOT NULL)')
                db.execute('CREATE TABLE IF NOT EXISTS attempts (id TEXT PRIMARY KEY)')
                if db.execute('SELECT 1 FROM attempts WHERE id=?', (lease_key(key),)).fetchone():
                    raise ValueError('Preview identities cannot be replayed, including released or failed leases.')
                owner = db.execute('SELECT company,project,uid FROM origins WHERE host=?', (host,)).fetchone()
                if owner and owner != (company, project, uid):
                    raise ValueError('Origin belongs to another registered principal or project.')
                db.execute('INSERT OR IGNORE INTO origins VALUES (?,?,?,?)', (host, company, project, uid))
                db.execute('INSERT INTO attempts VALUES (?)', (key,))

    def remove(self, key):
        key = lease_key(key)
        # Revoke authorization before withdrawing proxy configuration.
        (self.root / 'leases' / (key + '.json')).unlink(missing_ok=True)
        (self.routes / ('paperclip-' + key + '.yml')).unlink(missing_ok=True)
        try:
            self.sync_hosts()
        finally:
            shutil.rmtree(self.root / 'tls' / 'project-leases' / key, ignore_errors=True)

    def sync_hosts(self):
        marker = '# paperclip-ubuntu-preview:'
        # Container /etc/hosts cannot be replaced by rename. Cooperating writers
        # share its inode lock. Never truncate before the complete single write.
        with self.hosts.open('r+b', buffering=0) as handle:
            fcntl.flock(handle, fcntl.LOCK_EX)
            original = handle.read()
            lines = [line for line in original.decode().splitlines() if marker not in line]
            for lease in self.all():
                lines.append('127.0.0.1 ' + ' '.join(lease['private_hosts'].values()) + ' ' + marker + lease['id'])
            data = ('\n'.join(lines) + '\n').encode()
            handle.seek(0)
            if handle.read() != original:
                raise ValueError('Hosts changed concurrently; reconcile instead of overwriting.')
            if os.pwrite(handle.fileno(), data, 0) != len(data):
                raise OSError('Incomplete hosts update.')
            handle.truncate(len(data))
            os.fsync(handle.fileno())
            handle.seek(0)
            if handle.read() != data:
                raise ValueError('Hosts update conflicted with another writer.')
