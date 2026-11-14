#!/usr/bin/env python3
"""Stop only the installed ownership guard; never an app or provider process."""
import json
import os
import signal
import time
from pathlib import Path
from configuration import load
from processes import matches


if os.getuid() != 0 or 'SUDO_UID' in os.environ:
    raise SystemExit('Operator only.')
config = load()
path = Path(config['state_root']) / 'server.json'
if path.exists():
    record = json.loads(path.read_text())
    if matches(record, {'uid': 0}):
        args = (Path('/proc') / str(record['pid']) / 'cmdline').read_bytes().split(b'\0')
        if b'/opt/paperclip-ubuntu-runner/preview/server.py' not in args:
            raise SystemExit('Guard identity mismatch.')
        descriptor = os.pidfd_open(record['pid'])
        try:
            if not matches(record, {'uid': 0}):
                raise SystemExit('Guard identity changed before stop.')
            signal.pidfd_send_signal(descriptor, signal.SIGTERM)
        finally:
            os.close(descriptor)
        for _ in range(100):
            if not matches(record, {'uid': 0}):
                break
            time.sleep(.1)
        else:
            raise SystemExit('Guard did not stop; inspect without restarting tasks.')
