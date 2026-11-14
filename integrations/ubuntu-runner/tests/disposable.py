"""Refuse destructive installation fixtures outside an isolated test container."""
import os
from pathlib import Path


def assert_disposable():
    assert os.getuid() == 0 and os.environ.get('PAPERCLIP_DISPOSABLE_BOUNDARY') == '1'
    mounts = []
    for line in Path('/proc/self/mountinfo').read_text().splitlines():
        columns = line.split(); mount = columns[4]
        assert '\\' not in mount
        assert mount in ['/', '/candidate', '/preview-state', '/etc/hostname', '/etc/hosts', '/etc/resolv.conf'] or any(
            mount == root or mount.startswith(root + '/') for root in ['/proc', '/sys', '/dev']
        ), 'Unexpected mount in destructive fixture.'
        mounts.append((mount, columns[5], line.split(' - ', 1)[1].split()[0]))
    assert any(p == '/candidate' and 'ro' in flags.split(',') for p, flags, _ in mounts)
    assert any(p == '/preview-state' and kind == 'tmpfs' for p, _, kind in mounts)
    assert {p.name for p in Path('/sys/class/net').iterdir()} == {'lo'}, 'Require Docker network=none.'
    limit = Path('/sys/fs/cgroup/memory.max').read_text().strip()
    assert limit.isdigit() and int(limit) <= 1024 ** 3, 'Require a bounded disposable memory cgroup.'
