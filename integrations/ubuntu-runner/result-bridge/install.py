"""Install an exact reviewed release, without building or restarting containers.

The caller independently pins release-manifest.json's digest after review.
Native plugin registration, private profiles, restricted SSH authorization and
compose mounts are explicit operator configuration, not candidate permissions.
"""
import hashlib
import json
import os
import pathlib
import shutil
import stat
import sys


def install(source, expected, role):
    assert os.getuid() == 0 and role in ['broker', 'execution']
    source = pathlib.Path(source)
    manifest_path = source / 'release-manifest.json'
    assert not manifest_path.is_symlink() and manifest_path.stat().st_size < 32768
    raw = manifest_path.read_bytes()
    assert hashlib.sha256(raw).hexdigest() == expected, 'Release identity changed'
    manifest = json.loads(raw)
    assert 1 <= len(manifest) <= 64
    verified = {}
    total = 0
    for name, sha in manifest.items():
        path = pathlib.PurePosixPath(name)
        assert not path.is_absolute() and '..' not in path.parts and len(sha) == 64
        file = source / path
        assert file.is_file() and not file.is_symlink() and file.stat().st_size <= 16 * 1024 * 1024
        verified[name] = file.read_bytes()
        total += len(verified[name])
        assert total <= 32 * 1024 * 1024
        assert hashlib.sha256(verified[name]).hexdigest() == sha, 'Release bytes changed'
    target = pathlib.Path('/opt/paperclip-ubuntu-runner-results')
    if target.exists():
        for parent in [target, *target.parents]:
            st = parent.lstat()
            assert not parent.is_symlink() and st.st_uid == 0 and not st.st_mode & 0o022
    else:
        target.mkdir(mode=0o755)
    for name in manifest:
        if name.startswith('broker/'):
            destination = target / pathlib.PurePosixPath(name).name
        elif role == 'broker' and name.startswith('plugin/'):
            destination = target / name
        else:
            continue
        destination.parent.mkdir(mode=0o755, exist_ok=True)
        assert not destination.is_symlink()
        temporary = destination.with_name(destination.name + '.new')
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
        with os.fdopen(fd, 'wb') as handle:
            handle.write(verified[name]);handle.flush();os.fsync(handle.fileno())
        os.replace(temporary, destination)
    state = pathlib.Path('/var/lib/paperclip-ubuntu-runner-results')
    state.mkdir(mode=0o700, exist_ok=True)
    assert not state.is_symlink() and state.stat().st_uid == 0 and stat.S_IMODE(state.stat().st_mode) == 0o700
    if role == 'broker':
        unit = pathlib.Path('/etc/systemd/system/paperclip-runner-results.service')
        assert not unit.is_symlink()
        unit.write_bytes(verified['paperclip-runner-results.service'])
        unit.chmod(0o644)
    (target / 'installed-release.json').write_text(json.dumps({'manifestSha256': expected, 'role': role}))
    print(json.dumps({'installed': True, 'role': role, 'manifestSha256': expected, 'containersBuiltOrRestarted': 0}))


if __name__ == '__main__':
    os.umask(0o077)
    assert len(sys.argv) == 4
    install(*sys.argv[1:])
