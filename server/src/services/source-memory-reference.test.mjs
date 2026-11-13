import {test} from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks,stripTypeScriptTypes} from 'node:module';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,chmod,realpath} from 'node:fs/promises';
import fs from 'node:fs';import path from 'node:path';import {tmpdir} from 'node:os';import {pathToFileURL,fileURLToPath} from 'node:url';import {createHash} from 'node:crypto';import {execFileSync} from 'node:child_process';import {DatabaseSync} from 'node:sqlite';
registerHooks({resolve(s,c,next){if(s.endsWith('.js')&&c.parentURL?.endsWith('.ts')){const u=new URL(s.slice(0,-3)+'.ts',c.parentURL);if(fs.existsSync(fileURLToPath(u)))return next(u.href,c);}return next(s,c);}});
const {referenceTargets,referenceTerms}=await import('./source-memory-reference-types.ts');
const {SourceMemoryReferenceRepository}=await import('./source-memory-reference-repository.ts');
const {attachSourceReferenceContext,prepareSourceMemoryReferences}=await import('./source-memory-reference.ts');
const sha=v=>createHash('sha256').update(v).digest('hex');
const scope={companyId:'company',projectId:'index',repositoryId:'github.com/example/app'},revision='a'.repeat(40);
const target={...scope,consumerProjectId:'delivery',revision};
const consumer={...scope,projectId:'delivery'};
const content='export function existingMcpBrowser() {\n  return "screenshots and video";\n}\n';
async function fixture(){
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'reference-')));await chmod(root,0o700);
 const dir=path.join(root,'runtime-v1',sha(JSON.stringify(scope)),'reader');await mkdir(dir,{recursive:true,mode:0o700});
 const file=path.join(dir,'knowledge-v3.sqlite');const db=new DatabaseSync(file);db.exec('CREATE TABLE manifests(company,project,repository,revision,status,cursor,payload); CREATE TABLE documents(company,project,repository,revision,path,hash,content)');
 db.prepare('INSERT INTO manifests VALUES(?,?,?,?,?,?,?)').run(...Object.values(scope),revision,'complete',1,JSON.stringify({status:'complete',revision,totalFiles:1,cursor:1}));
 db.prepare('INSERT INTO documents VALUES(?,?,?,?,?,?,?)').run(...Object.values(scope),revision,'src/McpBrowser.ts',sha(content),content);db.close();await chmod(file,0o600);
 return {root,file,dir,repo:new SourceMemoryReferenceRepository(root)};
}
test('explicit consumer allowlist rejects cross-company, duplicate and malformed targets',()=>{
 assert.deepEqual(referenceTargets([target],consumer),[target]);assert.deepEqual(referenceTargets([target],{...consumer,companyId:'other'}),[]);
 assert.throws(()=>referenceTargets([target,target],consumer),/ambiguous_target/);
 assert.throws(()=>referenceTargets([{...target,revision:'HEAD'}],consumer),/configuration_invalid/);
 assert.ok(referenceTerms('the MCP screenshots العربية').includes('العربية'));
});
test('ASCII case matching is independent of a Turkish host locale',()=>{
 const moduleUrl=new URL('./source-memory-reference-types.ts',import.meta.url).href;
 const value=execFileSync(process.execPath,['--input-type=module','-e',`const {referenceTerms}=await import(${JSON.stringify(moduleUrl)});console.log(JSON.stringify({terms:referenceTerms('IDENTITY'),locale:Intl.DateTimeFormat().resolvedOptions().locale}));`],{encoding:'utf8',env:{...process.env,LANG:'tr_TR.UTF-8',LC_ALL:'tr_TR.UTF-8'}});
 const result=JSON.parse(value);assert.match(result.locale,/^tr/);assert.deepEqual(result.terms,['identity']);
});
test('complete indexed content is read without rebuilding, changing ledger bytes or exposing another scope',async()=>{
 const f=await fixture();try{
  const before=sha(await readFile(f.file));const result=await f.repo.read(scope,revision,'MCP browser video');
  assert.equal(result.standing,'reference');assert.equal(result.hits.length,1);assert.match(result.hits[0].content,/screenshots/);assert.equal(result.hits[0].indexedContentSha256,sha(content));
  assert.equal(result.blobReads,0);assert.equal(result.indexRefreshes,0);assert.equal(sha(await readFile(f.file)),before);
  await assert.rejects(f.repo.read({...scope,companyId:'other'},revision,'MCP'),/ENOENT/);
  await assert.rejects(f.repo.read(scope,'b'.repeat(40),'MCP'),/index_incomplete/);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
test('incomplete or corrupted indexed documents fail closed and symlink ledgers are refused',async()=>{
 const f=await fixture();try{
  let db=new DatabaseSync(f.file);db.prepare('UPDATE documents SET content=?').run('poisoned MCP');db.close();
  await assert.rejects(f.repo.read(scope,revision,'MCP'),/document_invalid/);
  db=new DatabaseSync(f.file);db.exec("UPDATE manifests SET status='indexing'");db.close();await assert.rejects(f.repo.read(scope,revision,'MCP'),/index_incomplete/);
  const saved=f.file+'.saved';await import('node:fs/promises').then(m=>m.rename(f.file,saved));await symlink(saved,f.file);await assert.rejects(f.repo.read(scope,revision,'MCP'),/storage_denied/);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
test('caseful Unicode matches both indexed paths and full-text fallback',async()=>{
 const f=await fixture();try{
  const text='export const КоД = "ПРИВЕТ";\n';const db=new DatabaseSync(f.file);
  db.prepare('UPDATE documents SET path=?,content=?,hash=?').run('src/МАРШРУТ.ts',text,sha(text));db.close();
  assert.equal((await f.repo.read(scope,revision,'маршрут')).hits[0].path,'src/МАРШРУТ.ts');
  assert.match((await f.repo.read(scope,revision,'привет')).hits[0].content,/ПРИВЕТ/);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
test('advisory context is bounded and idempotent and never writes current citation standing',()=>{
 const bundle={schema:1,standing:'reference',indexedScope:scope,revision,hits:[{path:'src/McpBrowser.ts',startLine:1,endLine:3,content,indexedContentSha256:sha(content)}],blobReads:0,indexRefreshes:0};
 const lookup={schema:1,status:'available',references:[bundle],blobReads:0,indexRefreshes:0};
 const context={paperclipTaskMarkdown:'Original accepted plan',paperclipTaskMarkdownCompact:'Compact plan',sourceSnapshot:{revision:'b'.repeat(40)},sourceCurrentEvidenceSatisfied:false};
 attachSourceReferenceContext(context,lookup);assert.match(context.paperclipTaskMarkdown,/NOT current-candidate/);assert.equal(context.paperclipSourceReferenceUsage.hits,1);assert.equal(context.paperclipTaskMarkdownCompact,'Compact plan');
 const first=context.paperclipTaskMarkdown;attachSourceReferenceContext(context,lookup);assert.equal(context.paperclipTaskMarkdown,first);assert.equal(context.sourceCurrentEvidenceSatisfied,false);assert.equal(context.sourceSnapshot.revision,'b'.repeat(40));assert.equal(context.sourceCitations,undefined);
 const large={...lookup,references:Array.from({length:4},()=>({...bundle,hits:Array.from({length:2},()=>({...bundle.hits[0],path:'a'.repeat(1000),content:'a'.repeat(2048)}))}))};
 attachSourceReferenceContext(context,large);assert.ok(Buffer.byteLength(context.paperclipSourceReferenceMarkdown)<=24576);
 attachSourceReferenceContext(context,{...lookup,status:'partial'});assert.equal(context.paperclipSourceReferenceUsage.status,'partial');
 attachSourceReferenceContext(context,{...lookup,references:[{...bundle,hits:[]}]});assert.equal(context.paperclipSourceReferenceUsage.status,'no_matches');assert.equal(context.paperclipSourceReferenceUsage.hits,0);
 attachSourceReferenceContext(context,null);assert.equal(context.paperclipTaskMarkdown,'Original accepted plan');assert.equal(context.paperclipSourceReferenceUsage,undefined);
});
test('unlisted projects make no index or ownership calls, including when targets point to unavailable storage',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'reference-config-'));try{
  const file=path.join(root,'config.json');await writeFile(file,JSON.stringify({references:[target],state:'/does-not-exist'}));let calls=0;
  const input={companyId:'other',projectId:'delivery',issueId:'issue',runId:'run',phase:'planning',query:'MCP'};
  assert.equal(await prepareSourceMemoryReferences(input,async()=>{calls++;},file),null);assert.equal(calls,0);
  for(const invalid of ['{not json}',JSON.stringify({references:{}})]){
   await writeFile(file,invalid);const lookup=await prepareSourceMemoryReferences(input,async()=>{calls++;},file);assert.equal(lookup,null);
   const context={paperclipTaskMarkdown:'Accepted original plan'};assert.equal(attachSourceReferenceContext(context,lookup),null);assert.deepEqual(context,{paperclipTaskMarkdown:'Accepted original plan'});
  }
  assert.equal(calls,0);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('malformed optional bindings return unavailable instead of failing a consumer task',async()=>{
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'reference-malformed-')));
 try{
  const file=path.join(root,'config.json'),input={companyId:'company',projectId:'delivery',issueId:'issue',runId:'run',phase:'implementation',provider:'codex',model:'sol',cwd:'/unused',repoUrl:null,remoteAuthority:false};
  for(const bindings of [{},[null]]){
   await writeFile(file,JSON.stringify({state:root,references:[target],bindings}));let owned=0;
   const result=await prepareSourceMemoryReferences(input,async()=>{owned++;},file);
   assert.equal(result.status,'unavailable');assert.deepEqual(result.references,[]);assert.equal(owned,2);
  }
 }finally{await rm(root,{recursive:true,force:true});}
});
const fixturesFile=process.env.PAPERCLIP_SOURCE_CAPACITY_FIXTURES;
test('guarded native subprocess consumes an existing index and refuses revoked access without Git or refresh', {skip:!fixturesFile},async()=>{
 const f=await fixture();try{
  const known=JSON.parse(await readFile(fixturesFile,'utf8'));const built=path.join(f.root,'built');await mkdir(built);await mkdir(path.join(built,'heartbeat'));await writeFile(path.join(built,'package.json'),'{"type":"module"}');
  for(const name of ['source-memory','source-memory-reference','source-memory-reference-types','source-memory-reference-repository','source-memory-retention','source-citation-reader','source-memory-capacity','source-memory-resource-repository','source-memory-indexing','heartbeat/source-memory-run-state'])await writeFile(path.join(built,name+'.js'),stripTypeScriptTypes(await readFile(new URL('./'+name+'.ts',import.meta.url),'utf8'),{mode:'transform'}));
  // The completed index remains usable after the indexed checkout is removed.
  const checkout=path.join(f.root,'removed-checkout');const config=path.join(f.root,'config.json');
  const data={version:1,state:f.root,reader:known.reader,manifest:known.manifest,bindings:[{...scope,roots:[checkout]},{...scope,projectId:'other-project',roots:['/must-not-be-read']}],references:[target]};await writeFile(config,JSON.stringify(data));
  const oldPath=process.env.PATH;process.env.PATH='/nonexistent';const service=await import(pathToFileURL(path.join(built,'source-memory-reference.js')).href);process.env.PATH=oldPath;
  const input={companyId:'company',projectId:'delivery',issueId:'issue',runId:'run',phase:'implementation',provider:'openai',model:'sol',cwd:'/unused',repoUrl:null,remoteAuthority:true,query:'MCP screenshots'};
  const before=sha(await readFile(f.file));let owned=0;const result=await service.prepareSourceMemoryReferences(input,async()=>{owned++;},config);
  assert.equal(result.status,'available');assert.equal(result.references[0].hits.length,1);assert.equal(result.blobReads,0);assert.equal(result.indexRefreshes,0);assert.equal(owned,2);assert.equal(sha(await readFile(f.file)),before);
  const memory=await import(pathToFileURL(path.join(built,'source-memory.js')).href);
  await assert.rejects(memory.prepareSourceReferenceIndex({...input,projectId:scope.projectId,repoUrl:'https://'+scope.repositoryId,cwd:'/not-declared-in-binding',remoteAuthority:false},revision,config),/root_denied/);
  await assert.rejects(service.prepareSourceMemoryReferences(input,async()=>{if(++owned===4)throw Error('revoked');},config),/revoked/);
  let checks=0;const revoked=await service.prepareSourceMemoryReferences(input,async()=>{if(++checks===2)await writeFile(config,JSON.stringify({...data,references:[]}));},config);
  assert.equal(revoked,null);const revokedContext={paperclipTaskMarkdown:'Accepted plan'};assert.equal(service.attachSourceReferenceContext(revokedContext,revoked),null);assert.deepEqual(revokedContext,{paperclipTaskMarkdown:'Accepted plan'});
  await writeFile(config,JSON.stringify(data));
  const missing=path.join(f.root,'missing-index-root');await mkdir(missing);
  data.bindings.push({...scope,projectId:'missing-index',roots:[missing]});data.references.push({...target,projectId:'missing-index'});await writeFile(config,JSON.stringify(data));
  const partial=await service.prepareSourceMemoryReferences(input,async()=>{},config);assert.equal(partial.status,'partial');assert.equal(partial.references[0].hits.length,1);
  let reads=0;await assert.rejects(service.prepareSourceMemoryReferences({...input,signal:AbortSignal.abort(Error('cancelled'))},async()=>{reads++;},config),/cancelled/);assert.ok(reads<=1);
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test('new admissions clear old snippets and receipts without changing the saved plan or predecessor',async()=>{
 const {freshSourceMemoryRetryContext}=await import('./heartbeat/source-memory-run-state.ts');
 const plan={task:'same',acceptedPlan:'preserve',providerSession:'same-thread',paperclipTaskMarkdown:'Accepted plan',paperclipTaskMarkdownAssignment:'Accepted assignment',paperclipTaskMarkdownCompact:'Compact plan'};
 const previous={...plan,sourceSnapshot:{revision},sourceReferenceUsage:{status:'available'}};
 attachSourceReferenceContext(previous,{schema:1,status:'available',references:[{schema:1,standing:'reference',indexedScope:scope,revision,hits:[{path:'src/McpBrowser.ts',startLine:1,endLine:3,content,indexedContentSha256:sha(content)}],blobReads:0,indexRefreshes:0}],blobReads:0,indexRefreshes:0});
 previous.paperclipTaskMarkdown+='\n\nLater routing guidance';
 const saved=structuredClone(previous),next=freshSourceMemoryRetryContext(previous);
 assert.deepEqual(next,{...plan,paperclipTaskMarkdown:plan.paperclipTaskMarkdown+'\n\nLater routing guidance'});assert.deepEqual(previous,saved);assert.ok(!JSON.stringify(next).includes('## Indexed repository references'));
});

test('a target that returns no index result reports unavailable rather than no matches',async()=>{
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'reference-null-target-')));
 try{
  const file=path.join(root,'config.json'),data={version:1,state:root,reader:'/unused-reader',manifest:'/unused-manifest',bindings:[{...scope,roots:[root]}],references:[target]},bytes=JSON.stringify(data);
  await writeFile(file,bytes);let owned=0;
  const result=await prepareSourceMemoryReferences({companyId:'company',projectId:'delivery',issueId:'issue',runId:'run',phase:'implementation',provider:'codex',model:'sol',cwd:root,repoUrl:null,remoteAuthority:false},async()=>{await writeFile(file,++owned===1?JSON.stringify({...data,bindings:[]}):bytes);},file);
  assert.equal(result.status,'unavailable');assert.deepEqual(result.references,[]);assert.equal(result.blobReads,0);assert.equal(owned,2);
 }finally{await rm(root,{recursive:true,force:true});}
});
