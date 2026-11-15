"""Prove scrubbed child/exec detection without killing unconfirmed ownership.

Only fixed synthetic sleeps on an explicitly approved runner. No application,
SQL, provider, candidate packet, image build or production operation.
"""
import json,os,pathlib,subprocess,sys,tempfile,time,uuid
from types import SimpleNamespace
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'broker'))
from owned_resources import OwnedResourceRepository
from mysql_connections import MysqlConnectionRepository
from contracts import require

if len(sys.argv)!=3 or sys.platform!='linux' or os.getuid()!=0:raise RuntimeError('Explicit Linux registered-runner operator required')
runner,mysql=sys.argv[1:];tag='untagged-qual-'+uuid.uuid4().hex
spec=SimpleNamespace(runner=runner,mysql=mysql,uid=1001,gid=999,run_id=tag,account='uncreated_qual_account')
control=SimpleNamespace(**{**vars(spec),'run_id':tag+'-control'})
receipt={'passed':False,'cases':[],'applicationTests':0,'databaseQueries':0,'providers':0,'imagesBuilt':0}
foreign=OwnedResourceRepository(control)
subprocess.run(['docker','exec','--detach','--user','1001:999','--env','PAPERCLIP_RUNNER_JOB='+control.run_id,runner,'python3','-I','-B','-c','import time;time.sleep(40)'],check=True,capture_output=True,timeout=15)
try:
 deadline=time.monotonic()+5
 while not foreign.processes():
  require(time.monotonic()<deadline,'qualification_control_not_started');time.sleep(.05)
 for kind,code in [('scrubbed-child','import subprocess,sys,time;subprocess.Popen([sys.executable,"-I","-B","-c","import time;time.sleep(5)"],env={});time.sleep(20)'),
                   ('exec-drops-tag','import os,sys;os.execve(sys.executable,[sys.executable,"-I","-B","-c","import time;time.sleep(5)"],{})')]:
  with tempfile.TemporaryDirectory(prefix='pc-untagged-lease-') as root:
   pathlib.Path(root).chmod(0o700);registry=MysqlConnectionRepository(root)
   registry.ledger.once('ownership-lease.json',{'containerProcessStartTicks':int(time.clock_gettime(time.CLOCK_BOOTTIME)*os.sysconf('SC_CLK_TCK'))})
   resources=OwnedResourceRepository(spec,registry=registry)
   subprocess.run(['docker','exec','--detach','--user','1001:999','--env','PAPERCLIP_RUNNER_JOB='+tag,runner,'python3','-I','-B','-c',code],check=True,capture_output=True,timeout=15)
   deadline=time.monotonic()+3
   while not any(row['ownership']=='unconfirmed' for row in resources.processes()):
    require(time.monotonic()<deadline,'scrubbed_process_was_falsely_absent');time.sleep(.025)
   remaining=resources.processes(cancel=True)
   require(any(row['ownership']=='unconfirmed' for row in remaining),'cleanup_falsely_proved_absence')
   require(bool(foreign.processes()),'unrelated_prelease_control_was_affected')
   deadline=time.monotonic()+8
   while resources.processes():
    require(time.monotonic()<deadline,'qualification_sleep_did_not_end');time.sleep(.1)
   receipt['cases'].append({'case':kind,'passed':True,'unconfirmedProcessNotKilled':True,'absenceNotInvented':True,'preleaseControlUnaffected':True})
 receipt['passed']=True
finally:
 foreign.processes(cancel=True)
 receipt['qualificationControlStopped']=not foreign.processes()
 print(json.dumps(receipt))
