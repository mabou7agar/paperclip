import hashlib
import io
import json
import pathlib
import sys
import tarfile
import unittest
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'broker'))
from packet import Packet
from contracts import Refusal


def fixture(patch=None, extra=None):
    root = '/tmp/example-owner'
    profile = {'candidate': 'f' * 40, 'authorityRoot': root, 'trialRoot': '/tmp/example-trial',
               'fixedTrialFields': {'uid': 1001}, 'continuationPattern': r'candidate-q[0-9]+',
               'executionIdPattern': r'example-q[0-9]+', 'authoritySchemaTemplate': 'example-{key}-verified.v2'}
    trial = {'uid': 1001, 'ownerRoot': root + '/qualification-candidate-q1', 'driverReceiptPath': root + '/q1-driver-attempt.json',
             'runtimeReceiptRoot': root + '/q1-host-receipts', 'externalAuthorityPath': root + '/q1-verified-authority.json',
             'preexecutionAdmissionPath': root + '/q1-preexecution-admission.json', 'caseArchivePath': root + '/q1-approved-cases.tar.gz',
             'caseRoot': '/tmp/example-trial/reviewed-q1-cases', 'authoritySchema': 'example-q1-verified.v2',
             'continuationId': 'candidate-q1', 'operatorExecutionId': 'example-q1'}
    profile['fixedTrialFields'].update(continuationAttempt=1, maxContinuationAttempts=1)
    trial.update(continuationAttempt=1, maxContinuationAttempts=1)
    if patch: trial.update(patch)
    files = {'qualification-q1/trial.json': json.dumps(trial).encode(),
             'qualification-q1/candidate.json': json.dumps({'candidate': 'f' * 40}).encode(),
             'qualification-q1/scope-contract.json': json.dumps({'authoritySchema': 'example-q1-verified.v2'}).encode(),
             'q1-cases-v1.tar.gz': b'opaque-reviewed-cases'}
    manifest = {name: {'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()} for name, raw in files.items()}
    files.update({'manifest.json': json.dumps({'files': manifest}).encode(), 'SHA256SUMS': b'index'})
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode='w:gz') as archive:
        for name, raw in files.items():
            info = tarfile.TarInfo(name);info.size = len(raw);archive.addfile(info, io.BytesIO(raw))
        if extra:
            extra(archive)
    raw = stream.getvalue()
    return raw, hashlib.sha256(raw).hexdigest(), profile


class PacketTests(unittest.TestCase):
    def test_exact_inventory_and_fixed_runtime_paths_are_required_before_import(self):
        raw, sha, profile = fixture()
        value = Packet(raw, sha, profile)
        self.assertEqual(value.directory, 'qualification-q1')
        for patch in [{'ownerRoot': '/etc'}, {'uid': 0}, {'extraPrivilege': True}, {'continuationAttempt': 2},
                      {'operatorExecutionId': 'other-q1'}]:
            with self.subTest(patch=patch), self.assertRaises(Refusal): Packet(*fixture(patch))

    def test_links_duplicate_paths_and_parent_escape_are_refused(self):
        for name, kind in [('../escape', tarfile.REGTYPE), ('link', tarfile.SYMTYPE),
                           ('qualification-q1/./trial.json', tarfile.REGTYPE)]:
            def extra(archive):
                info = tarfile.TarInfo(name);info.type = kind;info.linkname = '/private'
                archive.addfile(info, io.BytesIO(b''))
            with self.subTest(name=name), self.assertRaises(Refusal): Packet(*fixture(extra=extra))

    def test_member_count_stops_streaming_before_collecting_unbounded_headers(self):
        def extra(archive):
            for index in range(5001): archive.addfile(tarfile.TarInfo('empty-' + str(index)), io.BytesIO(b''))
        with self.assertRaisesRegex(Refusal, 'packet_member_limit'): Packet(*fixture(extra=extra))

    def test_changed_packet_digest_is_refused(self):
        raw, sha, profile = fixture()
        with self.assertRaises(Refusal): Packet(raw + b'changed', sha, profile)
