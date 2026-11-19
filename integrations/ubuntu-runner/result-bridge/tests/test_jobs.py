import hashlib
import pathlib
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'broker'))
from contracts import Refusal, digest
from configuration import validate_required_packet_inputs
from job_service import JobService
from repository import JobRepository
from test_repository import request
from test_packet import fixture


class JobTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        pathlib.Path(self.temp.name).chmod(0o700)
        self.repo = JobRepository(self.temp.name)
        self.request = request()
        self.profile = {'policyDigest': 'policy', 'sshTarget': 'root@example', 'runner': 'runner', 'allowReviewedController': True, 'savedSessions': {self.request['agentId']: 'saved'}, 'allowControlChecks': True,
                        'controlInputs': ['helper.php'], 'preparedImage': 'sha256:' + 'a' * 64, 'uid': 1001, 'gid': 999}
        self.native, self.remote = Mock(), Mock()
        self.service = JobService({'profiles': {'example': self.profile}}, self.repo, self.native, self.remote)
        self.service.admission = Mock()
        self.service.admission.controller.return_value = {"nativeBindingsSha256": "f" * 64}
        self.service.source_settled = Mock()
        self.service.load_packet = Mock(return_value=Mock(directory='qualification-new', files={'checks-new.py': b''}, file_sha=lambda _: 'd' * 64))
        self.native.metadata.return_value = [{'agent': self.request['agentId'], 'task': self.request['taskId'],
            'status': 'succeeded', 'before': 'saved', 'after': 'saved'}]

    def tearDown(self):
        self.service.executor.shutdown(wait=True)
        self.temp.cleanup()

    def register(self, value=None):
        return self.repo.register(value or self.request, 'policy', self.service.slot(self.profile))[0]

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

    def test_required_packet_inputs_reject_self_consistent_incomplete_packets_before_staging(self):
        name = 'qualification-q1/retained-evidence.json'
        exact = b'{"outcome":"retained"}'
        self.profile['requiredPacketInputs'] = {
            'qualification-{key}/retained-evidence.json': hashlib.sha256(exact).hexdigest(),
        }
        self.service.load_packet = JobService.load_packet.__get__(self.service)

        for files, prefix, code in (
            ({}, 'q1', 'job_required_packet_input_missing'),
            ({name: b'{"outcome":"replaced"}'}, 'q1', 'job_required_packet_input_digest_mismatch'),
            ({name: exact}, 'q2', None),
        ):
            with self.subTest(code=code):
                self.remote.reset_mock()
                # The fixture rewrites archive paths for the new key.
                raw, sha, packet_profile = fixture(source_patch=files, prefix=prefix)
                self.profile.update(packet_profile)
                self.native.read.side_effect = [
                    [{'id': self.request['attachmentId'], 'sha256': sha, 'byteSize': len(raw)}],
                    raw,
                ] * 2
                job_id = self.register({**self.request, 'packetSha256': sha})
                if code is None:
                    self.terminal()
                self.service.execute(job_id)
                if code is not None:
                    saved = self.repo.get(job_id)
                    self.assertEqual(saved['state'], 'terminal')
                    result = saved['result']['result']
                    self.assertEqual(result['status'], 'failed')
                    self.assertEqual(result['code'], code)
                    self.assertFalse(result['executionStarted'])
                    self.remote.stage.assert_not_called()
                    self.remote.launch.assert_not_called()
                else:
                    self.remote.stage.assert_called_once()
                    self.remote.launch.assert_called_once()
                    self.assertIn('qualification-q2/retained-evidence.json', self.remote.stage.call_args.args[3].files)

    def test_required_packet_inputs_profile_rejects_invalid_pins(self):
        valid = {'qualification-{key}/retained-evidence.json': 'a' * 64}
        validate_required_packet_inputs({'allowReviewedController': True})
        validate_required_packet_inputs({'allowReviewedController': True, 'requiredPacketInputs': valid})
        invalid = [[], {}, {f'file{i}': 'a' * 64 for i in range(129)},
                   {'../evidence.json': 'a' * 64}, {'root//file.json': 'a' * 64},
                   {'/file.json': 'a' * 64}, {'root/': 'a' * 64}, {'root/./file.json': 'a' * 64},
                   {'root/..': 'a' * 64}, {'.hidden': 'a' * 64}, {'a' * 241: 'a' * 64},
                   {1: 'a' * 64}, {'qualification-{ke}/file.json': 'a' * 64},
                   {'{key}/{key}.json': 'a' * 64}, {'file.json': 'A' * 64},
                   {'file.json': None}, {'file.json': 'bad'}]
        for pins in invalid:
            with self.subTest(pins_type=type(pins)), self.assertRaisesRegex(Refusal, 'broker_required_packet_inputs_invalid'):
                validate_required_packet_inputs({'allowReviewedController': True, 'requiredPacketInputs': pins})
        with self.assertRaisesRegex(Refusal, 'broker_required_packet_inputs_invalid'):
            validate_required_packet_inputs({'allowReviewedController': False, 'requiredPacketInputs': valid})

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

    def test_functional_phase_entry_is_new_evidence_once(self):
        self.profile['setupContainment'] = {'required': True}
        outcome = {'status': 'failed', 'kind': 'reviewed_controller', 'cleanupComplete': True, 'auditComplete': False,
                   'steps': [{'phase': 'runtime', 'exit': 0}], 'diagnostic': None}
        result_receipts = []
        for index, phase in enumerate(({}, {'functionalCasesStarted': False},
                                       {'functionalCasesStarted': True}, {'functionalCasesStarted': True})):
            request = {**self.request, 'packetSha256': str(index + 1) * 64}
            identity = self.register(request)
            self.repo.claim(identity)
            self.remote.inspect.return_value = {'phase': 'terminal', 'result': {
                **outcome, **phase, 'driverSha256': str(index + 1) * 64,
            }}
            self.service.execute(identity)
            receipt = self.repo.get(identity)['result']
            self.assertEqual(receipt['result'].get('functionalCasesStarted'), phase.get('functionalCasesStarted'))
            result_receipts.append(receipt)
        setup, setup_again, functional, functional_again = result_receipts
        self.assertEqual(setup['fingerprint'], setup_again['fingerprint'])
        self.assertNotEqual(setup['fingerprint'], functional['fingerprint'])
        self.assertEqual(functional['fingerprint'], functional_again['fingerprint'])
        self.assertNotEqual(functional['receiptSha256'], functional_again['receiptSha256'])
        self.assertEqual([x['newEvidence'] for x in result_receipts], [True, False, True, False])
        self.assertEqual(self.native.notify.call_count, 4)
        self.remote.stage.assert_not_called()
        self.remote.launch.assert_not_called()

    def test_recovers_pre_upgrade_functional_receipt_without_wake_or_rewrite(self):
        self.profile['setupContainment'] = {'required': True}
        outcome = {'status': 'failed', 'kind': 'reviewed_controller', 'cleanupComplete': False,
                   'auditComplete': False, 'functionalCasesStarted': True}
        request = self.request
        identity = self.register()
        self.repo.claim(identity)
        old = self.repo.terminal(identity, {
            'jobId': identity, 'companyId': request['companyId'], 'projectId': request['projectId'],
            'issueId': request['taskId'], 'agentId': request['agentId'], 'profile': request['profile'],
            'status': outcome['status'], 'receiptSha256': digest(outcome),
            'fingerprint': digest({k: v for k, v in outcome.items() if k != 'functionalCasesStarted'}),
            'result': outcome,
        })
        self.repo.acknowledge(identity, old['receiptSha256'])
        self.remote.inspect.return_value = {'phase': 'terminal', 'result': outcome}

        self.service.execute(identity)

        saved = self.repo.get(identity)
        self.assertEqual(saved['state'], 'quarantined')
        self.assertEqual(saved['result'], old)
        self.assertEqual(self.repo.pending(), [])
        self.native.notify.assert_not_called()
        self.remote.launch.assert_not_called()

    def test_pre_upgrade_functional_failure_suppresses_equivalent_new_job(self):
        self.profile['setupContainment'] = {'required': True}
        outcome = {'status': 'failed', 'kind': 'reviewed_controller', 'cleanupComplete': True,
                   'auditComplete': False, 'functionalCasesStarted': True}
        request = self.request
        identity = self.register()
        self.repo.claim(identity)
        legacy = self.repo.terminal(identity, {
            'jobId': identity, 'companyId': request['companyId'], 'projectId': request['projectId'],
            'issueId': request['taskId'], 'agentId': request['agentId'], 'profile': request['profile'],
            'status': outcome['status'], 'receiptSha256': digest(outcome),
            'fingerprint': digest({k: v for k, v in outcome.items() if k != 'functionalCasesStarted'}),
            'result': outcome,
        })
        next_id = self.register({**request, 'packetSha256': 'c' * 64})
        self.repo.claim(next_id)
        self.remote.inspect.return_value = {'phase': 'terminal', 'result': {**outcome, 'driverSha256': 'a' * 64}}
        self.service.execute(next_id)
        current = self.repo.get(next_id)['result']
        self.assertNotEqual(legacy['fingerprint'], current['fingerprint'])
        self.assertFalse(current['newEvidence'])
        self.assertEqual(self.repo.get(identity)['result'], legacy)
        self.remote.launch.assert_not_called()

    def test_ambiguous_launch_transport_waits_then_read_only_reconciles_without_a_wake(self):
        identity = self.register()
        self.remote.launch.side_effect = Refusal('remote_transport_unconfirmed')
        self.service.execute(identity)
        self.assertEqual(self.repo.get(identity)['state'], 'launching')
        self.assertIsNone(self.repo.get(identity)['result'])
        self.native.notify.assert_not_called()
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

    def test_transient_native_read_before_staging_remains_queued_without_provider_wake(self):
        identity = self.register()
        self.service.source_settled.side_effect = RuntimeError('native_read_unavailable')
        self.service.execute(identity)
        self.assertEqual(self.repo.get(identity)['state'], 'queued')
        self.assertIsNone(self.repo.get(identity)['result'])
        self.remote.stage.assert_not_called()
        self.native.notify.assert_not_called()

    def test_source_wait_and_pause_are_nonblocking_preexecution_waits(self):
        from contracts import AdmissionWait
        for error in [AdmissionWait('job_source_run_not_settled'), Refusal('job_native_pause_hold')]:
            value = {**self.request, 'packetSha256': ('b' if isinstance(error, AdmissionWait) else 'c') * 64}
            identity = self.register(value)
            self.service.source_settled.side_effect = error
            self.service.execute(identity)
            self.assertEqual(self.repo.get(identity)['state'], 'queued')
        self.remote.launch.assert_not_called()
        self.native.notify.assert_not_called()

    def test_staged_recovery_revalidates_whole_review_before_launch(self):
        identity = self.register()
        self.repo.claim(identity)
        self.remote.inspect.return_value = {'phase': 'staged'}
        self.service.admission.controller.side_effect = Refusal('job_review_target_superseded')
        self.service.execute(identity)
        self.remote.launch.assert_not_called()
        self.assertEqual(self.repo.get(identity)['state'], 'terminal')
        self.assertFalse(self.repo.get(identity)['result']['result']['executionStarted'])

    def test_two_physical_slots_do_not_inherit_each_others_quarantine(self):
        identity = self.register()
        self.repo.claim(identity)
        second = {**self.request, 'profile': 'other', 'packetSha256': 'c' * 64}
        other = self.repo.register(second, 'policy', 'other-physical-slot')[0]
        self.assertEqual(self.repo.ownership_holds(other), [])

    def test_active_remote_observation_returns_without_busy_poll_or_new_launch(self):
        identity = self.register()
        self.repo.claim(identity)
        self.remote.inspect.return_value = {'phase': 'attempted'}
        self.service.execute(identity)
        self.remote.inspect.assert_called_once()
        self.remote.launch.assert_not_called()
        self.assertEqual(self.repo.get(identity)['state'], 'launching')

    def test_lost_inspection_during_two_same_task_jobs_never_blocks_cancels_or_wakes(self):
        for index in range(2):
            identity = self.register({**self.request, 'packetSha256': str(index + 1) * 64})
            self.repo.claim(identity)
            self.remote.inspect.side_effect = Refusal('remote_transport_unconfirmed')
            self.service.execute(identity)
            saved = self.repo.get(identity)
            self.assertEqual(saved['state'], 'launching')
            self.assertEqual(saved['wait_code'], 'remote_observation_pending')
            self.assertIsNone(saved['result'])
            self.remote.cancel.assert_not_called()
            self.native.notify.assert_not_called()
            self.remote.inspect.side_effect = None
            self.terminal()
            self.service.execute(identity)
            self.assertEqual(self.repo.get(identity)['state'], 'terminal')
            self.native.notify.reset_mock()
        self.remote.launch.assert_not_called()

    def test_missing_privilege_acceptance_does_not_download_or_parse_packet(self):
        from contracts import AdmissionWait
        identity = self.register()
        self.service.admission.root_approval.side_effect = AdmissionWait('job_root_template_not_accepted')
        self.service.execute(identity)
        self.service.load_packet.assert_not_called()
        self.assertEqual(self.repo.get(identity)['state'], 'queued')
        self.native.notify.assert_not_called()

    def test_lost_cancel_is_confirmed_only_after_positive_remote_ack(self):
        identity = self.register(); self.repo.claim(identity)
        self.remote.inspect.return_value = {'phase': 'attempted'}
        self.service.admission.binding.side_effect = Refusal('job_native_pause_hold')
        self.remote.cancel.side_effect = [Refusal('remote_transport_unconfirmed'), {'cancellationRequested': True}]
        self.service.execute(identity)
        self.assertEqual(self.repo.get(identity)['cancel_requested'], 0)
        self.assertIsNone(self.repo.get(identity)['result'])
        self.service.execute(identity)
        self.assertEqual(self.repo.get(identity)['cancel_requested'], 1)
        self.service.execute(identity)
        self.assertEqual(self.remote.cancel.call_count, 2)
        self.native.notify.assert_not_called()
        self.remote.launch.assert_not_called()

    def test_incomplete_cleanup_artifact_transport_never_invents_unknown_result(self):
        for index, code in enumerate(['artifact_transport_unconfirmed', 'artifact_transport_digest_mismatch']):
            identity = self.register({**self.request, 'packetSha256': str(index + 1) * 64}); self.repo.claim(identity)
            self.remote.inspect.return_value = {'phase': 'terminal', 'result': {'status': 'failed', 'kind': 'reviewed_controller',
                'cleanupComplete': False, 'artifacts': [{'sha256': 'c' * 64}]}}
            self.remote.artifact.side_effect = Refusal(code)
            self.service.execute(identity)
            self.assertEqual(self.repo.get(identity)['state'], 'launching')
            self.assertIsNone(self.repo.get(identity)['result'])
            self.native.notify.assert_not_called()
            self.remote.launch.assert_not_called()

    def test_positive_cleanup_and_audit_are_real_gate_progress_not_duplicate_failure(self):
        self.profile['setupContainment'] = {'required': True}
        identity = self.register()
        first = {'status': 'failed', 'kind': 'reviewed_controller', 'code': 'fixture_failed',
                 'cleanupComplete': False, 'auditComplete': False}
        self.service.finish(identity, self.request, first)
        original = self.repo.get(identity)['result']
        self.service.finish(identity, self.request, {**first, 'cleanupComplete': True, 'auditComplete': True})
        updated = self.repo.get(identity)['result']
        self.assertNotEqual(original['fingerprint'], updated['fingerprint'])
        self.assertTrue(updated['newEvidence'])
        self.assertEqual(self.repo.get(identity)['state'], 'terminal')
        self.remote.launch.assert_not_called()


    def test_missing_remote_readiness_never_claims_an_execution_or_wakes_an_agent(self):
        self.profile['setupContainment'] = {'required': True}
        self.remote.readiness.return_value = {'ready': False, 'code': 'setup_readiness_not_accepted'}
        identity = self.register()
        with patch('supervision_policy.SetupOwnership.from_plan'):
            self.service.execute(identity)
        saved = self.repo.get(identity)
        self.assertEqual(saved['state'], 'queued')
        self.assertEqual(saved['wait_code'], 'runner_setup_readiness_pending')
        self.assertIsNone(saved['result'])
        self.remote.launch.assert_not_called()
        self.native.notify.assert_not_called()

    def test_invalid_setup_registration_waits_before_staging_or_attempt(self):
        self.profile['setupContainment'] = {'required': True}
        identity = self.register()
        with patch('supervision_policy.SetupOwnership.from_plan', side_effect=Refusal('setup_account_invalid')):
            self.service.execute(identity)
        self.assertEqual(self.repo.get(identity)['state'], 'queued')
        self.assertEqual(self.repo.get(identity)['wait_code'], 'runner_setup_configuration_invalid')
        self.remote.stage.assert_not_called()
        self.remote.launch.assert_not_called()
        self.native.notify.assert_not_called()

    def test_legacy_profile_keeps_its_previous_failure_fingerprint(self):
        identity = self.register()
        first = {'status': 'failed', 'kind': 'reviewed_controller', 'code': 'fixture_failed',
                 'cleanupComplete': False, 'auditComplete': False}
        self.service.finish(identity, self.request, first)
        original = self.repo.get(identity)['result']
        self.service.finish(identity, self.request, {**first, 'cleanupComplete': True, 'auditComplete': True})
        self.assertEqual(original['fingerprint'], self.repo.get(identity)['result']['fingerprint'])
        self.assertFalse(self.repo.get(identity)['result']['newEvidence'])
