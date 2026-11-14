#!/usr/bin/env python3
"""Operator installation inside an existing Ubuntu runner, without image rebuild."""
import argparse
import json
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--new-container', action='store_true')
    args = parser.parse_args()
    if os.getuid() != 0 or 'SUDO_UID' in os.environ:
        raise ValueError('Only the runner operator may install this integration.')
    source = Path(__file__).resolve().parent
    sys.path.insert(0, str(source / 'preview'))
    from configuration import load, secure_directories
    from repository import LeaseRepository
    from server import existing_guard, initialize
    config = load(args.config)
    secure_directories(config)
    # Current adapter targets a root-run file-provider gateway. Refuse to
    # install unreadable keys/routes for a different proxy security model.
    binary = Path(config['gateway_binary']).resolve(strict=True)
    if binary.stat().st_uid != 0 or binary.stat().st_mode & 0o022:
        raise ValueError('Gateway binary must be operator-owned.')
    proxies, nonroot_candidates = [], []
    for proc in Path('/proc').glob('[0-9]*'):
        try:
            argv = (proc / 'cmdline').read_bytes().split(b'\0')
            selected = ('--providers.file.directory=' + config['routes_root']).encode() in argv and any(
                x.startswith(('--entrypoints.' + config.get('tls_entrypoint', 'preview-tls') + '.address=').encode()) for x in argv)
            if not selected:
                continue
            uid = proc.stat().st_uid
            if uid != 0:
                # Diagnostic only. Non-root argv never grants or blocks authority
                # while a verified root gateway exists; proc/exe may be protected.
                nonroot_candidates.append(uid)
                continue
            if (proc / 'exe').resolve(strict=True) == binary and (proc / 'ns/net').readlink() == Path('/proc/self/ns/net').readlink():
                proxies.append(uid)
        except OSError:
            pass
    if not proxies:
        if nonroot_candidates:
            raise SystemExit('Configured gateway requires UID 0; no verified root gateway exists.')
        raise SystemExit('No matching configured root gateway exists.')
    repository = LeaseRepository(config['state_root'], config['routes_root'], config['hosts_file'])
    with repository.locked():
        if existing_guard(repository):
            raise ValueError('Stop the Paperclip guard before updating its installation.')
        # Without a live guard, no lease has routing authority. Revoke stale
        # state after a crash too, without restarting/stopping any application.
        for lease in repository.all():
            repository.remove(lease['id'])
    destination = Path('/opt/paperclip-ubuntu-runner')
    if destination.is_symlink():
        raise ValueError('Installation destination cannot be a symlink.')
    destination.mkdir(mode=0o755, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix='preview-stage-', dir=destination))
    stage.rmdir()
    shutil.copytree(source / 'preview', stage, ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
    previous = destination / 'preview-previous'
    if previous.exists():
        shutil.rmtree(previous)
    if (destination / 'preview').exists():
        (destination / 'preview').rename(previous)
    try:
        stage.rename(destination / 'preview')
    except Exception:
        if previous.exists():
            previous.rename(destination / 'preview')
        raise
    if previous.exists():
        shutil.rmtree(previous)
    for path in [destination, *destination.rglob('*')]:
        if path.is_symlink():
            raise ValueError('Installed code must not contain symlinks.')
        path.chmod(0o755 if path.is_dir() else 0o644)
    target = Path('/etc/paperclip-ubuntu-preview.json')
    if target.is_symlink():
        raise ValueError('Configuration destination cannot be a symlink.')
    target.write_text(json.dumps(config, indent=2) + '\n')
    target.chmod(0o600)
    initialize(config, repository)
    anchor = Path('/usr/local/share/ca-certificates/paperclip-ubuntu-preview.crt')
    authority = Path(config['state_root']) / 'tls/project-authority/ca.crt'
    if not anchor.exists() or anchor.read_bytes() != authority.read_bytes():
        anchor.write_bytes(authority.read_bytes())
        anchor.chmod(0o644)
        subprocess.run(['/usr/sbin/update-ca-certificates'], check=True, capture_output=True, timeout=45)
    # Node does not read Ubuntu's system store by default. Preserve all system
    # anchors, including previously installed local CAs, in this public bundle.
    public = Path(config['tls_public'])
    bundle = public / 'node-ca-bundle.crt'
    bundle.write_bytes(Path('/etc/ssl/certs/ca-certificates.crt').read_bytes())
    bundle.chmod(0o644)
    launcher = Path('/usr/local/bin/paperclip-preview')
    if launcher.is_symlink():
        raise ValueError('Client destination cannot be a symlink.')
    launcher.write_bytes((source / 'paperclip-preview').read_bytes())
    launcher.chmod(0o755)
    rule = '/usr/bin/python3 -E -s -B /opt/paperclip-ubuntu-runner/preview/command.py *'
    sudoers = Path('/etc/sudoers.d/paperclip-ubuntu-preview')
    text = ''.join('#' + uid + ' ALL=(root) NOPASSWD: ' + rule + '\n' for uid in config['principals'])
    temporary = sudoers.with_suffix('.tmp')
    temporary.write_text(text)
    temporary.chmod(0o440)
    subprocess.run(['/usr/sbin/visudo', '-cf', str(temporary)], check=True, capture_output=True, timeout=10)
    temporary.replace(sudoers)
    profile = Path('/etc/profile.d/paperclip-ubuntu-preview.sh')
    profile.write_text('export NODE_EXTRA_CA_CERTS=' + shlex.quote(str(bundle)) + '\n')
    profile.chmod(0o644)
    print(json.dumps({'installed': True, 'projects': len(config['projects']), 'principals': len(config['principals']),
                      'imageRebuilt': False, 'providerOrTaskCalls': 0}))


if __name__ == '__main__':
    main()
