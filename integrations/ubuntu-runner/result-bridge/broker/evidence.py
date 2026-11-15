"""Export only root-retained, manifest-approved synthetic public evidence.

Private logs, credentials, database values and raw browser diagnostics are never
exported. This reader cannot execute candidate code or discover arbitrary paths.
"""
import hashlib
import pathlib
import re
import stat
from contracts import require, closed_json

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


def inventory(packet, driver):
    owner = pathlib.Path(packet.trial['ownerRoot'])
    entries = {}
    total = 0
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


def descriptors(entries):
    return [{k: v for k, v in entry.items() if k != '_file'} for entry in entries.values()]
