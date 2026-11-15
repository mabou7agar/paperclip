"""Native producer hints and recovery deadlines for concrete unsettled jobs."""
import pathlib
import socket
import stat
import threading
from contracts import closed_json
from authentication import authenticate_control_hint_peer
from contracts import require, Refusal

NATIVE_WAKE_SOCKET = '/opt/paperclip-runner-wake/wake.sock'


class NativeHintInbox:
    """Kernel-bound intent hints. IDs retain uncertainty, never execution authority."""
    def __init__(self, ledger, companies, path=NATIVE_WAKE_SOCKET, peer_uid=1000, peer_profile="paperclip-control"):
        self.ledger,self.companies=ledger,companies
        self.peer_uid,self.peer_profile=peer_uid,peer_profile
        self.event=threading.Event();self.stopped=threading.Event();self.last_refusal_code=None
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
        self.socket.listen(16)
        self.thread=threading.Thread(target=self.receive,daemon=True);self.thread.start()

    def receive(self):
        while not self.stopped.is_set():
            try:
                client,_=self.socket.accept()
            except OSError:
                if self.stopped.is_set():return
                self.stopped.set();self.event.set();return
            with client:
                try:
                    client.settimeout(1)
                    authenticate_control_hint_peer(client,self.peer_uid,self.peer_profile)
                    raw=b''
                    while b'\n' not in raw and len(raw)<=1024:
                        block=client.recv(1025-len(raw))
                        require(bool(block),'native_hint_truncated');raw+=block
                    require(raw.endswith(b'\n') and len(raw)<=1024 and raw.count(b'\n')==1,'native_hint_frame_invalid')
                    value=closed_json(raw)
                    if value is not None:self.ledger.retain_hint(value,self.companies)
                    # ACK only after synchronous durable SQLite commit. A hint
                    # never grants execution; the native state still must match.
                    self.event.set();client.sendall(b'1');self.last_refusal_code=None
                except Exception as error:
                    self.last_refusal_code=error.code if isinstance(error,Refusal) else type(error).__name__+(":"+str(error.errno) if isinstance(error,OSError) else "")
                    try:client.sendall(b'0')
                    except OSError:pass


    def wait(self, timeout):
        received=self.event.wait(timeout)
        if received:self.event.clear()
        require(not self.stopped.is_set(),"native_hint_listener_unavailable")
        return received

    def close(self):
        self.stopped.set()
        try:self.socket.shutdown(socket.SHUT_RDWR)
        except OSError:pass
        self.socket.close();self.thread.join(timeout=2);self.path.unlink(missing_ok=True)


class NativeWorkLoop:
    def __init__(self, transport, service):
        self.transport,self.service=transport,service
        self.scan_required=True

    def reconcile(self):
        retry=False
        if self.scan_required or self.transport.ledger.has_pending_hints():
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
        pending=bool(self.transport.ledger.has_pending_hints() or self.transport.ledger.pending_admissions() or self.service.repository.pending() or
                     self.service.repository.unfinished())
        # No configured/retained-history idle queries. An actual external job,
        # lost delivery or unresolved native read owns this recovery deadline.
        return 15 if retry or pending else None

    def run(self,inbox):
        while True:
            timeout=self.reconcile()
            if inbox.wait(timeout):self.scan_required=True
