import {test} from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks,stripTypeScriptTypes,syncBuiltinESMExports} from 'node:module';
import {existsSync} from 'node:fs';
import filesystem from 'node:fs/promises';
import {mkdtemp,mkdir,readFile,writeFile,rm,symlink,realpath} from 'node:fs/promises';
import {execFileSync,spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const hooks=registerHooks({resolve(s,c,next){if(s.startsWith('.')&&s.endsWith('.js')&&c.parentURL){const p=new URL(s.slice(0,-3)+'.ts',c.parentURL);if(existsSync(fileURLToPath(p)))return next(p.href,c);}return next(s,c);}});
const {sizeIndexCapacity,validateIndexCapacity,continueSourceIndex}=await import('./source-memory-capacity.ts');
const {acquireIndexCapacityLease,SourceMemoryResourceRepository}=await import('./source-memory-resource-repository.ts');
const {refreshSourceIndex}=await import('./source-memory-indexing.ts');
const GiB=1024**3,MiB=1024**2;
const resources={freeDiskBytes:100*GiB,totalDiskBytes:120*GiB,availableMemoryBytes:20*GiB,stateBytes:500*MiB,scopeBytes:300*MiB};
const progress=n=>({revision:'a'.repeat(40),identity:'b'.repeat(64),cursor:n,totalFiles:10});

test('auto sizes disk independently of memory and preserves explicit ceilings',()=>{
 assert.ok(sizeIndexCapacity({mode:'auto'},{...resources,availableMemoryBytes:512*MiB}).maxContentBytes<=128*MiB);
 const auto=sizeIndexCapacity({mode:'auto'},resources);assert.ok(auto.stateLimit>GiB);
 assert.equal(sizeIndexCapacity({mode:'auto'},{...resources,freeDiskBytes:99*GiB,stateBytes:resources.stateBytes+GiB,scopeBytes:resources.scopeBytes+GiB}).stateLimit,auto.stateLimit);
 const bounded=sizeIndexCapacity({mode:'auto',maxStateBytes:GiB,maxScopeBytes:512*MiB,maxBatchFiles:5},resources,160*MiB);
 assert.equal(bounded.stateLimit,GiB);assert.equal(bounded.scopeLimit,512*MiB);assert.equal(bounded.maxContentBytes,160*MiB);assert.equal(bounded.batchFiles,5);
 assert.throws(()=>sizeIndexCapacity({mode:'auto'},{...resources,availableMemoryBytes:32*MiB}),/capacity_wait/);
 assert.throws(()=>sizeIndexCapacity({mode:'auto'},{...resources,freeDiskBytes:10*MiB}),/capacity_wait/);
});
test('operator settings reject invalid, unknown and unbounded continuation inputs',()=>{
 for(const p of [{mode:'fixed'},{mode:'auto',maxSlices:0},{mode:'auto',sliceMs:180001},{mode:'auto',diskFraction:0.9},{mode:'auto',wat:2}])assert.throws(()=>validateIndexCapacity(p),/capacity_invalid/);
});
test('completed verification skips resource probes; retrieval ignores another scope exceeding disk allocation',async()=>{
 const manifest={...progress(10),status:'complete',bytes:100};let probes=0;
 const memory={repository:{manifest:()=>manifest},knowledge:{},refresh:async()=>({blobReads:0})};
 const resourcesReader={snapshot:async()=>{probes++;return {...resources,availableMemoryBytes:0,stateBytes:200*GiB,freeDiskBytes:0};},acquire:async()=>{throw Error('must not acquire');}};
 assert.deepEqual(await refreshSourceIndex(memory,{},manifest.revision,{mode:'auto'},resourcesReader,undefined,undefined,50,false),{blobReads:0});assert.equal(probes,0);
 resourcesReader.snapshot=async()=>({...resources,stateBytes:200*GiB,freeDiskBytes:0});
 assert.deepEqual(await refreshSourceIndex(memory,{},manifest.revision,{mode:'auto'},resourcesReader),{blobReads:0});
 await assert.rejects(refreshSourceIndex(memory,{},manifest.revision,{mode:'auto'},resourcesReader,50,undefined,50,false),/index_budget/);
 manifest.bytes=50*MiB;resourcesReader.snapshot=async()=>({...resources,availableMemoryBytes:128*MiB});
 await assert.rejects(refreshSourceIndex(memory,{},manifest.revision,{mode:'auto'},resourcesReader),/capacity_wait/);
 assert.deepEqual(await refreshSourceIndex(memory,{},manifest.revision,{mode:'auto',reserveMemoryBytes:1,memoryFraction:0.5,retrievalExpansionFactor:1},resourcesReader),{blobReads:0});
});
test('reader adapter refuses a changed saved plan, post-batch capacity overrun, and bounds remote batches',async()=>{
 let manifest={...progress(2),status:'indexing',bytes:100};let calls=0,releases=0,snapshots=0;
 const memory={repository:{manifest:()=>manifest},knowledge:{},refresh:async(_scope,p)=>{calls++;assert.ok(p.batchSize<=50);manifest={...manifest,cursor:3};return {blobReads:1};}};
 const source={snapshot:async()=>++snapshots===1?resources:{...resources,stateBytes:2*GiB},acquire:async()=>()=>releases++};
 await assert.rejects(refreshSourceIndex(memory,{},manifest.revision,{mode:'fixed',maxStateBytes:GiB,maxScopeBytes:GiB},source,undefined,{...progress(2),identity:'d'.repeat(64)}),/index_progress_changed/);assert.equal(calls,0);
 await assert.rejects(refreshSourceIndex(memory,{},manifest.revision,{mode:'fixed',maxStateBytes:GiB,maxScopeBytes:GiB},source,undefined,progress(2),50),/capacity_wait/);assert.equal(calls,1);assert.equal(releases,1);assert.equal(manifest.cursor,3);
});
test('only strictly advancing completions continue; fatal errors, stalls and exhaustion stop once',async()=>{
 let calls=0;const done=await continueSourceIndex({mode:'auto'},async()=>++calls<3?{indexPending:progress(calls)}:'done');assert.equal(done,'done');assert.equal(calls,3);
 calls=0;await assert.rejects(continueSourceIndex({mode:'auto'},async()=>{calls++;throw Error('reader-fatal');}),/reader-fatal/);assert.equal(calls,1);
 calls=0;await assert.rejects(continueSourceIndex({mode:'auto'},async()=>{calls++;return {indexPending:progress(1)};}),/index_no_progress/);assert.equal(calls,2);
 calls=0;await assert.rejects(continueSourceIndex({mode:'auto',maxSlices:1},async()=>{calls++;return {indexPending:progress(1)};}),/continuation_budget/);assert.equal(calls,1);
 calls=0;await assert.rejects(continueSourceIndex({mode:'auto'},async()=>{calls++;return {indexPending:{...progress(calls),revision:(calls===1?'a':'c').repeat(40)}};}),/index_no_progress/);assert.equal(calls,2);
 await assert.rejects(continueSourceIndex({mode:'auto'},async()=>{throw Error('must-not-run');},AbortSignal.abort()),/cancelled/);
});
test('real private storage probes refuse symlinks and SQLite serializes capacity writers without polling',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'index-resources-'));await mkdir(path.join(root,'scope'));
 try{
  const release=await acquireIndexCapacityLease(root);await assert.rejects(acquireIndexCapacityLease(root),/capacity_busy/);release();
  const r=await new SourceMemoryResourceRepository(root+'/',path.join(root,'scope')).snapshot();assert.ok(r.freeDiskBytes>0);assert.ok(r.availableMemoryBytes>0);
  const release2=await acquireIndexCapacityLease(root);release2();await symlink('/etc/passwd',path.join(root,'scope','escape'));
  await assert.rejects(new SourceMemoryResourceRepository(root,path.join(root,'scope')).snapshot(),/state_path_denied/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('state inventory tolerates journals and directories deleted between listing and stat',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'index-vanishing-'));const scope=path.join(root,'scope');await mkdir(scope);await writeFile(path.join(scope,'vanish-journal'),'x');await mkdir(path.join(scope,'vanish-dir'));
 const oldStat=filesystem.lstat,oldRead=filesystem.readdir;
 try{
  filesystem.lstat=async p=>{if(String(p).endsWith('vanish-journal'))await filesystem.unlink(p);return oldStat(p);};
  filesystem.readdir=async p=>{if(String(p).endsWith('vanish-dir'))await filesystem.rm(p,{recursive:true});return oldRead(p);};syncBuiltinESMExports();
  const data=await new SourceMemoryResourceRepository(root,scope).snapshot();assert.equal(data.scopeBytes,0);
 }finally{filesystem.lstat=oldStat;filesystem.readdir=oldRead;syncBuiltinESMExports();await rm(root,{recursive:true,force:true});}
});

