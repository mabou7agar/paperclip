"""Load a fixed root-owned runner registration; no candidate configuration."""
import json
import os
from pathlib import Path
from urllib.parse import urlsplit
from domains import DomainPolicy
from requests import identity


CONFIG = Path('/etc/paperclip-ubuntu-preview.json')


def load(path=CONFIG, expected_owner=0):
    if path.is_symlink() or not path.is_file() or path.stat().st_uid != expected_owner or path.stat().st_mode & 0o022:
        raise ValueError('Runner configuration must be root-owned and not writable by agents.')
    if path.stat().st_size > 1024 * 1024:
        raise ValueError('Runner configuration is too large.')
    config = json.loads(path.read_text())
    for name in ['state_root', 'state_mount', 'routes_root', 'hosts_file', 'tls_public', 'gateway_binary']:
        if not isinstance(config[name], str) or not Path(config[name]).is_absolute():
            raise ValueError('Expected absolute runner configuration paths.')
    for name, minimum, maximum in [('port_min', 1024, 65535), ('port_max', 1024, 65535),
                                    ('lease_seconds', 1, 43200), ('starting_seconds', 1, 43200)]:
        if type(config[name]) is not int or not minimum <= config[name] <= maximum:
            raise ValueError('Invalid preview lifetime or port range.')
    if config['port_min'] > config['port_max'] or config['starting_seconds'] > config['lease_seconds']:
        raise ValueError('Invalid preview lifetime or port range.')
    address = urlsplit(config['guard_address'])
    if address.scheme != 'http' or address.hostname != '127.0.0.1' or not address.port or address.path or address.query or address.fragment or address.username:
        raise ValueError('The ownership guard must use an explicit loopback address.')
    for field in ['projects', 'principals']:
        if not isinstance(config[field], dict) or len(config[field]) > 1000:
            raise ValueError('Expected a bounded trusted runner registry.')
    for key, project in config['projects'].items():
        identity(key)
        identity(project['company_id'])
    for uid, principal in config['principals'].items():
        if not uid.isdigit() or int(uid) < 1:
            raise ValueError('Root cannot be an agent principal.')
        identity(principal['company_id'])
        roots = principal['workspace_roots']
        if not isinstance(roots, list) or not 1 <= len(roots) <= 32 or any(not isinstance(p, str) or not Path(p).is_absolute() or p == '/' for p in roots):
            raise ValueError('Expected registered workspace roots.')
    if len({p['company_id'] for p in config['principals'].values()}) > 1:
        raise ValueError('Companies require separate execution containers; loopback is shared.')
    DomainPolicy(config)
    return config


def secure_directories(config):
    for name in ['state_root', 'tls_public', 'routes_root']:
        path = Path(config[name])
        for parent in [path, *path.parents]:
            if parent.is_symlink():
                raise ValueError('Runner state must not use symlink paths.')
        if name == 'tls_public':
            path.mkdir(parents=True, exist_ok=True, mode=0o755)
        elif not path.is_dir():
            raise ValueError('The persistent state and watched proxy directory must already exist.')
        if path.stat().st_uid != os.geteuid() or path.stat().st_mode & 0o022:
            raise ValueError('Runner state is writable by an untrusted principal.')
        if name == 'state_root' and path.stat().st_mode & 0o077:
            raise ValueError('Paperclip state must be private to its operator.')
    mount = Path(config['state_mount'])
    if str(mount) == '/' or not mount.is_mount() or mount.is_symlink() or not Path(config['state_root']).is_relative_to(mount):
        raise ValueError('State must use the configured existing persistent mount, not the container root filesystem.')
    hosts = Path(config['hosts_file'])
    if hosts.is_symlink() or not hosts.is_file() or hosts.stat().st_uid != os.geteuid() or hosts.stat().st_mode & 0o022:
        raise ValueError('The hosts ledger must be an operator-owned regular file.')
