"""Exercise engine state/delivery without a host daemon or candidate execution.

The current-user temporary filesystem stands in for root-owned storage in this
local suite. Linux ownership and service acceptance remain separate checks.
"""
import base64
import json
import pathlib
import sys
import tempfile
import unittest
import uuid
from types import SimpleNamespace
from unittest.mock import Mock, patch
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'broker'))
import remote_worker as worker
from contracts import closed_json


class RemoteWorkerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.state = pathlib.Path(self.temp.name)
        self.identity = str(uuid.uuid4())
        self.root = self.state / 'jobs' / self.identity
        self.root.mkdir(parents=True, mode=0o700)
        self.plan = {'jobId': self.identity, 'request': {'kind': 'control_checks', 'packetSha256': 'a' * 64},
                     'profile': {}, 'admission': {'controlDigest': 'c' * 64}}
        (self.root / 'plan.json').write_text(json.dumps(self.plan));(self.root / 'plan.json').chmod(0o600)
        (self.root / 'packet.tar.gz').write_bytes(b'synthetic-reviewed-data')
        self.patches = [patch.object(worker, 'STATE', self.state), patch.object(worker, 'trusted_root', side_effect=lambda _: None),
            patch.object(worker, 'read_json', side_effect=lambda path, limit=131072: closed_json(path.read_bytes()))]
        for item in self.patches: item.start()

    def tearDown(self):
        for item in reversed(self.patches): item.stop()
        self.temp.cleanup()

    def test_exclusive_attempt_survives_repeated_dispatch_without_second_execution(self):
        outcome = {'status': 'passed', 'kind': 'control_checks', 'cleanupComplete': True}
        with patch.object(worker, 'Packet', return_value=Mock()), patch.object(worker, 'control_checks', return_value=outcome) as execute:
            first = worker.run(self.identity)
            second = worker.run(self.identity)
            self.assertEqual(first, second)
            self.assertEqual(execute.call_count, 1)
            self.assertTrue((self.root / 'attempt.json').exists())

    def test_pending_systemd_unit_is_not_mistaken_for_unlaunched_staging(self):
        with patch.object(worker.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout=b'LoadState=loaded\nSubState=start\n')):
            self.assertEqual(worker.inspect(self.identity)['phase'], 'submitted')
        with patch.object(worker.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout=b'LoadState=not-found\nSubState=dead\n')):
            self.assertEqual(worker.inspect(self.identity)['phase'], 'staged')

    def test_failed_unit_before_marker_is_definite_nonexecution_not_quarantine(self):
        with patch.object(worker.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout=b'LoadState=loaded\nSubState=failed\n')):
            value = worker.inspect(self.identity)['result']
            self.assertFalse(value['executionStarted'])
            self.assertTrue(value['cleanupComplete'])

    def test_cancel_targets_only_the_known_unit_through_its_cleanup_stop_policy(self):
        with patch.object(worker.subprocess, 'run', return_value=SimpleNamespace(returncode=0)) as call:
            self.assertTrue(worker.cancel(self.identity)['cancellationRequested'])
            self.assertEqual(call.call_args.args[0], ['systemctl', 'stop', '--no-block', 'paperclip-runner-job-' + self.identity])

    def test_systemd_launch_is_nonblocking_and_pending_unit_is_not_launched_twice(self):
        with patch.object(worker, 'inspect', return_value={'phase': 'staged'}), patch.object(worker.subprocess, 'run', return_value=SimpleNamespace(returncode=0)) as call:
            self.assertEqual(worker.launch(self.identity)['phase'], 'submitted')
            self.assertIn('--no-block', call.call_args.args[0])
            self.assertIn('--property=Type=oneshot', call.call_args.args[0])
            self.assertIn('--property=TimeoutStartSec=2140', call.call_args.args[0])
            self.assertIn('--property=Restart=no', call.call_args.args[0])
            self.assertNotIn('--property=RuntimeMaxSec=2140', call.call_args.args[0])
            self.assertEqual(call.call_args.kwargs['timeout'], 20)
        with patch.object(worker, 'inspect', return_value={'phase': 'submitted'}), patch.object(worker.subprocess, 'run') as call:
            self.assertEqual(worker.launch(self.identity)['phase'], 'submitted')
            call.assert_not_called()

    def test_positive_independent_setup_cleanup_settles_missing_driver_without_inventing_pass(self):
        value = {'jobId': self.identity, 'cleanupComplete': True, 'auditComplete': False, 'executionRepeated': False}
        (self.root / 'ownership-final.json').write_text(json.dumps(value))
        packet = SimpleNamespace(trial={'driverReceiptPath': str(self.state / 'missing-driver.json')})
        result = worker.controller_result({'jobId': self.identity}, packet, None)
        self.assertEqual(result['status'], 'failed')
        self.assertTrue(result['cleanupComplete'])
        self.assertFalse(result['auditComplete'])
        self.assertNotIn('featurePassed', result)


    def test_readiness_is_a_read_only_pre_attempt_wait_when_measurements_are_missing(self):
        self.plan['request']['kind'] = 'reviewed_controller'
        self.plan['profile']['setupContainment'] = {'required': True}
        (self.root / 'plan.json').write_text(json.dumps(self.plan))
        with patch.object(worker, 'Packet'), patch('supervision_policy.SetupOwnership.from_plan'), \
             patch('ownership_ledger.measurement', side_effect=FileNotFoundError):
            self.assertFalse(worker.readiness(self.identity)['ready'])
        self.assertFalse((self.root / 'attempt.json').exists())
        self.assertFalse((self.root / 'ownership-lease.json').exists())
        self.assertEqual(worker.readiness.__name__, 'readiness')

    def test_legacy_profile_still_requires_audit_to_release_reconciliation(self):
        self.plan['request']['kind'] = 'reviewed_controller'
        (self.root / 'plan.json').write_text(json.dumps(self.plan))
        (self.root / 'attempt.json').write_text('{}')
        outcome = {'status': 'failed', 'cleanupComplete': True, 'auditComplete': False}
        with patch.object(worker, 'Packet'), patch.object(worker, 'controller_result', return_value=outcome), \
             patch.object(worker.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout=b'dead')):
            self.assertEqual(worker.inspect(self.identity)['phase'], 'attempted')
        self.assertFalse((self.root / 'reconciled.json').exists())
