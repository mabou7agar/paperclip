"""Bounded subprocess capture with owned-process-group cancellation.

No raw process output is written to the operator filesystem. Termination first
allows the reviewed controller's finally/cleanup to settle; unresolved cleanup
is never labelled complete by this utility.
"""
import hashlib
import os
import selectors
import signal
import subprocess
import tempfile
import time


def capture(args, *, input_bytes=b'', cwd=None, env=None, timeout=120, limit=32768, grace=20):
    streams = {name: {'bytes': 0, 'sha256': hashlib.sha256(), 'retained': bytearray(), 'overflow': False}
               for name in ['stdout', 'stderr']}
    timed_out = False
    cancelled = False
    with tempfile.TemporaryFile() as source:
        source.write(input_bytes)
        source.seek(0)
        process = subprocess.Popen(args, stdin=source, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   cwd=cwd, env=env, start_new_session=True)
        deadline = time.monotonic() + timeout
        stopping = False
        def stop():
            nonlocal stopping, deadline
            if not stopping:
                stopping = True
                deadline = time.monotonic() + grace
                try: os.killpg(process.pid, signal.SIGINT)
                except ProcessLookupError: pass
        with selectors.DefaultSelector() as selector:
            for name in streams:
                selector.register(getattr(process, name), selectors.EVENT_READ, name)
            try:
                while selector.get_map() or process.poll() is None:
                    if time.monotonic() >= deadline:
                        if stopping:
                            try: os.killpg(process.pid, signal.SIGKILL)
                            except ProcessLookupError: pass
                            deadline = float('inf')
                        else:
                            timed_out = True
                            stop()
                    for key, _ in selector.select(0.1):
                        chunk = os.read(key.fileobj.fileno(), 8192)
                        if not chunk:
                            selector.unregister(key.fileobj)
                            key.fileobj.close()
                            continue
                        stream = streams[key.data]
                        stream['bytes'] += len(chunk)
                        stream['sha256'].update(chunk)
                        stream['retained'].extend(chunk[:max(0, limit - len(stream['retained']))])
                        if stream['bytes'] > limit:
                            stream['overflow'] = True
                            stop()
            except BaseException:
                cancelled = True
                stop()
                try: process.wait(timeout=grace)
                except subprocess.TimeoutExpired:
                    try: os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError: pass
                    process.wait(timeout=5)
                raise
            finally:
                for name in streams:
                    getattr(process, name).close()
                if process.poll() is None:
                    try: os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError: pass
                    process.wait(timeout=5)
        exit_code = process.wait(timeout=5)
    return {'exit': exit_code, 'timedOut': timed_out, 'cancelled': cancelled,
            **{name: {**value, 'sha256': value['sha256'].hexdigest(), 'retained': bytes(value['retained'])}
               for name, value in streams.items()}}
