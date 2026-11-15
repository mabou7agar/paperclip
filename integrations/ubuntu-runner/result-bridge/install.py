"""Install an exact reviewed code release. No container build/start/restart.

Checks are explicit and remain active under python -O. Deployment must stop the
broker and wait for existing execution units before installing code. The input
manifest digest is independently pinned after review.
"""
import hashlib
import json
import os
import pathlib
import stat
import sys


INSTALL_ROOT = pathlib.Path('/opt/paperclip-ubuntu-runner-results')
STATE_ROOT = pathlib.Path('/var/lib/paperclip-ubuntu-runner-results')
SYSTEMD_ROOT = pathlib.Path('/etc/systemd/system')


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def trusted(path):
    st = path.lstat()
    require(not path.is_symlink() and st.st_uid == 0 and (not st.st_mode & 0o022 or (stat.S_ISDIR(st.st_mode) and st.st_mode & stat.S_ISVTX)), 'Untrusted operator path')
    return st


def install(source, expected, role):
    require(os.getuid() == 0 and role in ['broker', 'execution'], 'Root operator and known role required')
    source = pathlib.Path(source)
    for parent in [source, *source.parents]:
        st = trusted(parent)
        if st.st_mode & 0o022:
            require(st.st_mode & stat.S_ISVTX, 'Non-sticky writable source ancestor')
    manifest_path = source / 'release-manifest.json'
    require(stat.S_ISREG(trusted(manifest_path).st_mode) and manifest_path.stat().st_size < 32768, 'Untrusted release manifest')
    raw = manifest_path.read_bytes()
    require(hashlib.sha256(raw).hexdigest() == expected, 'Release identity changed')
    manifest = json.loads(raw)
    require(isinstance(manifest, dict) and 1 <= len(manifest) <= 64, 'Release inventory invalid')
    verified = {}
    total = 0
    for name, sha in manifest.items():
        path = pathlib.PurePosixPath(name)
        require(not path.is_absolute() and '..' not in path.parts and isinstance(sha, str) and len(sha) == 64, 'Release name invalid')
        file = source / path
        for parent in file.parents:
            trusted(parent)
            if parent == source: break
        require(stat.S_ISREG(trusted(file).st_mode) and file.stat().st_size <= 16 * 1024 * 1024, 'Release file invalid')
        verified[name] = file.read_bytes()
        total += len(verified[name])
        require(total <= 32 * 1024 * 1024, 'Release too large')
        require(hashlib.sha256(verified[name]).hexdigest() == sha, 'Release bytes changed')
    target = INSTALL_ROOT
    for parent in target.parents:
        trusted(parent)
    if target.exists(): trusted(target)
    else: target.mkdir(mode=0o755);target.chmod(0o755)
    stamp = target / 'installed-release.json'
    prior = {}
    if stamp.exists():
        trusted(stamp)
        previous = json.loads(stamp.read_text())
        require('managedFiles' in previous, 'Legacy installation needs explicit code migration')
        prior = previous['managedFiles']
    managed = {}
    for name, data in verified.items():
        if name.startswith('broker/'):
            relative = pathlib.PurePosixPath(name).name
        elif role == 'broker' and name.startswith('plugin/'):
            relative = name
        else:
            continue
        destination = target / relative
        destination.parent.mkdir(mode=0o755, exist_ok=True)
        trusted(destination.parent);destination.parent.chmod(0o755)
        if destination.exists(): trusted(destination)
        temporary = destination.with_name(destination.name + '.new')
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
        with os.fdopen(fd, 'wb') as handle:
            handle.write(data);handle.flush();os.fsync(handle.fileno());os.fchmod(handle.fileno(), 0o644)
        os.replace(temporary, destination)
        managed[relative] = hashlib.sha256(data).hexdigest()
    # Remove only the exact prior release's unchanged managed files. Never
    # delete an unknown file or private configuration as "cleanup".
    for name, sha in prior.items():
        if name in managed: continue
        path = pathlib.PurePosixPath(name)
        require(not path.is_absolute() and '..' not in path.parts, 'Prior release path invalid')
        old = target / path
        require(stat.S_ISREG(trusted(old).st_mode) and hashlib.sha256(old.read_bytes()).hexdigest() == sha, 'Stale code was changed')
        old.unlink()
    state = STATE_ROOT
    state.mkdir(mode=0o700, exist_ok=True)
    require(stat.S_ISDIR(trusted(state).st_mode) and stat.S_IMODE(state.stat().st_mode) == 0o700, 'Untrusted state directory')
    if role == 'broker':
        unit = SYSTEMD_ROOT / 'paperclip-runner-results.service'
        for parent in unit.parents: trusted(parent)
        if unit.exists(): trusted(unit)
        unit.write_bytes(verified['paperclip-runner-results.service']);unit.chmod(0o644)
    temp = stamp.with_name(stamp.name + '.new')
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
    with os.fdopen(fd, 'w') as handle:
        json.dump({'manifestSha256': expected, 'role': role, 'managedFiles': managed}, handle)
        handle.flush();os.fsync(handle.fileno());os.fchmod(handle.fileno(), 0o644)
    os.replace(temp, stamp)
    print(json.dumps({'installed': True, 'role': role, 'manifestSha256': expected, 'containersBuiltOrRestarted': 0}))


if __name__ == '__main__':
    os.umask(0o077)
    require(len(sys.argv) == 4, 'Expected source, manifest digest and role')
    install(*sys.argv[1:])
