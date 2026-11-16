"""One-use recovery outside an existing measured execution installation.

Stage this reviewed file and broker/{remote_worker,control_runner,control_results}.py
under a root-owned, non-writable directory. Review and pin the staging manifest
and scope separately. No module in the measured installation is changed.
"""
import fcntl
import hashlib
import json
import os
import pathlib
import stat
import sys

INSTALL = pathlib.Path('/opt/paperclip-ubuntu-runner-results')
STATE = pathlib.Path('/var/lib/paperclip-ubuntu-runner-results')


def require(ok, why):
    if not ok:
        raise RuntimeError(why)


def read(path, private=False):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022 and
            (not private or stat.S_IMODE(info.st_mode) == 0o600), 'untrusted recovery input')
    return path.read_bytes()


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def main(stage, manifest_sha, scope_sha):
    require(os.getuid() == 0 and sys.flags.isolated and sys.dont_write_bytecode, 'isolated root operator required')
    stage = pathlib.Path(stage).absolute()
    for parent in [stage, *stage.parents]:
        info = parent.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022, 'untrusted staging ancestor')
    raw = read(stage / 'recovery-manifest.json'); require(sha(raw) == manifest_sha, 'recovery release changed')
    manifest = json.loads(raw)
    expected = {'recover_control_completion.py', 'recovery-scope.json', 'broker/remote_worker.py',
                'broker/control_runner.py', 'broker/control_results.py'}
    require(set(manifest) == expected, 'unexpected recovery inventory')
    require({str(path.relative_to(stage)) for path in stage.rglob('*')} ==
            expected | {'recovery-manifest.json', 'broker'}, 'unlisted recovery files or packages')
    for name, value in manifest.items():
        require(sha(read(stage / name)) == value, 'recovery bytes changed')
    raw = read(stage / 'recovery-scope.json'); require(sha(raw) == scope_sha, 'recovery scope changed')
    scope = json.loads(raw)
    for path in [INSTALL, STATE, STATE / 'jobs', stage / 'broker']:
        info = path.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022, 'untrusted runtime directory')
    installed_raw = read(INSTALL / 'installed-release.json')
    installed = json.loads(installed_raw)
    require(installed['role'] == 'execution' and installed['manifestSha256'] == scope['installedManifestSha256'],
            'installed execution identity changed')
    def verify_installed():
        require({path.name for path in INSTALL.iterdir()} == set(installed['managedFiles']) |
                {'installed-release.json'}, 'unlisted installed files or packages')
        require(read(INSTALL / 'installed-release.json') == installed_raw, 'installed stamp changed')
        for name, value in installed['managedFiles'].items():
            path = pathlib.PurePosixPath(name)
            require(not path.is_absolute() and '..' not in path.parts, 'unsafe installed inventory')
            require(sha(read(INSTALL / path)) == value, 'installed code changed')
    verify_installed()
    # -B prevents writes; a fresh prefix also excludes existing bytecode reads.
    cache = STATE / ('.control-recovery-unused-cache-' + manifest_sha)
    require(not cache.exists() and not cache.is_symlink(), 'recovery cache path already exists')
    sys.pycache_prefix = str(cache)
    sys.path[:0] = [str(stage / 'broker'), str(INSTALL)]
    import remote_worker as worker
    from contracts import UUID, digest
    from control_runner import lookup_control
    require(UUID.fullmatch(scope['jobId']), 'invalid job identity')
    root = worker.root_for(scope['jobId']); worker.trusted_root(root)
    plan = worker.read_json(root / 'plan.json', 2 * 1024 * 1024)
    require(plan['jobId'] == scope['jobId'] and plan['request']['kind'] == 'control_checks' and
            digest(plan) == scope['planSha256'], 'original control plan changed')
    for name in ['attempt.json', 'result.json']:
        require(sha(read(root / name, private=True)) == scope['originalFiles'][name], 'original attempt or failure changed')
    with (root / 'launch.lock').open('a+b') as lock:
        os.fchmod(lock.fileno(), 0o600); fcntl.flock(lock, fcntl.LOCK_EX)
        require(not (root / 'reconciled.json').exists(), 'already reconciled; inspect normally')
        current = lookup_control('paperclip-controls-' + scope['jobId'])
        require(current is not None and current.get('running') is False and current.get('exit') == 0 and
                current.get('job') == scope['jobId'] and current.get('plan') == scope['planSha256'],
                'original stopped control evidence unavailable; no recovery write')
        worker.write_once(root / 'control-recovery-operator-attempt.json', {'releaseSha256': manifest_sha,
                          'scopeSha256': scope_sha, 'executionRepeated': False})
        try:
            value = worker.inspect(scope['jobId'])
        except Exception:
            raise RuntimeError('recovery refused; reconciled receipt present=' +
                               str((root / 'reconciled.json').exists()) + '; no automatic retry') from None
        require(value['phase'] == 'terminal' and value['result'].get('recoveredCompletion') is True and
                value['result'].get('executionRepeated') is False and value['result'].get('cleanupComplete') is True,
                'recovery incomplete; reconciled receipt present=' + str((root / 'reconciled.json').exists()) +
                '; inspect retained status; no automatic operator retry')
        verify_installed()
        for name in ['attempt.json', 'result.json']:
            require(sha(read(root / name, private=True)) == scope['originalFiles'][name], 'original history changed')
        worker.write_once(root / 'control-recovery-operator-complete.json', {'releaseSha256': manifest_sha,
                          'scopeSha256': scope_sha, 'resultSha256': sha(read(root / 'reconciled.json', private=True)),
                          'installedManifestUnchanged': True, 'executionRepeated': False})
        print(json.dumps(value))


if __name__ == '__main__':
    os.umask(0o077)
    require(len(sys.argv) == 4, 'stage/manifest/scope required')
    main(*sys.argv[1:])
