import copy
import pathlib
import sys
import unittest
import uuid
from types import SimpleNamespace
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'broker'))
from supervision_policy import SetupOwnership
from contracts import Refusal


def fixture():
    names = ['trialcentral01', 'trialprimary01', 'trialisolation01']
    profile = {'uid': 1001, 'gid': 999, 'runner': 'registered-runner', 'authorityRoot': '/tmp/private-operator-owner',
        'setupContainment': {'schema': 'registered-setup.v1', 'databases': names, 'account': 'synthetic_trial01',
            'receiptName': 'q1-startup.json', 'evidencePath': '/etc/paperclip-runner-results/measurements.json',
            'evidenceSha256': 'a' * 64, 'privatePaths': ['source/.env', 'home'], 'privateRoot': '/tmp/registered-app'}}
    trial = {'uid': 1001, 'gid': 999, 'runner': 'registered-runner', 'mysql': 'registered-mysql', 'ttlSeconds': 1800,
        'sourceRoot': '/tmp/registered-app/source', 'ownerRoot': '/tmp/private-operator-owner/qualification-run01',
        'operatorExecutionId': 'operator-run01', 'dbUser': 'synthetic_trial01', 'ownedDatabases': list(names)}
    return {'jobId': str(uuid.uuid4()), 'profile': profile}, SimpleNamespace(trial=trial)


class SupervisionPolicyTests(unittest.TestCase):
    def test_one_exact_nonroot_resource_identity_has_a_fixed_unextended_lease(self):
        plan, packet = fixture();value = SetupOwnership.from_plan(plan, packet)
        self.assertEqual(value.databases, tuple(packet.trial['ownedDatabases']))
        self.assertEqual(value.lease_seconds, 1800)
        self.assertEqual(value.receipt_path, '/tmp/private-operator-owner/q1-startup.json')
        self.assertEqual(value.uid, 1001)

    def test_schema_wildcards_foreign_identity_and_lease_extension_are_refused(self):
        changes = [lambda p, t: p['profile']['setupContainment']['databases'].__setitem__(0, 'trial_%'),
            lambda p, t: t.trial['ownedDatabases'].__setitem__(0, 'foreign'),
            lambda p, t: t.trial.update(dbUser='another_account'),
            lambda p, t: t.trial.update(ttlSeconds=3600),
            lambda p, t: t.trial.update(uid=0), lambda p, t: t.trial.update(ownerRoot='/etc'),
            lambda p, t: p['profile']['setupContainment'].update(evidencePath='/tmp/untrusted/evidence.json')]
        for change in changes:
            plan, packet = fixture();change(plan, packet)
            with self.subTest(change=change), self.assertRaises(Refusal): SetupOwnership.from_plan(plan, packet)

    def test_resource_identity_changes_are_not_silently_reused(self):
        plan, packet = fixture();first = SetupOwnership.from_plan(plan, packet)
        second_plan, second_packet = copy.deepcopy((plan, packet))
        second_packet.trial['operatorExecutionId'] = 'operator-run02'
        second = SetupOwnership.from_plan(second_plan, second_packet)
        self.assertNotEqual(first.resource_digest, second.resource_digest)
