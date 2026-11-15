"""Private immutable lease/startup facts and accepted code-measurement binding."""
import dataclasses
import hashlib
import json
import os
import pathlib
import stat
import tempfile
import time
from configuration import private_file
from contracts import canonical, digest, require, closed_json, SHA

REQUIRED_CASES = {'pre_setup_driver_death', 'container_child_outlives_host', 'tagged_mysql_cancel',
                  'partial_ddl_cleanup', 'stale_lease_rejected', 'effective_identity'}


def process_identity(pid):
    root = pathlib.Path('/proc') / str(pid)
    info = root.stat()
    fields = (root / 'stat').read_text().split(') ', 1)[1].split()
    require(info.st_uid == 0 and fields[0] != 'Z', 'setup_supervisor_identity_invalid')
    return int(fields[19])


def code_digest(directory):
    files = {}
    for path in pathlib.Path(directory).glob('*.py'):
        info = path.lstat()
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022,
                'setup_code_boundary_invalid')
        files[path.name] = hashlib.sha256(path.read_bytes()).hexdigest()
    require(len(files) >= 4, 'setup_code_inventory_missing')
    return digest(files)


def measurement(spec, directory):
    raw = private_file(spec.evidence_path).read_bytes()
    require(hashlib.sha256(raw).hexdigest() == spec.evidence_sha256, 'setup_measurement_changed')
    value = closed_json(raw)
    require(value.get('schema') == 'paperclip.runner.setup-readiness.v1' and value.get('measured') is True and
            value.get('brokerCodeDigest') == code_digest(directory) and
            isinstance(value.get('cases'), dict) and REQUIRED_CASES <= set(value['cases']) and
            all(value['cases'][name].get('passed') is True and isinstance(value['cases'][name].get('receiptSha256'), str) and SHA.fullmatch(value['cases'][name]['receiptSha256'])
                for name in REQUIRED_CASES), 'setup_measurements_not_accepted')
    installed = closed_json((pathlib.Path(directory) / 'installed-release.json').read_bytes())
    require(installed.get('role') == 'execution', 'setup_installed_role_invalid')
    return {'cancellationEvidenceSha256': spec.evidence_sha256,
            'installedBridgeSha256': installed['manifestSha256'],
            'supervisorCodeSha256': hashlib.sha256((pathlib.Path(directory) / 'setup_supervisor.py').read_bytes()).hexdigest()}


class OwnershipLedger:
    def __init__(self, root):
        self.root = pathlib.Path(root)
        info = self.root.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o700,
                'setup_private_job_root_invalid')

    def read(self, name):
        return closed_json(private_file(self.root / name).read_bytes())

    def once(self, name, value):
        path = self.root / name
        data = canonical(value)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'wb') as output:
            output.write(data); output.flush(); os.fsync(output.fileno()); os.fchmod(output.fileno(), 0o600)
        descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try: os.fsync(descriptor)
        finally: os.close(descriptor)
        return hashlib.sha256(data).hexdigest()

    def admit(self, spec, admission, code, containers):
        value = {'spec': dataclasses.asdict(spec), 'containers': containers, 'admissionCoreSha256': digest(admission),
                 'driverPid': os.getpid(), 'driverStartTicks': process_identity(os.getpid()),
                 'startedUnix': time.time(), 'containerProcessStartTicks': int(time.clock_gettime(time.CLOCK_BOOTTIME) * os.sysconf('SC_CLK_TCK')), **code}
        value['expiresUnix'] = value['startedUnix'] + spec.lease_seconds
        self.once('ownership-lease.json', value)
        return value
