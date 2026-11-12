import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFileSync,spawn} from 'node:child_process';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {prepareSourceMemory} from './source-memory.js';
test('C2 synthetic replay, reorder, force-push and publication crash use no provider',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'source-events-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const repo=path.join(root,'repo');await mkdir(repo);
 const git=(...a)=>execFileSync('git',['-C',repo,...a],{encoding:'utf8',env:{...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'}}).trim();
 git('init','-q');git('remote','add','origin','https://github.com/example/events');
 const commit=async n=>{await writeFile(path.join(repo,'example.ts'),`export const value = ${n};\n`);git('add','.');git('-c','core.hooksPath=/dev/null','-c','user.name=Synthetic','-c','user.email=test@example.invalid','commit','-qm','synthetic');return git('rev-parse','HEAD')};
 const a=await commit(1),b=await commit(2);
 const scope={companyId:'synthetic',projectId:'synthetic',repositoryId:'github.com/example/events'};
 const reader=process.env.SOURCE_MEMORY_READER_FIXTURE;assert.ok(reader);
 const config=path.join(root,'config.json');await writeFile(config,JSON.stringify({version:1,state:path.join(root,'state'),reader,manifest:path.join(path.dirname(reader),'tooling-9c477cebfff7-manifest.json'),bindings:[{...scope,roots:[repo]}]}));
 const input={...scope,issueId:'synthetic',runId:'synthetic',phase:'implementation',provider:'synthetic',model:'synthetic',cwd:repo,repoUrl:'https://github.com/example/events',remoteAuthority:false};
 // This service has no wake/provider port: all operations below are the real
 // source service and local Git/SQLite. No provider adapter is started.
 const first=await prepareSourceMemory(input,'commit',config);assert.equal(first.revision,b);
 for(const event of ['duplicate','replay','late-old-event']) {
  const receipt=await prepareSourceMemory({...input,query:event},'commit',config);
  assert.equal(receipt.event,'duplicate');assert.equal(receipt.blobReads,0);assert.equal(receipt.revision,b);
 }
 // Simulate a non-fast-forward ref update solely in the synthetic repository.
 git('reset','--hard',a);const forced=await prepareSourceMemory(input,'commit',config);assert.equal(forced.revision,a);
 git('reset','--hard',b);const replay=await prepareSourceMemory(input,'commit',config);assert.equal(replay.event,'duplicate');assert.equal(replay.blobReads,0);
 const id=createHash('sha256').update(JSON.stringify(scope)).digest('hex');
 const dbfile=path.join(root,'state','runtime-v1',id,'runtime.sqlite');
 // Kill a real SQLite writer after an unpublished transaction. Its marker and
 // cursor update must roll back before the unchanged event is reconstructed.
 const script=`const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(process.argv[1]);db.exec("BEGIN IMMEDIATE; INSERT INTO events VALUES ('unpublished','crash','bad','[]'); UPDATE refs SET revision='bad'");process.stdout.write('ready\\n');setInterval(()=>{},1000);`;
 const child=spawn(process.execPath,['--input-type=module','-e',script,dbfile],{stdio:['ignore','pipe','pipe']});
 const closed=once(child,'close');await once(child.stdout,'data');child.kill('SIGKILL');await closed;
 const after=await prepareSourceMemory(input,'commit',config);assert.equal(after.event,'duplicate');assert.equal(after.blobReads,0);
 const db=new DatabaseSync(dbfile);try {assert.equal(db.prepare("SELECT count(*) n FROM events WHERE key='unpublished'").get().n,0);assert.equal(db.prepare('SELECT revision FROM refs').get().revision,b);}finally{db.close();}
 t.diagnostic('provider wakes = 0; source service only, no provider dispatch integration claimed');
});
