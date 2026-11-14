#!/usr/bin/env python3
"""Wait passively for this runner's Docker start event; no task/agent retries."""
import datetime
import json
import re
import subprocess
import sys

name = sys.argv[1]
assert re.fullmatch(r'[a-zA-Z0-9_.-]+', name)
since = datetime.datetime.now(datetime.timezone.utc).isoformat()


def running():
    result = subprocess.run(['docker', 'inspect', '--format', '{{.State.Running}}', name],
                            capture_output=True, text=True, timeout=10)
    return result.returncode == 0 and result.stdout.strip() == 'true'


if not running():
    events = subprocess.Popen(['docker', 'events', '--since', since, '--filter', 'type=container',
                               '--filter', 'event=start', '--format', '{{json .}}'],
                              stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    try:
        for line in events.stdout:
            event = json.loads(line)
            if event.get('Actor', {}).get('Attributes', {}).get('name') == name and running():
                break
        else:
            raise SystemExit('Docker event stream ended before the runner started.')
    finally:
        events.terminate()
        try:
            events.wait(timeout=5)
        except subprocess.TimeoutExpired:
            events.kill(); events.wait(timeout=5)
