"""Cancel only this qualification's tagged read-only MySQL sleep sessions.

No DDL, account/schema creation, application query or candidate test. A second
root-session tag is a negative control owned and cleaned by this qualification.
"""
import concurrent.futures
import json
import os
import pathlib
import sys
import tempfile
import time
import uuid
from types import SimpleNamespace
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'broker'))
from owned_resources import OwnedResourceRepository
from mysql_connections import MysqlConnectionRepository
from managed_mysql import ManagedMysqlService
from contracts import Refusal

if len(sys.argv)!=3 or os.getuid()!=0:raise RuntimeError('Explicit registered-host operator context required')
identity='sql-registry-qualification-'+uuid.uuid4().hex
spec=SimpleNamespace(runner=sys.argv[1],mysql=sys.argv[2],run_id=identity,account='pcqual'+uuid.uuid4().hex[:12])
other=SimpleNamespace(**{**vars(spec),'run_id':identity+'-control'})
receipt={'passed':False,'databaseMutations':0,'applicationQueries':0,'applicationTests':0,'providers':0}
with tempfile.TemporaryDirectory(prefix='pc-sql-registry-') as first, tempfile.TemporaryDirectory(prefix='pc-sql-registry-') as second:
    for root in [first,second]:pathlib.Path(root).chmod(0o700)
    owned=OwnedResourceRepository(spec,registry=MysqlConnectionRepository(first))
    control=OwnedResourceRepository(other,registry=MysqlConnectionRepository(second))
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        futures=[pool.submit(ManagedMysqlService(value,value.registry).execute,b'SELECT SLEEP(30);',40)
                 for value in [owned,control]]
        try:
            deadline=time.monotonic()+10
            while not owned.sessions() or not control.sessions():
                for future in futures:
                    if future.done():future.result()
                if time.monotonic()>deadline:raise RuntimeError('Registered read-only sessions did not start')
                time.sleep(.05)
            control_ids=control.sessions()
            owned.cancel_sessions()
            if owned.sessions() or control.sessions()!=control_ids or futures[1].done():
                raise RuntimeError('Connection registry was not isolated')
            try:futures[0].result(timeout=5)
            except Refusal as error:
                if error.code!='managed_mysql_failed':raise
            else:raise RuntimeError('Cancelled sleep unexpectedly passed')
            receipt.update(passed=True,registeredBeforeSql=True,ownedSessionTerminated=True,controlRootSessionUnaffected=True,
                           performanceSchemaRequired=False,killGuard='durable-id-plus-fresh-selector-in-nonreconnecting-session')
        finally:
            for repository in [owned,control]:repository.cancel_sessions()
            for future in futures:
                try:future.result(timeout=5)
                except Refusal:pass
            receipt['qualificationSessionsStopped']=not owned.sessions() and not control.sessions()
print(json.dumps(receipt))
