"""Private, nonroot, one-shot source qualification. No providers or production mounts."""
from pathlib import Path
import datetime, hashlib, io, json, os, re, stat, subprocess, sys, tarfile
os.umask(0o077)
def assert_controller_binding():
 expected=os.environ.get('PAPERCLIP_OPERATOR_CONTROLLER_SHA256','')
 assert re.fullmatch('[a-f0-9]{64}',expected),'Reviewed controller SHA-256 required'
 assert hashlib.sha256(read_regular_bytes(Path(__file__))).hexdigest()==expected,'Controller binding mismatch'

def assert_container_security(raw):
 host=raw['HostConfig']
 assert raw['Config']['User']=='1000:1000' and host['NetworkMode']=='none' and raw['Mounts']==[]
 assert host['Privileged'] is False and host['CapDrop']==['ALL']
 assert host.get('CapAdd') in (None,[]) and host.get('Devices') in (None,[])
 assert host.get('DeviceRequests') in (None,[]) and host.get('DeviceCgroupRules') in (None,[])
 assert host.get('SecurityOpt') in (['no-new-privileges'],['no-new-privileges:true'])
 assert host.get('PidsLimit')==256
 assert host['Memory']==6*1024**3 and host['NanoCpus']==2000000000

def read_regular_bytes(path):
 # Walk from the filesystem root using directory FDs. Neither a copied leaf
 # symlink nor a copied directory symlink may redirect a host read.
 parts=Path(path).absolute().parts
 fd=os.open(parts[0],os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 try:
  for part in parts[1:-1]:
   next_fd=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
   os.close(fd);fd=next_fd
  leaf=os.open(parts[-1],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd)
  try:
   if not stat.S_ISREG(os.fstat(leaf).st_mode):raise ValueError('Host evidence must be a regular file')
   with os.fdopen(leaf,'rb',closefd=False)as stream:return stream.read()
  finally:os.close(leaf)
 finally:os.close(fd)

def read_regular_text(path):
 return read_regular_bytes(path).decode('utf8')

def assert_regular_tree(path):
 # Refuse links and devices anywhere in a copied tree before publishing it.
 mode=os.lstat(path).st_mode
 if stat.S_ISREG(mode):read_regular_bytes(path);return
 if not stat.S_ISDIR(mode):raise ValueError('Unsafe copied evidence entry')
 with os.scandir(path)as entries:
  for entry in entries:assert_regular_tree(Path(path)/entry.name)

assert_controller_binding()
r=Path(__file__).resolve().parent/'osa465-e3-final-validation'
s=json.loads(read_regular_text(r/'qualification-input.json'))
phase=sys.argv[1]
runtime='/app/server/final-source-runtime'
assert phase in ('provision','finish-provision','build','bundle-output-repair','artifact','native-extra','lifecycle','lifecycle-observer-repair','cleanup')
assert re.fullmatch('[a-f0-9]{40}',s['candidate'])
assert s['baseImage']=='sha256:72bec2367dc13f850f05f4abca4627e90948db99d545408328813ab71b4ea37b'
h=lambda b:hashlib.sha256(b).hexdigest()
manifest_bytes=read_regular_bytes(r/'source-manifest.json');manifest=json.loads(manifest_bytes)
assert h(manifest_bytes)==s['sourceManifestSha256']and manifest['head']==s['candidate']
assert h(read_regular_bytes(r/'source-final.tar'))==s['sourceArchiveSha256']
reader=r.parent/'osa464-isolated-final-validation/accepted-reader-code-only.tar'
assert h(read_regular_bytes(reader))=='c55edff7ab8b991fee2ce4a1a5fd6bd20d16ec113e50834d94322e5cb1f0df13'

def save(name,value):
 with(r/name).open('x')as f:json.dump(value,f,indent=2)
def run(args,**kw):
 return subprocess.run(args,check=True,capture_output=True,timeout=60,**kw)
def ident():return json.loads(read_regular_text(r/'scratch-created.json'))['id']
def security(required_seconds=0,require_running=True):
 c=ident();raw=json.loads(run(['docker','inspect',c]).stdout)[0]
 assert raw['Config']['Labels'].get('paperclip.operator.candidate')==s['candidate']
 if require_running:
  assert raw['State']['Running']
  started=datetime.datetime.fromisoformat(raw['State']['StartedAt'].replace('Z','+00:00'))
  assert (started+datetime.timedelta(seconds=3600)-datetime.datetime.now(datetime.timezone.utc)).total_seconds()>required_seconds+30,'Private scratch lifetime insufficient; freeze, no implicit restart'
 assert_container_security(raw)
 return c

def exec_args(cwd,args,seconds=650,extra=()):
 return ['docker','exec','-u','1000:1000','-w',cwd,security(seconds+25),'/usr/bin/env','-i',
 'PATH=/usr/local/bin:/usr/bin:/bin','HOME=/tmp/final-source-home','COREPACK_ENABLE_NETWORK=0',
 'PAPERCLIP_TYPECHECK_LOW_MEMORY=1','PAPERCLIP_BUILD_COMMIT='+s['candidate'],*extra,
 'timeout','--signal=TERM','--kill-after=5s',str(seconds)+'s',*args]

def verify_source():
 for p in manifest['files']:assert not Path(p).is_absolute()and '..'not in Path(p).parts
 js="const fs=require('node:fs'),c=require('node:crypto'),h=b=>c.createHash('sha256').update(b).digest('hex'),m=JSON.parse(process.argv[1]);for(const[p,d]of Object.entries(m))if(h(fs.readFileSync('/app/'+p))!==d)throw Error(p);const r='/opt/reader/tooling-9c477cebfff7',b=fs.readFileSync(r+'-manifest.json');if(h(b)!=='0024f01f17032a78c99cd2b14c8c58ddf5501025c24e9528e9c448679514b71a')throw Error('manifest');const f=JSON.parse(b).files;for(const p of f)if(h(fs.readFileSync(r+'/'+p.path))!==p.sha256)throw Error(p.path);console.log(JSON.stringify({sourceFiles:Object.keys(m).length,readerFiles:f.length,allHashesMatch:true,uid:process.getuid()}))"
 return json.loads(run(exec_args('/app',['node','-e',js,json.dumps(manifest['files'])],60)).stdout)

def step(receipt,label,cwd,args,seconds=650,extra=()):
 command=exec_args(cwd,args,seconds,extra)
 receipt.write(json.dumps({'phase':'starting','label':label,'candidate':s['candidate'],'container':ident(),'command':command,'at':datetime.datetime.now(datetime.timezone.utc).isoformat()})+'\n');receipt.flush();os.fsync(receipt.fileno())
 code=None;error=None
 with(r/(label+'.log')).open('x')as log:
  try:code=subprocess.run(command,stdout=log,stderr=subprocess.STDOUT,timeout=seconds+25).returncode
  except (subprocess.TimeoutExpired,OSError)as failure:error=type(failure).__name__+': '+str(failure)
 receipt.write(json.dumps({'phase':'terminal','label':label,'candidate':s['candidate'],'container':ident(),'exitCode':code,'error':error,'logSha256':h(read_regular_bytes(r/(label+'.log'))),'at':datetime.datetime.now(datetime.timezone.utc).isoformat()})+'\n');receipt.flush();os.fsync(receipt.fileno())
 assert code==0 and error is None,label+' failed; freeze this step, never replay'

if phase=='provision':
 assert not(r/'scratch-created.json').exists()
 name='paperclip-source-final-'+s['candidate'][:12]
 command=['docker','create','--pull=never','--name',name,'--label','paperclip.operator.candidate='+s['candidate'],'--user','1000:1000','--network','none','--cap-drop','ALL','--security-opt','no-new-privileges','--memory','6g','--cpus','2','--pids-limit','256','--init','--workdir','/app/server','--entrypoint','/usr/bin/env',s['baseImage'],'-i','PATH=/usr/local/bin:/usr/bin:/bin','HOME=/tmp/final-source-home','sh','-c','sleep 3600']
 save('create-started.json',{'command':command,'candidate':s['candidate']})
 c=run(command).stdout.decode().strip();save('scratch-created.json',{'id':c,'candidate':s['candidate']})
 run(['docker','start',c]);security()
 archive=io.BytesIO()
 with tarfile.open(fileobj=archive,mode='w')as dest:
  for filename,prefix in [(r/'source-final.tar','app'),(reader,'opt/reader')]:
   with tarfile.open(filename)as source:
    for m in source:
     assert not m.name.startswith('/')and '..'not in Path(m.name).parts
     if m.isdir():continue
     assert m.isfile();data=source.extractfile(m).read()
     if prefix=='app':assert h(data)==manifest['files'][m.name]
     t=tarfile.TarInfo(prefix+'/'+m.name);t.uid=t.gid=1000;t.mode=0o644;t.size=len(data);dest.addfile(t,io.BytesIO(data))
  t=tarfile.TarInfo('tmp/source-overlay-manifest.json');t.uid=t.gid=1000;t.mode=0o600;t.size=len(manifest_bytes);dest.addfile(t,io.BytesIO(manifest_bytes))
 run(['docker','cp','-a','-',c+':/'],input=archive.getvalue())
 save('source-reader-copy-proof.json',verify_source())
 # Correct inherited generated-output ownership before any compilation. Never
 # change source bytes, permissions, resource caps or production files.
 scan="const fs=require('node:fs'),c=require('node:crypto');const rows=[];function walk(p){for(const e of fs.readdirSync(p,{withFileTypes:true})){const f=p+'/'+e.name,s=fs.lstatSync(f);if(s.isSymbolicLink())throw Error('Generated symlink');if(s.uid===0)rows.push({path:f,directory:s.isDirectory(),mode:s.mode&511,sha256:s.isFile()?c.createHash('sha256').update(fs.readFileSync(f)).digest('hex'):null,size:s.isFile()?s.size:null});if(s.isDirectory())walk(f)}}for(const root of ['/app/server/dist','/app/packages/paperclip-runner/dist']){const st=fs.lstatSync(root);if(st.uid===0)rows.push({path:root,directory:true,mode:st.mode&511,sha256:null,size:null});walk(root)}console.log(JSON.stringify(rows))"
 outputs=json.loads(run(exec_args('/app',['node','-e',scan],60)).stdout);save('generated-ownership-before.json',outputs)
 save('provision-copy-ready.json',{'candidate':s['candidate'],'entriesToNormalize':len(outputs),'noCompilerOrTestStarted':True})
elif phase=='finish-provision':
 security();assert not(r/'provision-result.json').exists()
 outputs=json.loads(read_regular_text(r/'generated-ownership-before.json'));c=ident()
 archive=io.BytesIO();wanted={x['path']:x for x in outputs};content={}
 for root in ['/app/server/dist','/app/packages/paperclip-runner/dist']:
  raw=run(['docker','cp','-a',c+':'+root,'-']).stdout
  with tarfile.open(fileobj=io.BytesIO(raw))as source:
   for m in source:
    parts=Path(m.name).parts
    assert parts and parts[0]=='dist'
    full=root+('/'+'/'.join(parts[1:])if len(parts)>1 else '')
    if full in wanted and not wanted[full]['directory']:
     assert m.isfile();data=source.extractfile(m).read();x=wanted[full]
     assert len(data)==x['size']and h(data)==x['sha256'];content[full]=data
 assert set(content)=={x['path']for x in outputs if not x['directory']}
 with tarfile.open(fileobj=archive,mode='w')as dest:
  for x in sorted(outputs,key=lambda x:(x['path'].count('/'),x['path'])):
   t=tarfile.TarInfo(x['path'].lstrip('/'));t.uid=t.gid=1000;t.mode=x['mode']
   if x['directory']:t.type=tarfile.DIRTYPE;dest.addfile(t)
   else:t.size=len(content[x['path']]);dest.addfile(t,io.BytesIO(content[x['path']]))
 if outputs:run(['docker','cp','-a','-',c+':/'],input=archive.getvalue())
 check="const fs=require('node:fs'),c=require('node:crypto'),rows=JSON.parse(fs.readFileSync(0,'utf8'));for(const x of rows){const s=fs.lstatSync(x.path);if(s.uid!==1000||s.gid!==1000||(s.mode&511)!==x.mode)throw Error(x.path);if(!x.directory){const b=fs.readFileSync(x.path);if(b.length!==x.size||c.createHash('sha256').update(b).digest('hex')!==x.sha256)throw Error(x.path)}}console.log(JSON.stringify({entries:rows.length,bytesUnchanged:true,uid:1000,gid:1000}))"
 save('generated-ownership-proof.json',json.loads(run(['docker','exec','-i','-u','1000:1000',c,'/usr/bin/env','-i','PATH=/usr/local/bin:/usr/bin:/bin','HOME=/nonexistent','node','-e',check],input=json.dumps(outputs).encode()).stdout))
 save('provision-result.json',{'passed':True,'candidate':s['candidate'],'security':{'uid':1000,'network':'none','mounts':0,'memory':6*1024**3,'cpus':2},'copy':verify_source()})
elif phase=='build':
 assert json.loads(read_regular_text(r/'provision-result.json'))['passed'];verify_source()
 assets='mkdir -p dist/onboarding-assets dist/built-ins dist/services/scripts dist/vendor/paperclip-runner && cp -R src/onboarding-assets/. dist/onboarding-assets/ && cp -R src/built-ins/. dist/built-ins/ && cp -R src/services/scripts/. dist/services/scripts/ && cp -Rf ../packages/paperclip-runner/dist/. dist/vendor/paperclip-runner/ && cp ../packages/paperclip-runner/scripts/install-copilot-assets.mjs ../packages/paperclip-runner/scripts/materialize-copilot-binary.mjs ../packages/paperclip-runner/scripts/copilot-inner-distribution.mjs dist/'
 bundle="import {bundleRuntime}from './scripts/bundle-runtime.mjs';const d='/app/server/dist';console.log(JSON.stringify(await bundleRuntime({entry:d+'/index.js',outdir:'/app/server/final-source-runtime',maintenanceEntry:d+'/maintenance/agent-files.js',ephemeralMigrationEntry:d+'/maintenance/ephemeral-migration.js',nativeHarnessPrestageEntry:d+'/maintenance/native-harness-prestage.js',onlineWorkspaceMigrationEntry:d+'/maintenance/online-workspace-migration.js'})));"
 with(r/'native-build-once.jsonl').open('x')as receipt:
  step(receipt,'runner-mechanical-bindings','/app/packages/paperclip-runner',['node','../../scripts/run-tsc.mjs','--noCheck'],350)
  step(receipt,'source-semantic','/app/server',['node','scripts/typecheck-layers.mjs','--declarations-only'])
  step(receipt,'server-emit','/app/server',['env','PAPERCLIP_TSC_EMIT_ONLY=1','node','../scripts/run-tsc.mjs'],350)
  step(receipt,'assets-after-emit','/app/server',['sh','-c',assets],60)
  step(receipt,'build-stamp','/app/server',['node','scripts/write-build-stamp.mjs'],60)
  step(receipt,'normal-runtime-bundle','/app/server',['node','--input-type=module','-e',bundle],350)
 save('build-result.json',{'passed':True,'candidate':s['candidate'],'sourceProof':verify_source(),'runnerEmitOnly':True,'serverSourceSemanticChecked':True})
elif phase=='bundle-output-repair':
 # Check the complete remaining bounded plan BEFORE any marker or metadata mutation.
 security(1800) # 350 bundle +300 extra +650 lifecycle +500 transport/cleanup margin.
 # A changed-metadata repair only; do not repeat successful semantic/emit steps.
 assert not(r/'build-result.json').exists()
 rows=[json.loads(x)for x in read_regular_text(r/'native-build-once.jsonl').splitlines()]
 for label in ['runner-mechanical-bindings','source-semantic','server-emit','assets-after-emit','build-stamp']:
  assert any(x.get('phase')=='terminal'and x.get('label')==label and x.get('exitCode')==0 and x.get('candidate')==s['candidate']for x in rows)
 failure=rows[-1];assert failure['phase']=='terminal'and failure['label']=='normal-runtime-bundle'and failure['exitCode']==1
 assert failure['logSha256']=='08ae79904c53b910d9ccd01b76e6bf75787c0040f84ece1a8e94462df0245faf'
 verify_source()
 inspect="const fs=require('node:fs');const p='/app/server',s=fs.lstatSync(p);if(!s.isDirectory()||s.isSymbolicLink()||fs.existsSync(process.argv[1]))throw Error('Unexpected output/parent');console.log(JSON.stringify({path:p,uid:s.uid,gid:s.gid,mode:s.mode&4095,mtimeNs:fs.lstatSync(p,{bigint:true}).mtimeNs.toString(),names:fs.readdirSync(p).sort()}))"
 before=json.loads(run(exec_args('/app',['node','-e',inspect,runtime],60)).stdout)
 assert before['uid']==0
 save('parent-runtime-output-ownership-started.json',{'candidate':s['candidate'],'before':before,'onlyOwnMountlessPrivateContainer':ident(),'operation':'Metadata-only existing parent uid/gid1000 and directory mtime epoch; source file bytes/modes unchanged, original layout retained','parentDirectoryMtimeResetToEpoch':True,'ctimeMayAlsoAdvanceAsExpectedForMetadataWrites':True})
 archive=io.BytesIO()
 with tarfile.open(fileobj=archive,mode='w')as dest:
  item=tarfile.TarInfo('app/server');item.type=tarfile.DIRTYPE;item.uid=item.gid=1000;item.mode=before['mode'];item.mtime=0;dest.addfile(item)
 run(['docker','cp','-a','-',ident()+':/'],input=archive.getvalue())
 after=json.loads(run(exec_args('/app',['node','-e',inspect,runtime],60)).stdout)
 assert after=={**before,'uid':1000,'gid':1000,'mtimeNs':'0'}
 save('parent-runtime-output-ownership-proof.json',{'before':before,'after':after,'sourceVerification':verify_source(),'runtimeLayoutUnchanged':runtime,'parentDirectoryMtimeResetToEpoch':True,'ctimeMayAlsoAdvanceAsExpectedForMetadataWrites':True})
 check="const fs=require('node:fs');fs.accessSync('/app/server',fs.constants.W_OK);if(fs.existsSync(process.argv[1]))throw Error('Output already exists');console.log('original layout now writable')"
 run(exec_args('/app',['node','-e',check,runtime],60))
 bundle="import {bundleRuntime}from './scripts/bundle-runtime.mjs';const d='/app/server/dist';console.log(JSON.stringify(await bundleRuntime({entry:d+'/index.js',outdir:"+json.dumps(runtime)+",maintenanceEntry:d+'/maintenance/agent-files.js',ephemeralMigrationEntry:d+'/maintenance/ephemeral-migration.js',nativeHarnessPrestageEntry:d+'/maintenance/native-harness-prestage.js',onlineWorkspaceMigrationEntry:d+'/maintenance/online-workspace-migration.js'})));"
 with(r/'bundle-output-repair-once.jsonl').open('x')as receipt:
  step(receipt,'normal-runtime-bundle-corrected-output','/app/server',['node','--input-type=module','-e',bundle],350)
 save('build-result.json',{'passed':True,'candidate':s['candidate'],'sourceProof':verify_source(),'runnerEmitOnly':True,'serverSourceSemanticChecked':True,'retainedSuccessfulStages':'native-build-once.jsonl','metadataOnlyPrivateParentRepair':True,'runtimeLayoutUnchanged':runtime,'priorOutputFailureRetained':True,'originalBuildReceiptSha256':h(read_regular_bytes(r/'native-build-once.jsonl')),'repairReceiptSha256':h(read_regular_bytes(r/'bundle-output-repair-once.jsonl')),'repairLogSha256':h(read_regular_bytes(r/'normal-runtime-bundle-corrected-output.log')),'ownershipProofSha256':h(read_regular_bytes(r/'parent-runtime-output-ownership-proof.json')),'ownershipStartedSha256':h(read_regular_bytes(r/'parent-runtime-output-ownership-started.json'))})
elif phase=='artifact':
 assert json.loads(read_regular_text(r/'build-result.json'))['passed']
 inventory="const fs=require('node:fs'),c=require('node:crypto');const root='/app/server/final-source-runtime';const rows=fs.readdirSync(root).sort().map(path=>{const p=root+'/'+path,st=fs.lstatSync(p);if(!st.isFile()||st.isSymbolicLink())throw Error(path);return{path,bytes:st.size,sha256:c.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}});const chunks=rows.filter(x=>x.path.endsWith('.mjs')&&/if\\s*\\(process\\.argv\\[2\\]\\s*===\\s*[\"']--source-memory-worker[\"']\\)/.test(fs.readFileSync(root+'/'+x.path,'utf8')));if(chunks.length!==1)throw Error('Unique worker chunk required');const p='/app/server/dist/services/source-memory.js';console.log(JSON.stringify({files:rows,workerChunk:chunks[0],serviceSha256:c.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}))"
 data=json.loads(run(exec_args('/app',['node','-e',inventory],60)).stdout);save('runtime-artifact-manifest.json',{'candidate':s['candidate'],**data})
 assert not(r/'runtime-artifact').exists();run(['docker','cp',ident()+':'+runtime,str(r/'runtime-artifact')]);assert_regular_tree(r/'runtime-artifact')
 local=[{'path':p.name,'bytes':p.stat().st_size,'sha256':h(read_regular_bytes(p))}for p in sorted((r/'runtime-artifact').iterdir())]
 assert local==data['files'];save('runtime-artifact-copy-proof.json',{'allFilesCopiedAndHashMatched':True,'fileCount':len(local),'manifestSha256':h(read_regular_bytes(r/'runtime-artifact-manifest.json'))})
elif phase=='native-extra':
 assert json.loads(read_regular_text(r/'build-result.json'))['passed'];verify_source()
 with(r/'native-completion-extra-once.jsonl').open('x')as receipt:
  step(receipt,'native-completion-extra','/app/server',['node','../node_modules/vitest/vitest.mjs','run','src/services/native-runtime/native-source-completion.test.ts','src/services/native-runtime/native-source-completion.integration.test.ts','--maxWorkers=1','--retry=0'],300,('PAPERCLIP_SOURCE_MEMORY_TESTS=1','PAPERCLIP_VITEST_RETRY=0','SOURCE_MEMORY_READER_FIXTURE=/opt/reader/tooling-9c477cebfff7','SOURCE_MEMORY_BUILT_SERVICE=/app/server/dist/services/source-memory.js'))
elif phase in('lifecycle','lifecycle-observer-repair'):
 revised=phase=='lifecycle-observer-repair'
 suffix='-observer-v10'if revised else ''
 if revised:
  history=[json.loads(x)for x in read_regular_text(r/'lifecycle-evidence/receipts.jsonl').splitlines()]
  assert history[-1]['step']=='fixture-cleanup'and history[-1]['cleanupErrors']==[]
  provenance=history[0];actual=json.loads(read_regular_text(r/'runtime-artifact-manifest.json'))
  assert provenance['step']=='provenance'and provenance['helperSha256']=='174a602a63f47809f6ae169e9976ea9c9e5d0cae26f0cb63381bcf7069124c54'and provenance['chunkHash']==actual['workerChunk']['sha256']and provenance['serviceHash']==actual['serviceSha256']
  parentEvents=[json.loads(x)for x in read_regular_text(r/'lifecycle-evidence/phase-parent-events.jsonl').splitlines()]
  assert not any(x.get('kind')in('forbidden-exec','network')for x in parentEvents)
  prior=json.loads(read_regular_text(r/'lifecycle-execution-result.json'));assert prior['exitCode']==1 and prior['copied']=={'helper':True,'reaper':True}
  old=[json.loads(x)for x in read_regular_text(r/'reaper-status.jsonl').splitlines()];assert old[-1]['kind']=='terminal'and old[-1]['mainExitCode']==1 and not old[-1]['forcedCleanup']and old[-1]['interrupted']==[]
  assert old[0]['kind']=='started'and old[0]['helperSha256']==provenance['helperSha256']
  events=[json.loads(x)for x in read_regular_text(r/'lifecycle-evidence/phase-worker.jsonl').splitlines()]
  bad=[x for x in events if x.get('kind')in('forbidden-exec','network')]
  assert len(bad)==1 and bad[0]['kind']=='forbidden-exec'and bad[0]['program']=='getconf'and bad[0]['resolved']=='/usr/bin/getconf'and bad[0]['provider']is False
  origin=json.loads(read_regular_text(r/'getconf-origin-read-only.json'));assert origin['candidate']==s['candidate']and origin['chunkHash']==json.loads(read_regular_text(r/'runtime-artifact-manifest.json'))['workerChunk']['sha256']
  assert (r/'qualify-source-bundle-lifecycle-executed-v9.mjs').exists()and h(read_regular_bytes(r/'qualify-source-bundle-lifecycle-executed-v9.mjs'))=='174a602a63f47809f6ae169e9976ea9c9e5d0cae26f0cb63381bcf7069124c54'
 assert json.loads(read_regular_text(r/'runtime-artifact-copy-proof.json'))['allFilesCopiedAndHashMatched'];verify_source()
 binding=json.loads(read_regular_text(r.parent/('lifecycle-ops-observer-v10-review-binding.json'if revised else 'lifecycle-ops-final-review-binding.json')));assert binding['approved']
 for name in ['qualify-source-bundle-lifecycle.mjs','source-lifecycle-reaper.py']:assert h(read_regular_bytes(r.parent/name))==binding['files'][name]
 security(650+25) # Full phase window BEFORE any marker/copy.
 assert not(r/('lifecycle'+suffix+'-started.json')).exists();save('lifecycle'+suffix+'-started.json',{'candidate':s['candidate'],'review':binding['acpApprovalId']})
 archive=io.BytesIO()
 with tarfile.open(fileobj=archive,mode='w')as t:
  for name in ['qualify-source-bundle-lifecycle.mjs','source-lifecycle-reaper.py']:
   data=read_regular_bytes(r.parent/name);m=tarfile.TarInfo('tmp/final'+suffix+'-'+name);m.uid=m.gid=1000;m.mode=0o600;m.size=len(data);t.addfile(m,io.BytesIO(data))
 run(['docker','cp','-a','-',ident()+':/'],input=archive.getvalue())
 data=json.loads(read_regular_text(r/'runtime-artifact-manifest.json'));status='/tmp/final-source-reaper'+suffix+'-status.jsonl';evidence='/tmp/final-source-lifecycle'+suffix+'-evidence'
 command=['python3','/tmp/final'+suffix+'-source-lifecycle-reaper.py','/usr/local/bin/node','/tmp/final'+suffix+'-qualify-source-bundle-lifecycle.mjs',status,'/app/server/dist/services/source-memory.js',runtime+'/'+data['workerChunk']['path'],'/opt/reader/tooling-9c477cebfff7',data['serviceSha256'],data['workerChunk']['sha256'],evidence]
 code=None;error=None
 with(r/('actual-bundle-lifecycle'+suffix+'.log')).open('x')as log:
  try:code=subprocess.run(exec_args('/app',command,650),stdout=log,stderr=subprocess.STDOUT,timeout=675).returncode
  except (subprocess.TimeoutExpired,OSError)as failure:error=type(failure).__name__+': '+str(failure)
 copied={}
 for label,source,dest in [('helper',evidence,r/('lifecycle'+suffix+'-evidence')),('reaper',status,r/('reaper'+suffix+'-status.jsonl'))]:
  p=subprocess.run(['docker','cp',ident()+':'+source,str(dest)],capture_output=True,timeout=60);copied[label]=p.returncode==0
  if copied[label]:assert_regular_tree(dest)
 save('lifecycle'+suffix+'-execution-result.json',{'exitCode':code,'error':error,'copied':copied,'candidate':s['candidate']})
 assert code==0 and error is None and all(copied.values())
 reaped=[json.loads(x)for x in read_regular_text(r/('reaper'+suffix+'-status.jsonl')).splitlines()];terminal=reaped[-1]
 assert terminal['kind']=='terminal'and terminal['mainExitCode']==0 and not terminal['forcedCleanup']and terminal['interrupted']==[]
 assert not any(x['kind']=='cleanup-deadline-exceeded'for x in reaped)
 records=[json.loads(x)for x in read_regular_text(r/('lifecycle'+suffix+'-evidence/receipts.jsonl')).splitlines()]
 assert records[-1]['step']=='fixture-cleanup'and records[-1]['cleanupErrors']==[]and any(x['step']=='cancel-pass'for x in records)
 save('lifecycle'+suffix+'-final-verdict.json',{'passed':True,'candidate':s['candidate'],'reaperStatusSha256':h(read_regular_bytes(r/('reaper'+suffix+'-status.jsonl'))),'helperReceiptsSha256':h(read_regular_bytes(r/('lifecycle'+suffix+'-evidence/receipts.jsonl'))),'scope':'Mapped actual normal bundle, synthetic source only; no ordinary production argv/full-company-dispatch claim'})
elif phase=='cleanup':
 c=security(require_running=False);assert(r/'runtime-artifact-copy-proof.json').exists()or not(r/'build-result.json').exists()
 save('cleanup-started.json',{'id':c,'candidate':s['candidate'],'onlyOwnedPrivateScratch':True})
 if run(['docker','inspect','--format','{{.State.Running}}',c]).stdout.strip()==b'true':run(['docker','stop','-t','5',c])
 run(['docker','rm','--volumes',c]);save('cleanup-result.json',{'removed':True,'id':c,'allHostEvidenceRetained':True})
print(json.dumps({'phase':phase,'candidate':s['candidate'],'finished':True}))
