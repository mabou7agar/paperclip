import pathlib
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'broker'))
from control_runner import remove_owned_control, reconcile_control, lookup_control
import json
from contracts import Refusal, digest


class ControlCleanupTests(unittest.TestCase):
    def test_cleanup_checks_labels_before_removing_any_container(self):
        plan = {'jobId': 'owned'}
        for identity in [{'job': 'foreign', 'plan': digest(plan)}, {'job': 'owned', 'plan': 'foreign'}]:
            with patch('control_runner.lookup_control', return_value=identity), patch('control_runner.subprocess.run') as run:
                with self.assertRaises(Refusal): remove_owned_control('paperclip-controls-owned', plan)
                run.assert_not_called()

    def test_lost_removal_response_is_confirmed_by_absence_not_exit_code(self):
        plan = {'jobId': 'owned'}
        with patch('control_runner.lookup_control', side_effect=[{'job': 'owned', 'plan': digest(plan)}, None]), \
             patch('control_runner.subprocess.run', return_value=SimpleNamespace(returncode=1)) as run:
            remove_owned_control('paperclip-controls-owned', plan)
            run.assert_called_once()

    def test_terminated_unit_gets_one_owned_cleanup_without_repeating_its_test(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            plan = {'jobId': 'owned'}
            def marker(path, value):
                with path.open('x') as out: out.write('marker')
            with patch('control_runner.lookup_control', return_value={'job': 'owned', 'plan': digest(plan)}), \
                 patch('control_runner.remove_owned_control') as remove:
                value = reconcile_control(root, plan, marker)
                self.assertTrue(value['cleanupComplete'])
                self.assertEqual(value['testOutcome'], 'unavailable')
                second = reconcile_control(root, plan, marker)
                self.assertEqual(second['status'], 'unknown')
                remove.assert_called_once()

    def test_absent_owned_container_reconciles_after_lost_cleanup_ack(self):
        with patch('control_runner.lookup_control', return_value=None), patch('control_runner.remove_owned_control') as remove:
            value = reconcile_control(pathlib.Path('/unused'), {'jobId': 'owned'}, lambda *_: None)
            self.assertEqual(value['status'], 'failed')
            self.assertTrue(value['cleanupComplete'])
            remove.assert_not_called()


class ControlIdentityTests(unittest.TestCase):
    def test_inspect_template_separates_go_function_from_parenthesized_argument(self):
        with patch('control_runner.subprocess.run', return_value=SimpleNamespace(returncode=0, stdout=b'{"job":"owned"}')) as run:
            self.assertEqual(lookup_control('paperclip-controls-owned')['job'], 'owned')
            template = run.call_args.args[0][-2]
            self.assertIn('{{json (index .Config.Labels "paperclip.runner.job")}}', template)
            self.assertNotIn('json(', template)

    def test_daemon_failure_is_not_absence(self):
        with patch('control_runner.subprocess.run', return_value=SimpleNamespace(returncode=1, stdout=b'')):
            with self.assertRaises(Refusal): lookup_control('paperclip-controls-owned')

    def test_healthy_exact_name_empty_query_confirms_absence(self):
        with patch('control_runner.subprocess.run', side_effect=[SimpleNamespace(returncode=1, stdout=b''), SimpleNamespace(returncode=0, stdout=b'')]) as run:
            self.assertIsNone(lookup_control('paperclip-controls-owned'))
            self.assertIn('name=^/paperclip-controls-owned$', run.call_args.args[0])

    def test_preserved_pass_is_returned_only_after_owned_cleanup(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory); plan = {'jobId':'owned'}
            facts = {'status':'passed','kind':'control_checks','cleanupComplete':False,'auditComplete':True}
            with patch('control_runner.lookup_control', return_value={'job':'owned','plan':digest(plan)}), \
                 patch('control_runner.recover_completion', return_value=facts), \
                 patch('control_runner.remove_owned_control') as remove:
                value = reconcile_control(root, plan, lambda p,v:p.write_text(json.dumps(v)))
                remove.assert_called_once()
                self.assertEqual(value['status'],'passed')
                self.assertTrue(value['cleanupComplete'])
                self.assertFalse(value['executionRepeated'])
                self.assertTrue(value['recoveredCompletion'])

    def test_failed_cleanup_cannot_turn_retained_pass_into_completion(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch('control_runner.lookup_control', return_value={'job':'owned'}), \
                 patch('control_runner.recover_completion', return_value={'status':'passed'}), \
                 patch('control_runner.remove_owned_control', side_effect=Refusal('control_cleanup_not_confirmed')):
                with self.assertRaises(Refusal):reconcile_control(pathlib.Path(directory),{'jobId':'owned'},lambda p,v:p.write_text('marker'))
