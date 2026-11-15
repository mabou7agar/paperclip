import pathlib
import sys
import unittest
from unittest.mock import Mock

sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'broker'))
from native_work_loop import NativeWorkLoop
from contracts import Refusal


class Finished(Exception):pass


class NativeWorkLoopTest(unittest.TestCase):
    def fixture(self):
        transport=Mock();service=Mock()
        transport.ledger.pending_admissions.return_value=[];transport.ledger.has_pending_hints.return_value=False
        service.repository.pending.return_value=[];service.repository.unfinished.return_value=[]
        return transport,service,NativeWorkLoop(transport,service)

    def test_configured_idle_or_completed_history_waits_without_recurring_native_reads(self):
        for retained_history in [False,True]:
            transport,service,loop=self.fixture()
            service.repository.get.return_value={'state':'terminal','delivered':True} if retained_history else None
            inbox=Mock()
            def wait(timeout):
                self.assertIsNone(timeout)
                self.assertEqual(transport.receive.call_count,1)
                self.assertEqual(service.recover.call_count,1)
                raise Finished()
            inbox.wait.side_effect=wait
            with self.assertRaises(Finished):loop.run(inbox)
            transport.deliver.assert_not_called()

    def test_first_producer_reactivates_and_only_unsettled_job_owns_recovery_deadline(self):
        transport,service,loop=self.fixture();inbox=Mock();waits=[]
        def wait(timeout):
            waits.append(timeout)
            if len(waits)==1:
                service.repository.unfinished.return_value=[('job','launching')]
                return True
            if len(waits)==2:
                service.repository.unfinished.return_value=[]
                return False
            raise Finished()
        inbox.wait.side_effect=wait
        with self.assertRaises(Finished):loop.run(inbox)
        self.assertEqual(waits,[None,15,None])
        self.assertEqual(transport.receive.call_count,2)

    def test_unsettled_read_is_retried_but_disabled_idle_plugin_waits_for_native_startup(self):
        transport,service,loop=self.fixture()
        transport.receive.side_effect=RuntimeError('native response unavailable')
        self.assertEqual(loop.reconcile(),15)
        transport.receive.side_effect=None
        self.assertIsNone(loop.reconcile())
        transport,service,loop=self.fixture()
        transport.receive.side_effect=Refusal('native_plugin_binding_unavailable')
        self.assertIsNone(loop.reconcile())


if __name__=='__main__':unittest.main()
