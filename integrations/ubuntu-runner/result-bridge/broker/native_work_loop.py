"""Native commit events and recovery deadlines for concrete unsettled jobs."""
from contracts import Refusal


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
                # Disabled/reinstalled plugins wait for a native readiness/state commit event.
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
