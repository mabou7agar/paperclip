"""Linux process and listener ownership checks for a registered application."""
import os
from pathlib import Path

LOOPBACK = {'0100007F'}  # The proxy targets this exact IPv4 address.


def identity(pid):
    try:
        path = Path('/proc') / str(int(pid))
        parts = (path / 'stat').read_text().rsplit(')', 1)[1].split()
        if parts[0] == 'Z':
            return None
        return {'pid': int(pid), 'start_identity': parts[19], 'uid': path.stat().st_uid,
                'parent': int(parts[1])}
    except (OSError, ValueError):
        return None


def matches(record, lease):
    current = identity(record['pid'])
    return bool(current and current['start_identity'] == record['start_identity']
                and current['uid'] == lease['uid'])


def listener_matches(record, lease):
    if not matches(record, lease):
        return False
    for table in ('tcp', 'tcp6'):
        for line in (Path('/proc/net') / table).read_text().splitlines()[1:]:
            fields = line.split()
            if fields[3] == '0A' and fields[1].split(':')[0] in LOOPBACK and fields[9] == record['listener_inode'] and int(fields[1].split(':')[1], 16) == record['listener_port']:
                return True
    return False


def listener_identity(record, lease, port):
    # /proc socket access uses the process owner's credentials. A short child
    # drops real/effective IDs, leaving the root controller's privileges intact.
    if os.geteuid() == 0:
        import json
        import pwd
        import subprocess
        import sys
        result = subprocess.run(['/usr/bin/python3', '-E', '-s', '-B', str(Path(__file__).resolve())],
                                input=json.dumps([record, lease, port]), text=True,
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                user=lease['uid'], group=pwd.getpwuid(lease['uid']).pw_gid,
                                extra_groups=[], timeout=5,
                                env={'PATH': '/usr/bin:/bin', 'HOME': '/nonexistent', 'LANG': 'C.UTF-8'})
        return json.loads(result.stdout) if result.returncode == 0 else None
    try:
        cwd = str((Path('/proc') / str(record['pid']) / 'cwd').resolve(strict=True))
        if cwd != lease['workspace'] and not cwd.startswith(lease['workspace'] + '/'):
            return False
        return _listener_identity(record, lease, port)
    except OSError:
        return False


def _listener_identity(record, lease, port):
    if not matches(record, lease):
        return False
    processes = [value for path in Path('/proc').glob('[0-9]*') if (value := identity(path.name))]
    selected = {record['pid']}
    while True:
        children = {value['pid'] for value in processes if value['parent'] in selected}
        if children <= selected:
            break
        selected |= children
    inodes = {}
    for pid in selected:
        try:
            for fd in (Path('/proc') / str(pid) / 'fd').iterdir():
                try:
                    target = str(fd.readlink())
                    if target.startswith('socket:['):
                        inodes[target[8:-1]] = pid
                except OSError:
                    pass
        except OSError:
            pass
    for table in ('tcp', 'tcp6'):
        for line in (Path('/proc/net') / table).read_text().splitlines()[1:]:
            fields = line.split()
            if fields[3] == '0A' and fields[1].split(':')[0] in LOOPBACK and int(fields[1].split(':')[1], 16) == port and fields[9] in inodes:
                return {**identity(inodes[fields[9]]), 'listener_inode': fields[9], 'listener_port': port}
    return None


if __name__ == '__main__':
    import json
    import sys
    record, lease, port = json.load(sys.stdin)
    value = listener_identity(record, lease, port)
    if value:
        print(json.dumps(value))
    sys.exit(0 if value else 1)
