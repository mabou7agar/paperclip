"""Real broker/JobService/Packet/admission/SQLite/HTTP path, external doubles.

The native records and remote execution are synthetic. No provider, Docker,
application test or root operation is executed by this tools-only fixture.
"""
import json
import pathlib
import sys
import threading
import time
import uuid
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'broker'))
from server import Server, Handler
from repository import JobRepository
from job_service import JobService
from native_repository import NativeRepository
from authentication import verify_signature
from contracts import canonical
from test_packet import fixture as packet_fixture


class NativeDouble(NativeRepository):
    def __init__(self, boot, raw, callback):
        super().__init__({'callbackUrl': callback})
        self.boot, self.raw = boot, raw
        self.source_ready = time.monotonic() + 0.2
        self.notified = False
    def read(self, path, **_):
        r = self.boot['request']
        if '/content' in path: return self.raw
        if '/attachments' in path:
            return [{'id': r['attachmentId'], 'sha256': r['packetSha256'], 'byteSize': len(self.raw)}]
        if '/agents/' in path: return {'companyId': r['companyId'], 'status': 'idle'}
        return {'id': r['taskId'], 'companyId': r['companyId'], 'projectId': r['projectId'],
                'assigneeAgentId': r['agentId'], 'status': 'in_progress', 'blockedBy': []}
    def admission_gates(self, *_):
        return {'companyActive': True, 'projectActive': True, 'pauseHeld': False}
    def metadata(self, *_):
        r = self.boot['request']
        return [{'kind': 'run', 'id': r['sourceRunId'], 'task': r['taskId'], 'agent': r['agentId'],
                 'status': 'succeeded' if time.monotonic() >= self.source_ready else 'running',
                 'before': 'original-saved-session', 'after': 'original-saved-session'}]
    def notify(self, identity):
        # Fault transport: one attempted callback per process. Restart must
        # recover the still-pending durable delivery after its ACK was lost.
        if self.notified: return False
        self.notified = True
        return super().notify(identity)


class RemoteDouble:
    def __init__(self, root):
        self.root = root
    def stage(self, profile, identity, request, packet, admission):
        path = self.root / (identity + '.plan')
        value = canonical({'packetSha256': request['packetSha256'], 'admission': admission})
        if path.exists():
            assert path.read_bytes() == value
        else:
            with path.open('xb') as out: out.write(value)
    def launch(self, profile, identity):
        # A duplicate dispatch fails this fixture; it cannot silently count as
        # another successful test. The real SSH execution is not exercised.
        with (self.root / (identity + '.dispatch')).open('x') as out: out.write('1')
    def inspect(self, profile, identity):
        if not (self.root / (identity + '.plan')).exists(): return {'phase': 'not_staged'}
        if not (self.root / (identity + '.dispatch')).exists(): return {'phase': 'staged'}
        plan = json.loads((self.root / (identity + '.plan')).read_text())
        return {'phase': 'terminal', 'result': {'status': 'failed', 'kind': 'control_checks',
            'code': 'synthetic_fixture_failure', 'cleanupComplete': True, 'dispatches': 1,
            'controlDigest': plan['admission']['controlDigest']}}


def boot_for(root):
    path = root / 'fixture.json'
    if path.exists(): return json.loads(path.read_text()), (root / 'packet.tar.gz').read_bytes()
    raw, sha, profile = packet_fixture(source_patch={'checks-new.py': b'print("not executed by transport fixture")'})
    request = {'taskId': str(uuid.uuid4()), 'profile': 'example', 'kind': 'control_checks', 'attachmentId': str(uuid.uuid4()),
               'packetSha256': sha, 'scopeIssueId': None, 'scopeCommentId': None, 'ackCommentId': None, 'recipe': 'checks-new.py',
               'companyId': str(uuid.uuid4()), 'projectId': str(uuid.uuid4()), 'agentId': str(uuid.uuid4()), 'sourceRunId': str(uuid.uuid4())}
    profile.update(companyId=request['companyId'], projectId=request['projectId'], taskIds=[request['taskId']],
                   agentId=request['agentId'], savedSessions={request['agentId']: 'original-saved-session'},
                   allowControlChecks=True, allowReviewedController=False, controlInputs=['execute_qualification.py'],
                   preparedImage='sha256:' + 'a' * 64, uid=1001, gid=999, sshTarget='isolated-double', runner='isolated-double', policyDigest='fixture-policy')
    boot = {'ready': True, 'request': request, 'profile': profile}
    path.write_bytes(canonical(boot));path.chmod(0o600)
    (root / 'packet.tar.gz').write_bytes(raw)
    return boot, raw


if __name__ == '__main__':
    root, socket = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
    root.mkdir(mode=0o700, exist_ok=True)
    boot, raw = boot_for(root)
    native = NativeDouble(boot, raw, sys.argv[3])
    remote = RemoteDouble(root)
    service = JobService({'profiles': {'example': boot['profile']}}, JobRepository(root), native, remote)
    if socket.exists(): socket.unlink()
    with Server(str(socket), Handler) as server:
        server.service = service
        server.authenticate = lambda _connection, headers, body: verify_signature(b'c' * 64, headers, body)
        stop = threading.Event()
        def recovery():
            while not stop.is_set():
                service.recover()
                stop.wait(0.05)
        thread = threading.Thread(target=recovery, daemon=True)
        thread.start()
        print(json.dumps({'ready': True, 'request': boot['request']}), flush=True)
        try: server.serve_forever(poll_interval=0.1)
        finally: stop.set();thread.join(timeout=1)