test('real native subprocess resumes committed reader batches across restart and duplicates read zero blobs',async()=>{
 const fixtureFile=process.env.PAPERCLIP_SOURCE_CAPACITY_FIXTURES;assert.ok(fixtureFile,'Pinned reader fixtures required');
 const reader=JSON.parse(await readFile(fixtureFile,'utf8')).capacity;
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'index-resume-real-'))),built=path.join(root,'built'),repo=path.join(root,'repo'),state=path.join(root,'state');
 const scope={companyId:'auto-company',projectId:'auto-project',repositoryId:'github.com/example/autosize'};
 const sha=b=>createHash('sha256').update(b).digest('hex');
 const git=(...args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}}).trim();
 try{
  await mkdir(built);await mkdir(repo);await writeFile(path.join(built,'package.json'),'{"type":"module"}');
  for(const name of ['source-memory','source-memory-retention','source-citation-reader','source-memory-capacity','source-memory-resource-repository','source-memory-indexing'])await writeFile(path.join(built,name+'.js'),stripTypeScriptTypes(await readFile(new URL('./'+name+'.ts',import.meta.url),'utf8'),{mode:'transform'}));
  const lockState=path.join(root,'crash-lock');
  const owner=spawn(process.execPath,['--input-type=module','--eval',`import {acquireIndexCapacityLease} from ${JSON.stringify(pathToFileURL(path.join(built,'source-memory-resource-repository.js')).href)};await acquireIndexCapacityLease(${JSON.stringify(lockState)});console.log('ready');process.stdin.resume();`],{stdio:['pipe','pipe','ignore']});
  await new Promise((resolve,reject)=>{owner.once('error',reject);owner.stdout.once('data',resolve);owner.once('exit',()=>reject(Error('lock owner exited before ready')));});
  await assert.rejects(acquireIndexCapacityLease(lockState),/capacity_busy/);
  const stopped=new Promise(resolve=>owner.once('close',resolve));owner.kill('SIGKILL');await stopped;
  const recovered=await acquireIndexCapacityLease(lockState);recovered();
  git('init','-q');git('config','user.name','Isolated indexing fixture');git('config','user.email','fixture@example.invalid');git('remote','add','origin','https://github.com/example/autosize');
  for(let i=0;i<10;i++)await writeFile(path.join(repo,`file-${i}.ts`),`export const value${i} = ${i};\n`);
  git('add','.');git('commit','-qm','Ten independent source files');
  const cfg=path.join(root,'config.json');
  const base={version:1,state,reader:reader.root,manifest:reader.manifest,bindings:[{...scope,roots:[repo]}],capacity:{mode:'auto',maxBatchFiles:2,sliceMs:1,maxSlices:1,maxDurationMs:30000,reserveDiskBytes:MiB,reserveMemoryBytes:MiB}};
  const input={...scope,issueId:'same-task',runId:'same-run',phase:'planning',provider:'fixture',model:'none',cwd:repo,repoUrl:'https://github.com/example/autosize',remoteAuthority:false};
  const invoke=(abortMs=0,remoteAbort=false)=>new Promise((resolve,reject)=>{
   const c=spawn(process.execPath,['--input-type=module','--eval',`import {prepareSourceMemory} from ${JSON.stringify(pathToFileURL(path.join(built,'source-memory.js')).href)};import {execFileSync} from 'node:child_process';import {acquireIndexCapacityLease} from ${JSON.stringify(pathToFileURL(path.join(built,'source-memory-resource-repository.js')).href)};const controller=new AbortController();if(${abortMs})setTimeout(()=>controller.abort(),${abortMs}).unref();
    const remoteRead=async r=>{if(${remoteAbort}&&r.args[0]==='cat-file'&&r.args[1]==='--batch'){
      let busy=false;try{const release=await acquireIndexCapacityLease(${JSON.stringify(state)});release();}catch(e){busy=e.message==='source_memory_capacity_busy';}
      if(!busy)throw Error('growth lease was not held');
      setTimeout(()=>controller.abort(),50);await new Promise(resolve=>controller.signal.addEventListener('abort',resolve,{once:true}));throw Error('controlled cancellation before raw blob response');
    }return execFileSync('git',['-C',${JSON.stringify(repo)},...r.args],{input:r.stdin,maxBuffer:r.maxBytes,env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}}).toString('base64');};
    try{console.log(JSON.stringify(await prepareSourceMemory({...${JSON.stringify(input)},remoteAuthority:${remoteAbort},signal:controller.signal},'phase',${JSON.stringify(cfg)},${remoteAbort}?remoteRead:undefined)));}catch(e){console.log(JSON.stringify({error:e.message}));process.exitCode=1;}`],{stdio:['ignore','pipe','pipe']});
   let out='',err='';c.stdout.on('data',d=>out+=d);c.stderr.on('data',d=>err+=d);c.on('error',reject);c.on('close',code=>{try{resolve({code,...JSON.parse(out.trim())});}catch{reject(Error('invalid fixture output '+err));}});
  });
  const ledger=path.join(state,'runtime-v1',sha(JSON.stringify(scope)),'reader','knowledge-v3.sqlite');
  const snapshot=()=>{const d=new DatabaseSync(ledger,{readOnly:true});try{return {manifest:JSON.parse(d.prepare('SELECT payload FROM manifests').get().payload),cache:d.prepare('SELECT scope,blob,payload FROM blob_cache ORDER BY blob').all(),plan:d.prepare('SELECT payload FROM index_plans').get().payload};}finally{d.close();}};
  await writeFile(cfg,JSON.stringify(base));const bounded=await invoke();assert.match(bounded.error,/continuation_budget/);const before=snapshot();assert.ok(before.manifest.cursor>=1&&before.manifest.cursor<=2);const savedCursor=before.manifest.cursor;
  // Block the real runtime ledger while the native child is active.
  const runtime=path.join(state,'runtime-v1',sha(JSON.stringify(scope)),'runtime.sqlite');
  const blocker=new DatabaseSync(runtime);blocker.exec('BEGIN IMMEDIATE');
  try{
   base.capacity.maxDurationMs=700;await writeFile(cfg,JSON.stringify(base));
   const expired=await invoke();assert.match(expired.error,/continuation_budget/);assert.equal(snapshot().manifest.cursor,savedCursor);
   base.capacity.maxDurationMs=30000;await writeFile(cfg,JSON.stringify(base));
   const aborted=await invoke(700);assert.equal(aborted.error,'source_memory_cancelled');assert.equal(snapshot().manifest.cursor,savedCursor);
   const released=await acquireIndexCapacityLease(state);released();
  }finally{blocker.exec('ROLLBACK');blocker.close();}
  base.bindings[0].remoteRoots=[repo];await writeFile(cfg,JSON.stringify(base));
  const cancelledMidBatch=await invoke(0,true);assert.equal(cancelledMidBatch.error,'source_memory_cancelled');
  assert.equal(snapshot().manifest.cursor,savedCursor);assert.deepEqual(snapshot().cache,before.cache);assert.equal(snapshot().plan,before.plan);
  const afterMidBatch=await acquireIndexCapacityLease(state);afterMidBatch();
  base.capacity.maxSlices=16;await writeFile(cfg,JSON.stringify(base));const resumed=await invoke();assert.equal(resumed.code,0);assert.equal(resumed.blobReads,10-savedCursor);
  const after=snapshot();assert.equal(after.manifest.status,'complete');assert.equal(after.manifest.cursor,10);assert.equal(after.plan,before.plan);
  for(const row of before.cache)assert.deepEqual(after.cache.find(x=>x.blob===row.blob),row);
  // A different scope's growth lease must not hold up a completed duplicate.
  const otherScopeLease=await acquireIndexCapacityLease(state);
  let duplicate;try{duplicate=await invoke();}finally{otherScopeLease();}
  assert.equal(duplicate.code,0);assert.equal(duplicate.blobReads,0);assert.deepEqual(snapshot().cache,after.cache);
 }finally{await rm(root,{recursive:true,force:true});}
});
