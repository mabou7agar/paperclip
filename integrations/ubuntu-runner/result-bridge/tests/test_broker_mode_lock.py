"""Both actual serve branches retain the same state lock across their lifetime."""
import multiprocessing
import pathlib
import socket
import sys
import tempfile
import unittest
from unittest.mock import Mock,patch

sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'broker'))


def hold_mode(root,mode,connection,release):
    import server
    real_require=server.require
    def fixture_require(value,code):
        # This current-user fixture tests locking, not privileged ownership.
        if code=='broker_socket_parent_untrusted':return
        real_require(value,code)
    def hold(*_args,**_kwargs):
        connection.send('entered');release.wait(10)
    config={'stateRoot':str(pathlib.Path(root)/'state'),'socketPath':str(pathlib.Path(root)/'ipc/broker.sock'),
            'socketGid':0}
    if mode=='native':config['nativeQueue']={'fixture':True}
    try:
        with patch.object(server,'require',fixture_require),patch.object(server,'NativeRepository'),\
                patch.object(server,'RemoteRepository'),patch.object(server,'JobService',return_value=Mock()),\
                patch.object(server,'serve_native',side_effect=hold),\
                patch.object(server.Server,'serve_forever',hold),patch.object(server.os,'chown'):
            server.serve(config)
    except BlockingIOError:connection.send('blocked')
    except Exception as error:connection.send(type(error).__name__)
    finally:connection.close()


class BrokerModeLockTest(unittest.TestCase):
    def test_both_startup_orders_keep_other_mode_out_of_shared_ledger(self):
        ctx=multiprocessing.get_context('fork')
        for first,second in [('legacy','native'),('native','legacy')]:
            with self.subTest(first=first),tempfile.TemporaryDirectory() as directory:
                root=pathlib.Path(directory).resolve()
                (root/'state').mkdir(mode=0o700);(root/'ipc').mkdir(mode=0o700)
                release=ctx.Event();a,child_a=ctx.Pipe(False);b,child_b=ctx.Pipe(False)
                one=ctx.Process(target=hold_mode,args=(str(root),first,child_a,release));two=ctx.Process(target=hold_mode,args=(str(root),second,child_b,release))
                try:
                    one.start();self.assertTrue(a.poll(8));self.assertEqual(a.recv(),'entered')
                    two.start();self.assertTrue(b.poll(8));self.assertEqual(b.recv(),'blocked')
                finally:
                    release.set()
                    for process in [one,two]:
                        if process.pid:
                            process.join(3)
                            if process.is_alive():process.terminate();process.join(3)
                    a.close();b.close();child_a.close();child_b.close()


if __name__=='__main__':unittest.main()
