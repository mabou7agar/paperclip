// Only dummy files and guard calls in a disposable Node process. No probe or
// business command is executed; a missed rejection fails the fixture.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {spawnSync} from 'node:child_process';
test('observer pins getconf to the actual child cwd, absolute PATH and clean environment',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'f2-observer-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const canonical=path.join(root,'canonical','getconf'),parent=path.join(root,'parent'),nested=path.join(parent,'nested'),decoy=path.join(parent,'canonical','getconf');
 for(const dir of [path.dirname(canonical),nested,path.dirname(decoy)])await mkdir(dir,{recursive:true});
 await writeFile(canonical,'synthetic only');await writeFile(decoy,'never execute');
 const env={PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/nonexistent',LANG:'C.UTF-8',NODE_OPTIONS:'',NODE_PATH:'',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',PYTHONDONTWRITEBYTECODE:'1'};
 const source=await readFile(new URL('./qualify-source-bundle-lifecycle.mjs',import.meta.url),'utf8');
 const body=source.slice(source.indexOf('function observerCode(log) {'),source.indexOf('\n\n\nfunction entryObserverCode'));
 const context=vm.createContext({env,platformProbeProgram:canonical,allowedPrograms:[]});
 const generate=vm.runInContext('('+body+')',context);const log=path.join(root,'events.jsonl');
 const workerEnv={PATH:env.PATH,HOME:'/nonexistent',LANG:'C.UTF-8',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0',NODE_OPTIONS:'',NODE_PATH:'',NODE_NO_WARNINGS:'1'};
 const script=path.join(root,'guard.mjs');
 await writeFile(script,generate(log)+`
import assert from 'node:assert/strict';
const canonical=${JSON.stringify(canonical)},env=${JSON.stringify(env)},workerEnv=${JSON.stringify(workerEnv)},nested=${JSON.stringify(nested)};
check(canonical,'positive',env,['GNU_LIBC_VERSION'],nested);
check(canonical,'worker-positive',workerEnv,['GNU_LIBC_VERSION'],nested);
for(const value of [{...env,LD_PRELOAD:'/untrusted'},{...env,LD_LIBRARY_PATH:'/untrusted'},{...env,PATH:'../canonical'},{...env,NODE_OPTIONS:'--import=/untrusted'}])assert.throws(()=>check(canonical,'bad-env',value,['GNU_LIBC_VERSION'],nested),/qualifier_forbidden_exec/);
assert.throws(()=>check(canonical,'bad-arg',env,['PATH'],nested),/qualifier_forbidden_exec/);
assert.throws(()=>check('../canonical/getconf','child-cwd',env,['GNU_LIBC_VERSION'],nested),/qualifier_forbidden_exec/);
assert.throws(()=>cp.spawnSync('../canonical/getconf',['GNU_LIBC_VERSION'],{cwd:nested,env}),/qualifier_forbidden_exec/);
assert.throws(()=>cp.execFileSync(canonical,['GNU_LIBC_VERSION'],{env:{...env,LD_PRELOAD:'/bad'}}),/qualifier_forbidden_exec/);
`);
 const result=spawnSync(process.execPath,[script],{cwd:parent,env,encoding:'utf8',timeout:10000});assert.equal(result.status,0,result.stderr);
 const rows=(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse);
 assert.equal(rows.filter(x=>x.kind==='exec').length,2);
 assert.equal(rows.filter(x=>x.kind==='forbidden-exec').length,8);
 assert.equal(rows.find(x=>x.api==='child-cwd').resolved,decoy);
});
