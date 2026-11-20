"""Export only root-retained, manifest-approved synthetic public evidence.

The public exporter never reads private data. The separate failure summary
projects only bounded, manifest-bound diagnostic categories and stage codes.
"""
import hashlib
import pathlib
import re
import stat
from contracts import Refusal, require, closed_json

LIMIT = 32 * 1024 * 1024
KINDS = {'png': 'image/png', 'webm': 'video/webm', 'json': 'application/json'}


def private_bytes(path, root, limit):
    require(path.is_relative_to(root), 'evidence_outside_root')
    for component in [path, *path.parents]:
        require(not component.is_symlink(), 'evidence_symlink')
        if component == root: break
    st = path.lstat()
    require(stat.S_ISREG(st.st_mode) and st.st_uid == 0 and stat.S_IMODE(st.st_mode) == 0o600 and
            0 < st.st_size <= limit, 'evidence_file_untrusted')
    return path.read_bytes()


def verified_snapshots(packet, driver):
    owner = pathlib.Path(packet.trial['ownerRoot'])
    snapshots = driver.get('receiptSnapshots', [])
    require(isinstance(snapshots, list) and len(snapshots) <= 16, 'evidence_snapshots_invalid')
    for snapshot in snapshots:
        require(re.fullmatch(r'[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}', snapshot['id']), 'evidence_snapshot_invalid')
        root = owner / 'evidence-snapshots' / snapshot['id']
        raw = private_bytes(root / 'manifest.json', owner, 2 * 1024 * 1024)
        require(hashlib.sha256(raw).hexdigest() == snapshot['manifestSha256'], 'evidence_manifest_changed')
        manifest = closed_json(raw)
        require(manifest['candidate'] == packet.json(packet.directory + '/candidate.json')['candidate'] and
                manifest['continuationId'] == packet.trial['continuationId'] and len(manifest['public']) <= 256,
                'evidence_manifest_scope_changed')
        yield owner, root, manifest


def inventory(packet, driver):
    entries = {}
    total = 0
    for owner, root, manifest in verified_snapshots(packet, driver):
        for name, expected in manifest['public'].items():
            require(re.fullmatch(r'(oauth|ui|context|context-setup|diagnostic)/[A-Za-z0-9_-]+\.(png|webm|json)', name),
                    'evidence_name_invalid')
            path = root / 'public' / name
            raw = private_bytes(path, owner, LIMIT)
            require(len(raw) == expected['bytes'] and hashlib.sha256(raw).hexdigest() == expected['sha256'],
                    'evidence_bytes_changed')
            kind = path.suffix[1:]
            require(kind != 'png' or raw.startswith(b'\x89PNG\r\n\x1a\n'), 'evidence_png_invalid')
            require(kind != 'webm' or raw.startswith(b'\x1a\x45\xdf\xa3'), 'evidence_video_invalid')
            total += len(raw)
            require(total <= 256 * 1024 * 1024, 'evidence_total_too_large')
            # A digest selects immutable bytes, never an arbitrary filesystem path.
            entries[expected['sha256']] = {'sha256': expected['sha256'], 'bytes': len(raw), 'kind': kind,
                'fileName': name.replace('/', '-'), '_file': path}
    return entries


CASE_FAILURE_CATEGORIES = frozenset({
    'ORACLE_SCHEMA', 'ORACLE_SCOPE', 'ORACLE_SECRET', 'ASSERTION',
    'TIMEOUT', 'TRANSPORT', 'OTHER', 'NOT_RUN', 'NONE',
})
CASE_FAILURE_STAGES = frozenset({
    'case-action', 'mcp-client-construct', 'mcp-initialize', 'mcp-list-tools-bounded',
    'mcp-context-call', 'mcp-context-contract', 'curl-context', 'bruno-context',
    'mcp-close', 'lifecycle-audit-snapshot', 'lifecycle-audit-verify',
    'lifecycle-client-connect', 'lifecycle-list-tools', 'lifecycle-call',
    'lifecycle-client-close', 'ui-matrix', 'phase-finalize', 'phase-assertions',
    'lifecycle-catalog', 'setup-prerequisites', 'image-upload-not-ready',
})


