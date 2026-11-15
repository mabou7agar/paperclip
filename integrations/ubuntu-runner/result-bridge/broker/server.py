"""Local authenticated-by-socket adapter, not a public runner command API."""
import http.server
import fcntl
import os
import pathlib
import socketserver
import stat
import sys
import threading
from contextlib import ExitStack

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
from authentication import authenticate


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        try:
            require(self.path == '/api/v1/broker' and self.headers.get('Content-Type') == 'application/json', 'broker_route_invalid')
            length = int(self.headers.get('Content-Length', '0'))
            require(0 < length <= 128 * 1024, 'broker_request_too_large')
            self.connection.settimeout(20)
            raw = self.rfile.read(length)
            self.server.authenticate(self.connection, self.headers, raw)
            request = closed_json(raw)
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
        except Refusal as error:
            body = canonical({'error': error.code})
            self.send_response(409)
        except (ValueError, KeyError, TypeError):
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
    with ExitStack() as locks:
        # Both transports own the same durable jobs. A mode switch must never run
        # two recovery loops against a shared execution ledger.
        lock_path = pathlib.Path(config['stateRoot'])/'broker.lock'
        state_lock = locks.enter_context(lock_path.open('a+b'));lock_path.chmod(0o600)
        fcntl.flock(state_lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        if config.get('nativeQueue'):
            return serve_native(config,service)
        path = pathlib.Path(config['socketPath'])
        for parent in [path.parent, *path.parent.parents]:
            st = parent.lstat()
            require(stat.S_ISDIR(st.st_mode) and not parent.is_symlink() and st.st_uid == 0 and not st.st_mode & 0o022,
                    'broker_socket_parent_untrusted')
        # Hold the process lifetime lock before unlinking a stale socket. A second
        # service cannot replace the live broker's trusted IPC endpoint.
        if path.parent != pathlib.Path(config['stateRoot']):
            socket_lock = locks.enter_context((path.parent / 'broker.lock').open('a+b'))
            os.chmod(socket_lock.name, 0o600)
            fcntl.flock(socket_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if path.exists():
            require(stat.S_ISSOCK(path.lstat().st_mode) and path.lstat().st_uid == 0, 'broker_socket_untrusted')
            path.unlink()
        with Server(str(path), Handler) as server:
            server.service = service
            server.authenticate = lambda connection, headers, raw: authenticate(connection, headers, raw, config)
            os.chown(path, 0, config['socketGid'])
            path.chmod(0o600)
            def recover():
                while not stop.is_set():
                    try:
                        service.recover()
                    except Exception:
                        pass  # Persisted jobs remain pending; this never starts a model.
                    stop.wait(15)
            stop = threading.Event()
            thread = threading.Thread(target=recover, daemon=True)
            thread.start()
            try:
                server.serve_forever(poll_interval=1)
            finally:
                stop.set()
                thread.join(timeout=20)


def serve_native(config,service):
    """No plugin-facing socket or credential. Native host owns IPC provenance."""
    from native_transport import NativeTransport
    from native_work_loop import NativeHintInbox, NativeWorkLoop
    transport = NativeTransport(config,service,service.native)
    inbox=NativeHintInbox(transport.ledger,{profile["companyId"] for profile in config["profiles"].values()},
        peer_uid=config["nativeQueue"].get("hintPeerUid",1000),peer_profile=config["nativeQueue"].get("hintPeerProfile","paperclip-control"))
    try:NativeWorkLoop(transport,service).run(inbox)
    finally:inbox.close()


if __name__ == '__main__':
    os.umask(0o077)
    require(len(sys.argv) == 2, 'broker_config_required')
    serve(load(sys.argv[1]))
