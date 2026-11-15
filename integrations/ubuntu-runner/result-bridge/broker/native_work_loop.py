"""Native producer hints and recovery deadlines for concrete unsettled jobs."""
import os
import pathlib
import select
import socket
import stat
from contracts import require, Refusal

NATIVE_WAKE_SOCKET = '/opt/paperclip-runner-wake/wake.sock'


class NativeHintInbox:
    """Public one-byte hints. No payload can select work or convey authority."""
    def __init__(self, path=NATIVE_WAKE_SOCKET):
        self.path=pathlib.Path(path)
        for parent in self.path.parents:
            info=parent.lstat()
            require(stat.S_ISDIR(info.st_mode) and not parent.is_symlink() and
                    info.st_uid==0 and not info.st_mode&0o022,'native_hint_parent_untrusted')
        if self.path.exists():
            info=self.path.lstat()
            require(stat.S_ISSOCK(info.st_mode) and info.st_uid==0,'native_hint_path_untrusted')
            self.path.unlink() # Caller already owns the shared broker lifetime lock.
        self.socket=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
        self.socket.bind(str(self.path));self.path.chmod(0o622)
        self.socket.listen(16);self.socket.setblocking(False)

    def wait(self, timeout):
        if not select.select([self.socket],[],[],timeout)[0]:return False
        for _ in range(128):
            try:
                client,_=self.socket.accept();client.close()
            except BlockingIOError:break
        return True

    def close(self):
        self.socket.close();self.path.unlink(missing_ok=True)


class NativeWorkLoop:
    def __init__(self, transport, service):
        self.transport,self.service=transport,service
        self.scan_required=True

    def reconcile(self):
        retry=False
        if self.scan_required:
            try:
                self.transport.receive();self.scan_required=False
            except Refusal as error:
                # Disabled/reinstalled plugins need a new native startup hint.
                # A transport failure instead retains a concrete unread intent.
                retry=error.code!='native_plugin_binding_unavailable'
            except Exception:retry=True
        try:
            self.service.recover()
            if self.transport.ledger.pending_admissions() or self.service.repository.pending():
                self.transport.deliver()
        except Exception:retry=True
        pending=bool(self.transport.ledger.pending_admissions() or self.service.repository.pending() or
                     self.service.repository.unfinished())
        # No configured/retained-history idle queries. An actual external job,
        # lost delivery or unresolved native read owns this recovery deadline.
        return 15 if retry or pending else None

    def run(self,inbox):
        while True:
            timeout=self.reconcile()
            if inbox.wait(timeout):self.scan_required=True
