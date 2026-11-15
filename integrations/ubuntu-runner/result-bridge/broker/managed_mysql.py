"""Root-only, kernel-job-bound administrative SQL transport.

No SQL reaches MySQL until its exact connection ID is durably registered. This
works with performance_schema disabled; passwords stay inside MySQL's container.
"""
import os
import dataclasses
import pathlib
import re
import selectors
import signal
import subprocess
import sys
import time

HERE = pathlib.Path(__file__).absolute().parent
if __name__ == '__main__':
    if os.getuid() != 0 or not sys.flags.isolated or not sys.dont_write_bytecode or str(HERE) != '/opt/paperclip-ubuntu-runner-results' or HERE.is_symlink() or HERE.stat().st_uid != 0 or HERE.stat().st_mode & 0o022:
        raise RuntimeError('managed_mysql_operator_boundary_required')
sys.path.insert(0, str(HERE))
from contracts import require, UUID, digest
from mysql_connections import MysqlConnectionRepository
from owned_resources import OwnedResourceRepository


class ManagedMysqlService:
    def __init__(self, resources, registry):
        self.resources, self.registry = resources, registry

    def execute(self, statement, timeout=240, output_limit=128 * 1024):
        require(isinstance(statement, bytes) and 0 < len(statement) <= 128 * 1024, 'managed_mysql_input_invalid')
        spec = self.resources.spec
        self.resources.unchanged(spec.mysql)
        process = subprocess.Popen(['docker', 'exec', '-i', spec.mysql, 'sh', '-c',
            'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; exec mysql --skip-reconnect --unbuffered -uroot -N -B --init-command="SET SESSION wait_timeout=30"'],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0, start_new_session=True)
        record = None;received = {'stdout': bytearray(), 'stderr': bytearray()}
        try:
            # The client is blocked on empty stdin while this handshake and
            # durable root receipt finish (only the read-only ID query is sent first). A killed driver cannot race DDL
            # ahead of its supervisor learning which server session it owns.
            process.stdin.write(b'SELECT CONNECTION_ID();\n');process.stdin.flush()
            prefix = bytearray();deadline = time.monotonic() + 10
            with selectors.DefaultSelector() as selector:
                selector.register(process.stdout, selectors.EVENT_READ)
                while not prefix.endswith(b'\n'):
                    require(time.monotonic() < deadline and process.poll() is None, 'managed_mysql_handshake_unconfirmed')
                    if not selector.select(.1):continue
                    value = os.read(process.stdout.fileno(), 1)
                    require(value and len(prefix) < 24, 'managed_mysql_handshake_invalid')
                    prefix.extend(value)
            require(prefix.strip().isdigit(), 'managed_mysql_handshake_invalid')
            record = self.registry.register(int(prefix.strip()), self.resources.bindings[spec.mysql], statement)
            self.resources.unchanged(spec.mysql)
            pending = memoryview(statement + b'\n');deadline = time.monotonic() + timeout
            with selectors.DefaultSelector() as selector:
                for stream in [process.stdin, process.stdout, process.stderr]:os.set_blocking(stream.fileno(), False)
                selector.register(process.stdin, selectors.EVENT_WRITE, 'stdin')
                selector.register(process.stdout, selectors.EVENT_READ, 'stdout')
                selector.register(process.stderr, selectors.EVENT_READ, 'stderr')
                while selector.get_map():
                    require(time.monotonic() < deadline, 'managed_mysql_deadline')
                    for key, _ in selector.select(.1):
                        if key.data == 'stdin':
                            count = os.write(key.fileobj.fileno(), pending[:8192]);pending = pending[count:]
                            if not pending:selector.unregister(key.fileobj);key.fileobj.close()
                        else:
                            data = os.read(key.fileobj.fileno(), 8192)
                            if not data:selector.unregister(key.fileobj);key.fileobj.close();continue
                            received[key.data].extend(data)
                            require(len(received[key.data]) <= output_limit, 'managed_mysql_output_bound')
            exit_code = process.wait(timeout=5)
            self.registry.complete(record, exit_code)
            require(exit_code == 0, 'managed_mysql_failed')
            return bytes(received['stdout'])
        except BaseException:
            # The recorded ID remains pending for independent cancellation.
            # Killing this Docker CLI alone is never treated as SQL completion.
            if process.poll() is None:
                try:os.killpg(process.pid, signal.SIGTERM)
                except ProcessLookupError:pass
                try:process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL);process.wait(timeout=5)
            raise
        finally:
            for stream in [process.stdin, process.stdout, process.stderr]:
                if stream and not stream.closed:stream.close()


def current_job():
    groups = pathlib.Path('/proc/self/cgroup').read_text()
    matches = re.findall(r'/paperclip-runner-(job|owner)-([a-f0-9-]{36})\.service(?:\n|$)', groups)
    require(len(matches) == 1 and UUID.fullmatch(matches[0][1]), 'managed_mysql_job_context_required')
    return matches[0]


def main(cleanup):
    from remote_worker import root_for, trusted_root, read_json
    from packet import Packet
    from supervision_policy import SetupOwnership
    kind, identity = current_job();root = root_for(identity);trusted_root(root)
    plan = read_json(root / 'plan.json', 2 * 1024 * 1024)
    packet = Packet((root / 'packet.tar.gz').read_bytes(), plan['request']['packetSha256'], plan['profile'], privileged=True)
    spec = SetupOwnership.from_plan(plan, packet)
    lease = read_json(root / 'ownership-lease.json')
    require(digest(lease['spec']) == digest(dataclasses.asdict(spec)) and
            lease['admissionCoreSha256'] == digest(plan['admission']['admission']), 'managed_mysql_lease_changed')
    if kind != 'owner' and not cleanup:require(lease['startedUnix'] <= time.time() < lease['expiresUnix'], 'managed_mysql_lease_expired')
    registry = MysqlConnectionRepository(root);resources = OwnedResourceRepository(spec, registry=registry)
    require(resources.bindings == lease['containers'], 'managed_mysql_container_changed')
    statement = sys.stdin.buffer.read(128 * 1024 + 1)
    sys.stdout.buffer.write(ManagedMysqlService(resources, registry).execute(statement))


if __name__ == '__main__':
    require(sys.argv[1:] in [[], ['--cleanup']], 'managed_mysql_arguments_invalid')
    main(sys.argv[1:] == ['--cleanup'])
