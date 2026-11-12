import {test,mock} from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {EventEmitter} from 'node:events';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
registerHooks({resolve(s,c,next){if(s.startsWith('.')&&s.endsWith('.js')&&c.parentURL){const u=new URL(s.slice(0,-3)+'.ts',c.parentURL);if(existsSync(fileURLToPath(u)))return next(u.href,c)}return next(s,c)}});
const childProcess=await import('node:child_process');
let spawns=0;
mock.module('node:child_process',{namedExports:{...childProcess,spawn(){
 spawns++;const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();
 child.stdin.end=()=>queueMicrotask(()=>{child.stdout.emit('data',Buffer.from('source_memory_parent_pid1_unsupported'));child.emit('close',1)});
 return child;
}}});
const {prepareSourceMemory}=await import('./source-memory.ts');
test('worker-emitted pid1 refusal retains its specific digit-bearing error code',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'f2-worker-refusal-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const config=path.join(root,'config.json');
 await writeFile(config,JSON.stringify({version:1,state:path.join(root,'unused-state'),reader:path.join(root,'unused-reader'),manifest:path.join(root,'unused-manifest'),bindings:[{companyId:'company',projectId:'project',repositoryId:'github.com/example/repo',roots:[root]}]}));
 await assert.rejects(prepareSourceMemory({companyId:'company',projectId:'project',issueId:'task',runId:'run',repoUrl:'https://github.com/example/repo',cwd:root,phase:'implementation',provider:'synthetic',model:'never-paid',remoteAuthority:false},'phase',config),{message:'source_memory_parent_pid1_unsupported'});
 assert.equal(spawns,1);
});
