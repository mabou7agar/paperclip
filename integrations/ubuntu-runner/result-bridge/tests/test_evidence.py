import hashlib
import json
import pathlib
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'broker'))
from evidence import case_failure_summary, inventory, descriptors
from contracts import Refusal


class EvidenceTests(unittest.TestCase):
    def test_exports_only_bound_public_manifest_bytes_and_rejects_tampering(self):
        with tempfile.TemporaryDirectory() as directory:
            owner = pathlib.Path(directory)
            root = owner / 'evidence-snapshots' / '20261115T120000Z-1234abcd'
            public = root / 'public' / 'ui'
            public.mkdir(parents=True)
            image = public / 'synthetic.png'
            image.write_bytes(b'\x89PNG\r\n\x1a\nsynthetic')
            image.chmod(0o600)
            sha = hashlib.sha256(image.read_bytes()).hexdigest()
            manifest = root / 'manifest.json'
            manifest.write_text(json.dumps({'candidate': 'f' * 40, 'continuationId': 'example-q1',
                'private': {'credentials': {}}, 'public': {'ui/synthetic.png': {'sha256': sha, 'bytes': image.stat().st_size}}}))
            manifest.chmod(0o600)
            packet = SimpleNamespace(trial={'ownerRoot': str(owner), 'continuationId': 'example-q1'},
                directory='qualification-q1', json=lambda _: {'candidate': 'f' * 40})
            driver = {'receiptSnapshots': [{'id': root.name, 'manifestSha256': hashlib.sha256(manifest.read_bytes()).hexdigest()}]}
            # Non-root local test filesystem stands in for root-owned retained
            # evidence. Production checks never accept this override.
            with patch('evidence.private_bytes') as read:
                read.side_effect = lambda path, _root, _limit: path.read_bytes()
                entries = inventory(packet, driver)
                self.assertEqual(descriptors(entries)[0]['sha256'], sha)
                self.assertNotIn('_file', descriptors(entries)[0])
                self.assertEqual(len(entries), 1)
                image.write_bytes(b'changed')
                with self.assertRaises(Refusal): inventory(packet, driver)

    def test_projects_only_a_bound_closed_failure_and_does_not_export_private_records(self):
        with tempfile.TemporaryDirectory() as directory:
            owner = pathlib.Path(directory)
            root = owner / 'evidence-snapshots' / '20261120T120000Z-1234abcd'
            private = root / 'private'
            private.mkdir(parents=True)
            packet = SimpleNamespace(trial={'ownerRoot': str(owner), 'continuationId': 'example-q1'},
                directory='qualification-q1', json=lambda _: {'candidate': 'f' * 40})
            driver = {'wholePacketSha256': 'a' * 64}
            receipt = {'schema': 'osa480-private-case-failure.v1', 'public': False, 'candidate': 'f' * 40,
                'continuationId': 'example-q1', 'jobId': 'test-job', 'admissionSha256': 'b' * 64,
                'wholePacketSha256': 'a' * 64, 'outcome': 'collected', 'runId': 'fixture', 'sourceSha256': 'd' * 64}
            first_failure = {'caseId': 'private-case-name', 'substep': 'phase-assertions', 'status': 'failed',
                'category': 'OTHER', 'oracleCode': None, 'assertionId': None}
            diagnostic = {'schema': 'osa480-safe-case-diagnostics.v1', 'candidate': 'f' * 40, 'kind': 'ui',
                'outcomes': [first_failure, first_failure]}

            def write_record(name, value):
                raw = json.dumps(value).encode()
                (private / name).write_bytes(raw)
                return {'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}

            def write_snapshot():
                report = write_record('case-outcomes-ui.json', diagnostic)
                receipt.update(report)
                receipts = {'case-outcomes-ui.json': report,
                    'case-failure-receipt.json': write_record('case-failure-receipt.json', receipt)}
                manifest = json.dumps({'candidate': 'f' * 40, 'continuationId': 'example-q1',
                    'private': receipts, 'public': {}}).encode()
                (root / 'manifest.json').write_bytes(manifest)
                driver['receiptSnapshots'] = [{'id': root.name, 'manifestSha256': hashlib.sha256(manifest).hexdigest()}]

            with patch('evidence.private_bytes', side_effect=lambda path, _owner, _limit: path.read_bytes()):
                write_snapshot()
                self.assertEqual(case_failure_summary(packet, driver, 'test-job', 'a' * 64, 'b' * 64),
                    {'stage': 'phase-assertions', 'category': 'OTHER'})
                self.assertEqual(inventory(packet, driver), {})
                self.assertIsNone(case_failure_summary(packet, driver, 'different-job', 'a' * 64, 'b' * 64))
                self.assertIsNone(case_failure_summary(packet, driver, 'test-job', 'a' * 64, 'c' * 64))
                self.assertIsNone(case_failure_summary(packet, driver, 'test-job', 'd' * 64, 'b' * 64))
                receipt['outcome'] = 'refused'
                write_snapshot()
                self.assertIsNone(case_failure_summary(packet, driver, 'test-job', 'a' * 64, 'b' * 64))
                receipt['outcome'] = 'collected'
                write_snapshot()
                (private / 'case-outcomes-ui.json').write_text('{}')
                self.assertIsNone(case_failure_summary(packet, driver, 'test-job', 'a' * 64, 'b' * 64))
                first_failure['category'] = 'private-string'
                write_snapshot()
                self.assertIsNone(case_failure_summary(packet, driver, 'test-job', 'a' * 64, 'b' * 64))
