"""Local authenticated-by-socket adapter, not a public runner command API."""
import http.server
import fcntl
import os
import pathlib
import socketserver
import stat
import sys
import threading

HERE = pathlib.Path(os.path.abspath(__file__)).parent
if __name__ == '__main__':
    st = HERE.lstat()
    if not sys.flags.isolated or not sys.dont_write_bytecode or os.getuid() != 0 or HERE.is_symlink() or st.st_uid != 0 or st.st_mode & 0o022:
        raise RuntimeError('broker_code_boundary_invalid')
sys.path.insert(0, str(HERE))
from configuration import load
from contracts import canonical, closed_json, require, Refusal, UUID, SHA
from repository import JobRepository
from native_repository import NativeRepository
from remote_repository import RemoteRepository
from job_service import JobService


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        try:
            require(self.path == '/api/v1/broker' and self.headers.get('Content-Type') == 'application/json', 'broker_route_invalid')
            length = int(self.headers.get('Content-Length', '0'))
            require(0 < length <= 128 * 1024, 'broker_request_too_large')
            request = closed_json(self.rfile.read(length))
            require(isinstance(request, dict) and set(request) == {'operation', 'input'} and isinstance(request['input'], dict), 'broker_envelope_invalid')
            operation, value = request['operation'], request['input']
            service = self.server.service
            if operation == 'submit':
                result = service.submit(value)
            elif operation == 'status':
                require(set(value) == {'jobId', 'companyId', 'agentId'} and all(UUID.fullmatch(x) for x in value.values()), 'broker_status_invalid')
                result = service.status(value)
            elif operation == 'result':
                require(set(value) == {'jobId'} and UUID.fullmatch(value['jobId']), 'broker_result_invalid')
                result = service.repository.get(value['jobId'])['result']
                require(result is not None, 'broker_result_pending')
            elif operation == 'pending_deliveries':
                require(not value, 'broker_outbox_invalid')
                result = {'jobs': service.repository.pending()}
            elif operation == 'acknowledge':
                require(set(value) <= {'jobId', 'receiptSha256', 'disposition', 'runId'} and
                        UUID.fullmatch(value['jobId']) and SHA.fullmatch(value['receiptSha256']) and
                        value['disposition'] in ['native_continuation', 'recorded_only'], 'broker_acknowledgement_invalid')
                service.repository.acknowledge(value['jobId'], value['receiptSha256'])
                result = {'acknowledged': True}
            else:
                raise Refusal('broker_operation_invalid')
            body = canonical(result)
            require(len(body) <= 128 * 1024, 'broker_result_too_large')
            self.send_response(200)
        except (Refusal, ValueError, KeyError, TypeError):
            body = canonical({'error': 'broker_request_refused'})
            self.send_response(409)
        except Exception:
            body = canonical({'error': 'broker_temporarily_unavailable'})
            self.send_response(503)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


def serve(config):
    repository = JobRepository(config['stateRoot'])
    service = JobService(config, repository, NativeRepository(config), RemoteRepository())
    path = pathlib.Path(config['socketPath'])
    for parent in [path.parent, *path.parent.parents]:
        st = parent.lstat()
        require(stat.S_ISDIR(st.st_mode) and not parent.is_symlink() and st.st_uid == 0 and not st.st_mode & 0o022,
                'broker_socket_parent_untrusted')
    # Hold the process lifetime lock before unlinking a stale socket. A second
    # service cannot replace the live broker's trusted IPC endpoint.
    lock = (path.parent / 'broker.lock').open('a+b')
    os.chmod(lock.name, 0o600)
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    if path.exists():
        require(stat.S_ISSOCK(path.lstat().st_mode) and path.lstat().st_uid == 0, 'broker_socket_untrusted')
        path.unlink()
    with Server(str(path), Handler) as server:
        server.service = service
        os.chown(path, 0, config['socketGid'])
        path.chmod(0o660)
        service.recover()
        def recover():
            while not stop.wait(15):
                try:
                    service.recover()
                except Exception:
                    pass  # Persisted jobs remain pending; this never starts a model.
        stop = threading.Event()
        thread = threading.Thread(target=recover, daemon=True)
        thread.start()
        try:
            server.serve_forever(poll_interval=1)
        finally:
            stop.set()
            thread.join(timeout=20)


if __name__ == '__main__':
    os.umask(0o077)
    require(len(sys.argv) == 2, 'broker_config_required')
    serve(load(sys.argv[1]))
