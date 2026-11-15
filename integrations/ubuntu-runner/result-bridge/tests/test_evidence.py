import hashlib
import json
import pathlib
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'broker'))
from evidence import inventory, descriptors
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
