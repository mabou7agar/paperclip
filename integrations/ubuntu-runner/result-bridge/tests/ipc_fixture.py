"""Tools-only transport fixture: real IPC/SQLite, no SSH, test or provider."""
import json
import pathlib
import sys
import tempfile
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'broker'))
from server import Server, Handler
from repository import JobRepository
from contracts import job_request


class FixtureService:
    def __init__(self, root): self.repository = JobRepository(root)
    def submit(self, value):
        value = job_request(value)
        identity, created = self.repository.register(value, 'isolated-transport-fixture')
        if created:
            self.repository.claim(identity)
            self.repository.terminal(identity, {'jobId': identity, 'companyId': value['companyId'], 'projectId': value['projectId'],
                'issueId': value['taskId'], 'agentId': value['agentId'], 'profile': value['profile'], 'status': 'failed',
                'receiptSha256': 'a' * 64, 'fingerprint': 'b' * 64, 'result': {'status': 'failed', 'code': 'synthetic_fixture_failure',
                    'cleanupComplete': True, 'executions': 1}})
        return {'jobId': identity, 'state': self.repository.get(identity)['state'], 'replayed': not created}
    def status(self, value):
        saved = self.repository.get(value['jobId'])
        assert all(saved['input'][x] == value[x] for x in ['companyId', 'agentId'])
        return {'jobId': saved['id'], 'state': saved['state'], 'result': saved['result']}


if __name__ == '__main__':
    root, socket = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
    root.mkdir(mode=0o700, exist_ok=True)
    if socket.exists(): socket.unlink()
    with Server(str(socket), Handler) as server:
        server.service = FixtureService(root)
        print('ready', flush=True)
        server.serve_forever(poll_interval=0.1)
