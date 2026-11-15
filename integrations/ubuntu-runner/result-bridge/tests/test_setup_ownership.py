"""Tools-only ownership checks; no live app, database, provider or Docker fixture."""
import dataclasses
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import time
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'broker'))
from contracts import Refusal
from owned_resources import PROCESS_READER, OwnedResourceRepository
from ownership_ledger import OwnershipLedger
from setup_supervisor import SetupSupervisorService, driver_alive
from test_supervision_policy import fixture
from supervision_policy import SetupOwnership


class ResourceBindingTests(unittest.TestCase):
    def test_restart_is_rejected_before_signalling_a_new_container(self):
        plan, packet = fixture();spec = SetupOwnership.from_plan(plan, packet)
        with patch.object(OwnedResourceRepository, 'container_binding', side_effect=[['one', 'start1'], ['two', 'start1']]):
            resources = OwnedResourceRepository(spec)
        with patch.object(resources, 'container_binding', return_value=['one', 'start2']), patch('owned_resources.subprocess.run') as run:
            with self.assertRaisesRegex(Refusal, 'setup_container_restarted'):resources.processes(cancel=True)
            run.assert_not_called()


@unittest.skipUnless(sys.platform == 'linux' and os.getuid() == 0, 'real Linux root qualification only')
class LinuxOwnershipTests(unittest.TestCase):
    def test_lease_is_immutable_and_cannot_restart_its_deadline(self):
        with tempfile.TemporaryDirectory() as root:
            pathlib.Path(root).chmod(0o700);ledger = OwnershipLedger(root)
            ledger.once('ownership-lease.json', {'startedUnix': 100, 'expiresUnix': 1900})
            with self.assertRaises(FileExistsError):ledger.once('ownership-lease.json', {'startedUnix': 200, 'expiresUnix': 2000})
            self.assertEqual(ledger.read('ownership-lease.json'), {'startedUnix': 100, 'expiresUnix': 1900})

    def test_template_failure_still_cancels_and_cleans_owned_partial_setup(self):
        plan, packet = fixture()
        with tempfile.TemporaryDirectory() as root:
            root = pathlib.Path(root);root.chmod(0o700)
            spec = dataclasses.replace(SetupOwnership.from_plan(plan, packet), owner_root=str(root / 'owner'))
            owner = pathlib.Path(spec.owner_root);owner.mkdir(mode=0o700)
            (owner/'ledger.json').write_text('{}');(owner/'ledger.json').chmod(0o600)
            service = object.__new__(SetupSupervisorService)
            service.root, service.plan, service.packet, service.spec = root, plan, packet, spec
            service.packet.directory = 'qualification-example'
            service.ledger = OwnershipLedger(root)
            service.resources = Mock();service.resources.processes.return_value = []
            service.stop_host_work = Mock()
            with patch('setup_supervisor.capture', side_effect=RuntimeError('driver template failed')):
                outcome = service.cleanup()
            self.assertTrue(outcome['cleanupComplete'])
            self.assertFalse(outcome['auditComplete'])
            self.assertFalse(outcome['executionRepeated'])
            service.resources.remove_databases.assert_called_once()
            service.resources.private_runtime.assert_called_once_with(erase=True)
            first = (root/'ownership-final.json').read_bytes()
            self.assertEqual(service.cleanup(), outcome)
            self.assertEqual((root/'ownership-final.json').read_bytes(), first)
            service.resources.remove_databases.assert_called_once()


class HostQuiescenceTests(unittest.TestCase):
    def test_oneshot_exited_does_not_prove_its_children_are_gone(self):
        service = object.__new__(SetupSupervisorService)
        service.spec = SimpleNamespace(job_id='12345678-1234-1234-1234-123456789abc')
        unit = 'paperclip-runner-job-' + service.spec.job_id
        group = '/system.slice/' + unit + '.service'
        result = SimpleNamespace(returncode=0, stdout=group.encode())
        with patch('setup_supervisor.subprocess.run', return_value=result), \
             patch('setup_supervisor.pathlib.Path.exists', return_value=True), \
             patch('setup_supervisor.pathlib.Path.read_text', return_value='populated 1\nfrozen 0\n'):
            self.assertFalse(service.host_work_empty())
        with patch('setup_supervisor.subprocess.run', return_value=result), \
             patch('setup_supervisor.pathlib.Path.exists', return_value=True), \
             patch('setup_supervisor.pathlib.Path.read_text', return_value='populated 0\nfrozen 0\n'):
            self.assertTrue(service.host_work_empty())

    def test_foreign_cgroup_cannot_be_selected_by_a_unit_response(self):
        service = object.__new__(SetupSupervisorService)
        service.spec = SimpleNamespace(job_id='12345678-1234-1234-1234-123456789abc')
        with patch('setup_supervisor.subprocess.run', return_value=SimpleNamespace(returncode=0, stdout=b'/system.slice/foreign.service')):
            with self.assertRaisesRegex(Refusal, 'setup_host_group_identity_changed'):
                service.host_work_empty()

    def test_reused_or_zombie_driver_is_not_kept_alive(self):
        lease = {'driverPid': 123, 'driverStartTicks': 456}
        with patch('setup_supervisor.process_identity', return_value=457):
            self.assertFalse(driver_alive(lease))
        with patch('setup_supervisor.process_identity', side_effect=Refusal('setup_supervisor_identity_invalid')):
            self.assertFalse(driver_alive(lease))
