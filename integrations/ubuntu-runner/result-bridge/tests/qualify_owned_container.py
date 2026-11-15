"""Explicit operator qualification of tagged-process ownership on the real host.

Takes one registered runner and its database container name. Starts only fixed
synthetic sleep processes, no app/DB/test packet or native provider work. The
same-UID foreign-tag control belongs to this qualification and is cleaned too.
"""
import dataclasses
import json
import os
import pathlib
import signal
import subprocess
import sys
import time
import uuid
from types import SimpleNamespace
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'broker'))
from owned_resources import OwnedResourceRepository

if len(sys.argv) != 3 or os.getuid() != 0:raise RuntimeError('Explicit registered-container operator context required')
uid, gid = 1001, 999
identity = 'ownership-qualification-' + uuid.uuid4().hex
spec = SimpleNamespace(runner=sys.argv[1], mysql=sys.argv[2], uid=uid, gid=gid, run_id=identity)
control_spec = SimpleNamespace(**{**vars(spec), 'run_id': identity + '-control'})
owned, control = OwnedResourceRepository(spec), OwnedResourceRepository(control_spec)
if owned.processes() or control.processes():raise RuntimeError('New qualification tag already exists')
started=[];receipt={'passed':False,'applicationTests':0,'databaseQueries':0,'providers':0,'imagesBuilt':0}
try:
    code = 'import subprocess,sys,time;subprocess.Popen([sys.executable,"-I","-B","-c","import time;time.sleep(30)"],start_new_session=True);time.sleep(30)'
    for value, command in [(spec, code), (control_spec, 'import time;time.sleep(30)')]:
        subprocess.run(['docker','exec','--detach','--user',str(uid)+':'+str(gid),'--env','PAPERCLIP_RUNNER_JOB='+value.run_id,
            value.runner,'python3','-I','-B','-c',command],check=True,timeout=15,capture_output=True)
        started.append(value.run_id)
    deadline=time.monotonic()+5
    while len(owned.processes())<2 or len(control.processes())<1:
        if time.monotonic()>=deadline:raise RuntimeError('Tagged process group did not start')
        time.sleep(.05)
    original_control=control.processes()
    if owned.processes(cancel=True):raise RuntimeError('Owned group is still active')
    stable=lambda rows: {(row['pid'],row['startTicks'],row['pgid']) for row in rows}
    if stable(control.processes())!=stable(original_control):raise RuntimeError('Same-UID control was affected')
    receipt.update(passed=True,effectiveUid=uid,effectiveGid=gid,ownedChildrenTerminated=True,
                   unrelatedSameUidUnaffected=True,signalIdentity='host-cgroup-pidfd',leaseReset=False)
finally:
    for value, resources in [(spec,owned),(control_spec,control)]:
        if value.run_id in started:
            if resources.processes(cancel=True):raise RuntimeError('Qualification cleanup incomplete')
    receipt['qualificationProcessesStopped']=True
    print(json.dumps(receipt))