def private_record(owner, root, manifest, name, limit):
    expected = manifest['private'][name]
    require(isinstance(expected, dict) and set(expected) == {'bytes', 'sha256'},
            'case_failure_inventory_invalid')
    data = private_bytes(root / 'private' / name, owner, limit)
    require(type(expected['bytes']) is int and len(data) == expected['bytes'] and
            hashlib.sha256(data).hexdigest() == expected['sha256'], 'case_failure_inventory_changed')
    return data


def case_failure_classification(value):
    if isinstance(value, dict) and set(value) == {'stage', 'category'}:
        stage, category = value['stage'], value['category']
        if (isinstance(stage, str) and stage in CASE_FAILURE_STAGES and isinstance(category, str) and
                category in CASE_FAILURE_CATEGORIES and category not in ('NONE', 'NOT_RUN')):
            return {'stage': stage, 'category': category}
    return None


def case_failure_summary(packet, driver, job_id, packet_sha, admission_sha):
    try:
        summaries = []
        for owner, root, manifest in verified_snapshots(packet, driver):
            if 'case-failure-receipt.json' not in manifest.get('private', {}):
                continue
            receipt = closed_json(private_record(owner, root, manifest, 'case-failure-receipt.json', 16384))
            require(isinstance(receipt, dict), 'case_failure_receipt_invalid')
            if receipt.get('jobId') != job_id:
                continue
            require(set(receipt) == {
                'schema', 'candidate', 'continuationId', 'runId', 'jobId', 'wholePacketSha256',
                'admissionSha256', 'outcome', 'sourceSha256', 'sha256', 'bytes', 'public',
            } and receipt['schema'] == 'osa480-private-case-failure.v1' and receipt['public'] is False,
                'case_failure_receipt_invalid')
            require(receipt['candidate'] == manifest['candidate'] and receipt['continuationId'] == manifest['continuationId'] and
                    receipt['admissionSha256'] == admission_sha and receipt['wholePacketSha256'] == packet_sha,
                    'case_failure_binding_changed')
            if receipt['outcome'] in ('absent', 'refused'):
                continue
            require(receipt['outcome'] == 'collected', 'case_failure_receipt_invalid')
            data = private_record(owner, root, manifest, 'case-outcomes-ui.json', 131072)
            require(hashlib.sha256(data).hexdigest() == receipt['sha256'] and
                    type(receipt['bytes']) is int and len(data) == receipt['bytes'], 'case_failure_report_changed')
            report = closed_json(data)
            require(isinstance(report, dict) and set(report) == {'schema', 'candidate', 'kind', 'outcomes'} and
                    report['schema'] == 'osa480-safe-case-diagnostics.v1' and report['candidate'] == manifest['candidate'] and
                    report['kind'] == 'ui', 'case_failure_report_invalid')
            rows = report['outcomes']
            require(isinstance(rows, list) and len(rows) <= 512, 'case_failure_rows_invalid')
            first = None
            for row in rows:
                require(isinstance(row, dict) and set(row) == {'caseId', 'substep', 'status', 'category', 'oracleCode', 'assertionId'} and
                        isinstance(row['caseId'], str) and row['status'] in ('started', 'completed', 'failed', 'unproven') and
                        row['category'] in CASE_FAILURE_CATEGORIES and row['substep'] in CASE_FAILURE_STAGES,
                        'case_failure_row_invalid')
                if first is None and row['status'] == 'failed':
                    first = case_failure_classification({'stage': row['substep'], 'category': row['category']})
            if first:
                summaries.append(first)
        if summaries and all(value == summaries[0] for value in summaries):
            return summaries[0]
    except (Refusal, KeyError, TypeError, ValueError, OSError):
        # Missing or malformed optional evidence grants no progress and does
        # not displace the immutable terminal outcome.
        return None
    return None


def descriptors(entries):
    return [{k: v for k, v in entry.items() if k != '_file'} for entry in entries.values()]
