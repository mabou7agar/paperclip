import pathlib
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'broker'))
from contracts import Refusal, digest
from job_service import JobService
from repository import JobRepository
from test_repository import request


class JobTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        pathlib.Path(self.temp.name).chmod(0o700)
        self.repo = JobRepository(self.temp.name)
        self.request = request()
        self.profile = {'policyDigest': 'policy', 'savedSessions': {self.request['agentId']: 'saved'}, 'allowControlChecks': True,
                        'controlInputs': ['helper.php'], 'preparedImage': 'sha256:' + 'a' * 64, 'uid': 1001, 'gid': 999}
        self.native, self.remote = Mock(), Mock()
        self.service = JobService({'profiles': {'example': self.profile}}, self.repo, self.native, self.remote)
        self.service.admission = Mock()
        self.service.source_settled = Mock()
        self.service.load_packet = Mock(return_value=Mock(directory='qualification-new', files={'checks-new.py': b''}, file_sha=lambda _: 'd' * 64))
        self.native.metadata.return_value = [{'agent': self.request['agentId'], 'task': self.request['taskId'],
            'status': 'succeeded', 'before': 'saved', 'after': 'saved'}]

    def tearDown(self):
        self.service.executor.shutdown(wait=True)
        self.temp.cleanup()

    def register(self, value=None):
        return self.repo.register(value or self.request, 'policy')[0]

    def terminal(self):
        self.remote.inspect.return_value = {'phase': 'terminal', 'result': {'status': 'failed', 'kind': 'reviewed_controller',
            'cleanupComplete': True, 'diagnostic': {'stage': 'prerequisite', 'line': 33}}}

    def test_capacity_hold_does_not_consume_attempt_or_wake(self):
        first = self.register()
        self.repo.claim(first)
        second = self.register({**self.request, 'packetSha256': 'b' * 64})
        self.service.execute(second)
        self.assertEqual(self.repo.get(second)['state'], 'queued')
        self.remote.stage.assert_not_called()
        self.native.notify.assert_not_called()

    def test_restart_after_launch_reconciles_same_job_without_second_execution(self):
        identity = self.register()
        self.repo.claim(identity)
        self.terminal()
        self.service.execute(identity)
        self.remote.stage.assert_not_called()
        self.remote.launch.assert_not_called()
        self.assertEqual(self.repo.get(identity)['state'], 'terminal')
        self.assertEqual(self.repo.pending(), [identity])
        self.native.notify.assert_called_once_with(identity)

    def test_ambiguous_transport_is_quarantined_then_read_only_reconciled(self):
        identity = self.register()
        self.remote.launch.side_effect = Refusal('remote_transport_unconfirmed')
        self.service.execute(identity)
        self.assertEqual(self.repo.get(identity)['state'], 'quarantined')
        self.remote.launch.assert_called_once()
        self.terminal()
        self.service.execute(identity)
        self.assertEqual(self.repo.get(identity)['state'], 'terminal')
        self.remote.launch.assert_called_once()
        self.remote.stage.assert_called_once()

    def test_exact_passed_control_inputs_are_reused_without_repeating_recipe(self):
        value = {**self.request, 'kind': 'control_checks', 'scopeIssueId': None, 'scopeCommentId': None,
                 'ackCommentId': None, 'recipe': 'checks-new.py'}
        first = self.register(value)
        key = digest(['d' * 64, {'helper.php': 'd' * 64}, self.profile['preparedImage'], 1001, 999])
        self.repo.terminal(first, {'jobId': first, 'companyId': value['companyId'], 'projectId': value['projectId'],
            'issueId': value['taskId'], 'agentId': value['agentId'], 'profile': 'example', 'status': 'passed',
            'receiptSha256': 'c' * 64, 'fingerprint': 'd' * 64, 'result': {'status': 'passed', 'kind': 'control_checks', 'controlDigest': key}})
        second = self.register({**value, 'packetSha256': 'e' * 64})
        self.service.execute(second)
        self.assertEqual(self.repo.get(second)['result']['result']['reusedFromJobId'], first)
        self.remote.stage.assert_not_called()
        self.remote.launch.assert_not_called()

    def test_changed_session_fails_before_admission_without_resetting_it(self):
        self.service.source_settled = JobService.source_settled.__get__(self.service)
        self.native.metadata.return_value[0]['after'] = 'unexpected-rotation'
        identity = self.register()
        self.service.execute(identity)
        self.assertEqual(self.repo.get(identity)['result']['result']['code'], 'job_source_session_unsettled')
        self.remote.launch.assert_not_called()
        self.assertEqual(self.profile['savedSessions'][self.request['agentId']], 'saved')
