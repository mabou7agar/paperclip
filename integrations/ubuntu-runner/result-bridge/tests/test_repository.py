import concurrent.futures
import json
import os
import pathlib
import sys
import tempfile
import unittest
import uuid

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'broker'))
from contracts import Refusal, closed_diagnostic, closed_json, job_request, job_id
from repository import JobRepository


def request():
    return dict(taskId=str(uuid.uuid4()), profile='example', kind='reviewed_controller',
                attachmentId=str(uuid.uuid4()), packetSha256='a' * 64, scopeIssueId=str(uuid.uuid4()),
                scopeCommentId=str(uuid.uuid4()), ackCommentId=str(uuid.uuid4()), recipe=None,
                companyId=str(uuid.uuid4()), projectId=str(uuid.uuid4()), agentId=str(uuid.uuid4()), sourceRunId=str(uuid.uuid4()))


class RepositoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='paperclip-runner-test-')
        self.root = pathlib.Path(self.temp.name)
        self.root.chmod(0o700)
        self.repository = JobRepository(self.root)
        self.request = job_request(request())

    def tearDown(self):
        self.temp.cleanup()

    def result(self, identity, status='failed', receipt='b' * 64, fingerprint='c' * 64):
        return dict(jobId=identity, companyId=self.request['companyId'], projectId=self.request['projectId'],
                    issueId=self.request['taskId'], agentId=self.request['agentId'], profile='example',
                    status=status, receiptSha256=receipt, fingerprint=fingerprint, result={'status': status})

    def test_concurrent_registration_and_claim_execute_only_once(self):
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            values = list(pool.map(lambda _: JobRepository(self.root).register(self.request, 'policy'), range(8)))
        self.assertEqual(sum(created for _, created in values), 1)
        identity = values[0][0]
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            claims = list(pool.map(lambda _: JobRepository(self.root).claim(identity), range(8)))
        self.assertEqual(sum(claims), 1)

    def test_later_native_turn_reuses_original_job_without_changing_original_run(self):
        identity, _ = self.repository.register(self.request, 'policy')
        self.assertEqual(self.repository.register({**self.request, 'sourceRunId': str(uuid.uuid4())}, 'policy'), (identity, False))
        self.assertEqual(self.repository.get(identity)['input']['sourceRunId'], self.request['sourceRunId'])

    def test_changed_owner_or_policy_cannot_reinterpret_an_existing_job(self):
        self.repository.register(self.request, 'policy')
        for patch, policy in [({'agentId': str(uuid.uuid4())}, 'policy'), ({}, 'changed')]:
            with self.assertRaises(Refusal):
                self.repository.register({**self.request, **patch}, policy)

    def test_receipt_survives_restart_and_acknowledgement_loss(self):
        identity, _ = self.repository.register(self.request, 'policy')
        self.repository.claim(identity)
        value = self.repository.terminal(identity, self.result(identity))
        restarted = JobRepository(self.root)
        self.assertEqual(restarted.get(identity)['result'], value)
        self.assertEqual(restarted.pending(), [identity])
        restarted.acknowledge(identity, 'b' * 64)
        self.assertEqual(restarted.pending(), [])
        self.assertEqual(restarted.terminal(identity, self.result(identity)), value)

    def test_unchanged_failure_does_not_gain_progress_from_new_job_or_packet(self):
        first, _ = self.repository.register(self.request, 'policy')
        self.repository.claim(first)
        self.assertTrue(self.repository.terminal(first, self.result(first))['newEvidence'])
        changed = {**self.request, 'packetSha256': 'd' * 64}
        second, _ = self.repository.register(changed, 'policy')
        self.repository.claim(second)
        self.assertFalse(self.repository.terminal(second, self.result(second, receipt='e' * 64))['newEvidence'])

    def test_unknown_ownership_is_retained_and_new_actual_evidence_is_a_separate_receipt(self):
        identity, _ = self.repository.register(self.request, 'policy')
        self.repository.claim(identity)
        self.repository.terminal(identity, self.result(identity, status='unknown'))
        self.assertEqual(self.repository.get(identity)['state'], 'quarantined')
        self.assertEqual(self.repository.ownership_holds('other'), [identity])
        self.repository.terminal(identity, self.result(identity, status='failed', receipt='d' * 64, fingerprint='e' * 64))
        self.assertEqual(self.repository.get(identity)['state'], 'terminal')
        self.repository.acknowledge(identity, 'b' * 64)
        self.assertEqual(self.repository.pending(), [identity])
        self.repository.acknowledge(identity, 'd' * 64)
        self.assertEqual(self.repository.pending(), [])

    def test_acknowledgement_cannot_claim_another_hash(self):
        identity, _ = self.repository.register(self.request, 'policy')
        self.repository.terminal(identity, self.result(identity))
        with self.assertRaises(Refusal): self.repository.acknowledge(identity, 'e' * 64)
        self.assertEqual(self.repository.pending(), [identity])

    def test_closed_diagnostics_reject_secrets_paths_and_unbounded_shapes(self):
        for value in [{'message': 'secret'}, {'source': '/private/secret'}, {'sql': 'SELECT secret'},
                      {'token': 'secret'}, {'items': list(range(257))}]:
            with self.assertRaises(Refusal): closed_diagnostic(value)
        self.assertEqual(closed_diagnostic({'stage': 'prerequisite', 'sourceSha256': 'a' * 64, 'line': 33}),
                         {'stage': 'prerequisite', 'sourceSha256': 'a' * 64, 'line': 33})

    def test_strict_request_and_json_cannot_supply_commands_or_duplicate_authority(self):
        with self.assertRaises(Refusal): job_request({**self.request, 'command': 'unsafe'})
        with self.assertRaises(Refusal): closed_json('{"id":1,"id":2}')
        with self.assertRaises(Refusal): closed_json('{"value":NaN}')
        with self.assertRaises(Refusal): job_request({**self.request, 'recipe': '../../secret.py'})


if __name__ == '__main__':
    unittest.main()

class SupersededDeliveryTests(unittest.TestCase):
    setUp = RepositoryTests.setUp
    tearDown = RepositoryTests.tearDown
    result = RepositoryTests.result
    def test_latest_ack_consumes_older_delivery_without_deleting_history(self):
        identity, _ = self.repository.register(self.request, 'policy')
        self.repository.claim(identity)
        self.repository.terminal(identity, self.result(identity, status='unknown'))
        self.repository.terminal(identity, self.result(identity, status='passed', receipt='d' * 64, fingerprint='e' * 64))
        self.repository.acknowledge(identity, 'd' * 64)
        self.assertEqual(self.repository.pending(), [])
        with self.repository.connection() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM deliveries').fetchone()[0], 2)
