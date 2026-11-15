import json
import pathlib
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'broker'))
from contracts import Refusal
from ownership_result import settle
from setup_supervisor import driver_alive


class OwnershipResultTests(unittest.TestCase):
    def test_live_cleanup_holds_delivery_without_starting_a_provider_or_job(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory).resolve()
            for name, value in [('ownership-lease.json', {}), ('ownership-startup.json', {'supervisorPid': 123, 'supervisorStartTicks': 987})]:
                path = root/name;path.write_text(json.dumps(value));path.chmod(0o600)
            with patch('ownership_result.process_identity', return_value=987):
                self.assertIsNone(settle(root, {'profile': {'setupContainment': {'required': True}}, 'jobId': 'job'}, {'status': 'passed'}))

    def test_stale_supervisor_or_pid_reuse_is_a_closed_failure_not_endless_transport_wait(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory).resolve()
            for name, value in [('ownership-lease.json', {}), ('ownership-startup.json', {'supervisorPid': 123, 'supervisorStartTicks': 987})]:
                path=root/name;path.write_text(json.dumps(value));path.chmod(0o600)
            for value in [988, Refusal('setup_supervisor_identity_invalid')]:
                with patch('ownership_result.process_identity', **({'side_effect':value} if isinstance(value,Exception) else {'return_value':value})):
                    outcome=settle(root, {'profile': {'setupContainment': {'required': True}}, 'jobId':'job'}, {'status':'passed'})
                    self.assertEqual(outcome['status'],'unknown')
                    self.assertFalse(outcome['cleanupComplete'])
        with patch('setup_supervisor.process_identity', side_effect=Refusal('setup_supervisor_identity_invalid')):
            self.assertFalse(driver_alive({'driverPid':123,'driverStartTicks':987}))

    def test_positive_cleanup_preserves_failed_test_and_audit_gap(self):
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory).resolve()
            (root/'ownership-lease.json').write_text('{}')
            path=root/'ownership-final.json';path.write_text(json.dumps({'jobId':'job','executionRepeated':False,'cleanupComplete':True,'auditComplete':False}));path.chmod(0o600)
            outcome=settle(root, {'profile':{'setupContainment':{'required':True}},'jobId':'job'}, {'status':'unknown','auditComplete':False})
            self.assertEqual(outcome['status'],'failed')
            self.assertTrue(outcome['cleanupComplete'])
            self.assertFalse(outcome['auditComplete'])
            self.assertNotIn('featurePassed',outcome)


    def test_failed_cleanup_retains_a_closed_actionable_reason(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            (root / 'ownership-lease.json').write_text('{}')
            final = {'jobId': 'job', 'cleanupComplete': False, 'auditComplete': False,
                     'executionRepeated': False, 'code': 'setup_container_work_still_active'}
            path = root / 'ownership-final.json';path.write_text(json.dumps(final))
            with patch('ownership_result.private_file', side_effect=lambda p: p):
                result = settle(root, {'jobId': 'job', 'profile': {'setupContainment': {'required': True}}}, {'status': 'unknown'})
            self.assertEqual(result['ownerFailureCode'], 'setup_container_work_still_active')
            self.assertFalse(result['cleanupComplete'])
