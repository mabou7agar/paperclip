import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile, rm, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';

const hooks=registerHooks({resolve(specifier,context,next){
  if(specifier.startsWith('.')&&specifier.endsWith('.js')&&context.parentURL){
    const ts=new URL(specifier.slice(0,-3)+'.ts',context.parentURL);
    if(existsSync(fileURLToPath(ts)))return next(ts.href,context);
  }return next(specifier,context);
}});
const {sourceMemoryProjectBindingEnabled}=await import('./source-memory.ts');
test('capacity configuration is optional, validated and scoped before source access',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'source-capacity-config-'));
  const file=path.join(root,'config.json');
  const binding={companyId:'company',projectId:'project',repositoryId:'github.com/example/repo',roots:['/unopened']};
  const write=bindings=>writeFile(file,JSON.stringify({version:1,state:'/unopened/state',reader:'/unopened/reader',manifest:'/unopened/manifest',bindings}));
  const check=()=>sourceMemoryProjectBindingEnabled({companyId:'company',projectId:'project'},file);
  try{
    await t.test('omission keeps existing project opt-in',async()=>{await write([binding]);assert.equal(await check(),true);});
    await t.test('a positive configured byte budget is accepted',async()=>{await write([{...binding,maxContentBytes:160*1024*1024}]);assert.equal(await check(),true);});
    await t.test('invalid active-project capacities refuse before source access',async()=>{
      for(const value of [0,-1,1.5,'167772160',true,Number.MAX_SAFE_INTEGER+1]){
        await write([{...binding,maxContentBytes:value}]);await assert.rejects(check(),/source_memory_capacity_invalid/);
      }
    });
    await t.test('a foreign project cannot enable or interfere with this scope',async()=>{await write([{...binding,projectId:'other',maxContentBytes:-1}]);assert.equal(await check(),false);});
    assert.deepEqual(await readdir(root),['config.json']);
  }finally{hooks.deregister();await rm(root,{recursive:true,force:true});}
});
