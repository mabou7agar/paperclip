// New real-worker capacity integration; requires the two exact pinned code-only
// readers. Missing fixtures fail rather than silently skipping this release gate.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {stripTypeScriptTypes} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const fixtureFile=process.env.PAPERCLIP_SOURCE_CAPACITY_FIXTURES;
assert.ok(fixtureFile,'Set PAPERCLIP_SOURCE_CAPACITY_FIXTURES to the pinned-reader fixture JSON');
const fixtures=JSON.parse(await readFile(fixtureFile,'utf8'));
const sha=value=>createHash('sha256').update(value).digest('hex');
const scope={companyId:'capacity-company',projectId:'capacity-project',repositoryId:'github.com/example/capacity'};

test('real worker enforces reader pins, per-binding capacity and reader provenance',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'source-capacity-worker-'));
  const built=path.join(root,'compiled'),repo=path.join(root,'repo');
  await mkdir(built);await mkdir(repo);
  const git=(...args)=>execFileSync('git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-C',repo,...args],{
    encoding:'utf8',env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'}}).trim();
  try{
    await writeFile(path.join(built,'package.json'),'{}');
    for(const name of ['source-memory','source-memory-retention','source-citation-reader']){
      const code=await readFile(new URL('./'+name+'.ts',import.meta.url),'utf8');
      await writeFile(path.join(built,name+'.js'),stripTypeScriptTypes(code,{mode:'transform',sourceUrl:fileURLToPath(new URL('./'+name+'.ts',import.meta.url))}));
    }
    await writeFile(path.join(built,'package.json'),JSON.stringify({type:'module'}));
    git('init','--quiet');git('config','user.name','Capacity worker fixture');git('config','user.email','fixture@example.invalid');
    git('remote','add','origin','https://github.com/example/capacity');
    await writeFile(path.join(repo,'capacity.ts'),'export const capacity = 7;\n');git('add','.');git('commit','--quiet','-m','Capacity worker fixture');
    const {prepareSourceMemory}=await import(pathToFileURL(path.join(built,'source-memory.js')).href);
    const invoke=async(name,reader,maxContentBytes)=>{
      const state=path.join(root,name),config=path.join(root,name+'.json');
      await writeFile(config,JSON.stringify({version:1,state,reader:reader.root,manifest:reader.manifest,
        bindings:[{...scope,roots:[repo],...(maxContentBytes===undefined?{}:{maxContentBytes})}]}));
      const evidence=await prepareSourceMemory({...scope,issueId:'capacity-task',runId:name,phase:'implementation',provider:'operator',model:'fixture',
        cwd:repo,repoUrl:'https://github.com/example/capacity',remoteAuthority:false,query:'capacity',signal:AbortSignal.timeout(20000)},'phase',config);
      const ledger=path.join(state,'runtime-v1',sha(JSON.stringify(scope)),'runtime.sqlite');
      const db=new DatabaseSync(ledger,{readOnly:true});
      try{
        const facts=db.prepare('SELECT provenance FROM facts').all().map(row=>JSON.parse(row.provenance));
        return {evidence,facts,state};
      }finally{db.close();}
    };
    await t.test('actual metadata pins match their exact fixture bytes',async()=>{
      assert.equal(sha(await readFile(fixtures.legacy.manifest)),fixtures.legacy.manifestSha256);
      assert.equal(sha(await readFile(fixtures.capacity.manifest)),fixtures.capacity.manifestSha256);
    });
    await t.test('old reader refuses a configured capacity before indexing',async()=>{
      await assert.rejects(invoke('old-policy-refused',fixtures.legacy,32),/source_memory_reader_capacity_unsupported/);
    });
    await t.test('capacity reader without an override is accepted and records its actual revision',async()=>{
      const result=await invoke('new-default',fixtures.capacity);
      assert.equal(result.evidence.event,'changed');assert.ok(result.facts.length>0);
      assert.ok(result.facts.every(f=>f.readerRevision===fixtures.capacity.revision));
    });
    await t.test('the configured budget reaches the real Memory constructor',async()=>{
      await assert.rejects(invoke('new-low-budget',fixtures.capacity,5),/source_memory_index_budget/);
      const result=await invoke('new-explicit-budget',fixtures.capacity,32);
      assert.equal(result.evidence.event,'changed');assert.ok(result.facts.length>0);
      assert.ok(result.facts.every(f=>f.readerRevision===fixtures.capacity.revision));
    });
    await t.test('a changed plan identity has its own safe failure code',async()=>{
      const result=await invoke('new-plan-refused',fixtures.capacity,32);
      const db=new DatabaseSync(path.join(result.state,'runtime-v1',sha(JSON.stringify(scope)),'reader','knowledge-v3.sqlite'));
      try{
        const row=db.prepare('SELECT payload FROM index_plans').get();
        const plan=JSON.parse(row.payload);plan.limitsIdentity='controlled-fixture-identity-change';
        db.prepare('UPDATE index_plans SET payload=?').run(JSON.stringify(plan));
        db.exec("UPDATE manifests SET status='indexing'");
      }finally{db.close();}
      await assert.rejects(invoke('new-plan-refused',fixtures.capacity,32),/source_memory_manifest_changed/);
    });
    await t.test('old reader without an override still records the old revision',async()=>{
      const result=await invoke('old-default',fixtures.legacy);
      assert.equal(result.evidence.event,'changed');assert.ok(result.facts.length>0);
      assert.ok(result.facts.every(f=>f.readerRevision===fixtures.legacy.revision));
    });
  }finally{await rm(root,{recursive:true,force:true});}
});
