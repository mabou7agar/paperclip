import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
registerHooks({ resolve(s,c,next) {
  if (s.startsWith('.') && s.endsWith('.js') && c.parentURL) {
    const u = new URL(s.slice(0,-3)+'.ts',c.parentURL);
    if (existsSync(fileURLToPath(u))) return next(u.href,c);
  }
  return next(s,c);
} });
const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
const { tmpdir } = await import('node:os');
const path = (await import('node:path')).default;
const { execFileSync } = await import('node:child_process');
// Compile the real production modules into a temporary ESM tree, as the server
// build does. Worker subprocesses deliberately do not inherit test loader hooks.
const { stripTypeScriptTypes } = await import('node:module');
const { readFile, mkdir } = await import('node:fs/promises');
const compiled = await mkdtemp(path.join(tmpdir(),'osa457-compiled-'));
await mkdir(path.join(compiled,'heartbeat'));
await writeFile(path.join(compiled,'package.json'),' {"type":"module"}');
for (const file of ['source-memory','source-memory-remote','source-citation-consumer','source-citation-reader','heartbeat/source-memory']) {
  const source = await readFile(new URL('../'+file+'.ts',import.meta.url),'utf8');
  await writeFile(path.join(compiled,file+'.js'),stripTypeScriptTypes(source));
}
const { prepareHeartbeatSourceMemory } = await import(new URL('file://'+compiled+'/heartbeat/source-memory.js'));
const { after } = await import('node:test');
after(()=>rm(compiled,{recursive:true,force:true}));
const { authorizeSourceCitation, syntheticAuthorizationStore } = await import('../test-fixtures/source-citation-authorization.mjs');
const { PRP_COMPLETION_RESULT_PROVIDER_INPUT_SCHEMA, PRP_COMPLETION_RESULT_OUTPUT_SCHEMA } = await import('../../../../packages/paperclip-runner/src/contracts/completion-result.ts');

test('real HEAD admission, persisted run binding and phase policy', async t => {
  const root = await mkdtemp(path.join(tmpdir(),'osa457-admission-'));
  const repo = path.join(root,'repo');
  const { mkdir } = await import('node:fs/promises'); await mkdir(repo);
  const git = (...args) => execFileSync('git',['-C',repo,...args], { encoding:'utf8',env:{...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'} }).trim();
  const saved = process.env.PAPERCLIP_SOURCE_MEMORY_CONFIG;
  const privacy = process.env.PAPERCLIP_ISSUE_PRIVACY_MODE;
  try {
    git('init','-q'); git('remote','add','origin','https://github.com/example/permitted');
    const commit = async content => { await writeFile(path.join(repo,'example.ts'),content); git('add','.'); git('-c','core.hooksPath=/dev/null','-c','user.name=Synthetic','-c','user.email=synthetic@example.invalid','commit','-qm','fixture'); return git('rev-parse','HEAD'); };
    const base = await commit('export const version = 1;\n');
    const head = await commit('export const version = 2;\n');
    const reader = process.env.SOURCE_MEMORY_READER_FIXTURE;
    assert.ok(reader,'accepted reader fixture must be supplied');
    const config = path.join(root,'config.json');
    await writeFile(config,JSON.stringify({version:1,state:path.join(root,'state'),reader,manifest:path.join(path.dirname(reader),'tooling-9c477cebfff7-manifest.json'),bindings:[{companyId:'company',projectId:'project',repositoryId:'github.com/example/permitted',roots:[repo]}]}));
    process.env.PAPERCLIP_SOURCE_MEMORY_CONFIG=config;
    process.env.PAPERCLIP_ISSUE_PRIVACY_MODE='off';
    for (const [phase,baseRef] of [['planning','main'],['implementation',base],['review',base]]) await t.test(`${phase}: HEAD after base, baseRef=${baseRef}`, async () => {
      const runId='run-'+phase, workspaceId='workspace', issueId='task';
      const rows={
        agents:[{id:'agent',companyId:'company',permissions:null}],
        heartbeatRuns:[{id:runId,companyId:'company',agentId:'agent',issueId,responsibleUserId:null,contextSnapshot:{},status:'running'}],
        issues:[{id:issueId,companyId:'company',projectId:'project',executionWorkspaceId:workspaceId,projectWorkspaceId:'source',workspaceSelection:null,workspacePendingSelection:null,workspaceBindingRevision:0,executionPolicy:null}],
        projects:[{id:'project',companyId:'company',executionWorkspacePolicy:null}],
        executionWorkspaces:[{id:workspaceId,companyId:'company',projectId:'project',projectWorkspaceId:'source',baseRef,repoUrl:'https://github.com/example/permitted'}],
        projectWorkspaces:[{id:'source',companyId:'company',projectId:'project',repoUrl:'https://github.com/example/permitted'}],
      };
      const {db}=syntheticAuthorizationStore(rows);
      const actor={type:'agent',source:'agent_jwt',agentId:'agent',runId,companyId:'company',onBehalfOfUserId:null};
      const input={identity:{companyId:'company',projectId:'project',issueId,runId,phase,provider:'openai',model:'synthetic'},workspace:{cwd:repo,repoUrl:'https://github.com/example/permitted'},persistedWorkspaceId:workspaceId,recovering:false,
        authority:null,remote:null,assertOwned:async()=>{},readAuthority:async()=>null,
        frozenRevision:phase==='review'?head:undefined,
        authorize:admission=>authorizeSourceCitation(db,actor,{companyId:'company',issueId,workspaceId,admission}),
        recordRevision:async revision=>{assert.equal(revision,head); rows.heartbeatRuns[0].contextSnapshot.sourceSnapshot={workspaceId,revision};},
      };
      await assert.rejects(input.authorize(),/task_snapshot_unavailable/,'old saved runs never fall back to baseRef');
      const prepared=await prepareHeartbeatSourceMemory(input);
      assert.equal(prepared.evidence.revision,head);
      assert.equal(rows.heartbeatRuns[0].contextSnapshot.sourceSnapshot.revision,head);
      await prepared.beforeDispatch();
      const c=prepared.evidence.citations[0].citation;
      const citation={repo:c.repositoryId,fullSha:c.revision,path:c.path,startLine:c.startLine,endLine:c.endLine,sha256:c.sha256,mode:'current'};
      for(const [name,sourceCitations,fails] of [
        ['none',undefined,phase==='review'],
        ['historical',[{...citation,mode:'historical'}],phase==='review'],
        ['current',[citation],false],
        ['rejected',[{...citation,sha256:'f'.repeat(64)}],true],
      ]) {
        const result={exitCode:0,resultJson:sourceCitations===undefined?{}:{sourceCitations}};
        await prepared.consumeResult(result);
        assert.equal(result.exitCode,fails?1:0,name);
        if(name==='historical')assert.equal(result.resultJson.sourceCitationResults[0].reason,'verified_historical');
      }
      if(phase==='review')await assert.rejects(prepareHeartbeatSourceMemory({...input,frozenRevision:base}),/wrong_task_revision/);
      // The stored binding stays fixed even if the workspace's branch/base changes.
      rows.executionWorkspaces[0].baseRef='other-branch';
      assert.equal((await input.authorize()).frozenSha,head);
      rows.heartbeatRuns[0].contextSnapshot.sourceSnapshot.revision=base;
      await assert.rejects(prepared.beforeDispatch(),/binding_changed/);
    });
    await t.test('unbound configuration performs no source enforcement', async()=>{
      const unbound=JSON.parse(await readFile(config,'utf8')); unbound.bindings=[];
      await writeFile(config,JSON.stringify(unbound));
      const input={identity:{companyId:'company',projectId:'project',issueId:'task',runId:'unbound',phase:'review',provider:'openai',model:'synthetic'},workspace:{cwd:repo,repoUrl:'https://github.com/example/permitted'},persistedWorkspaceId:"workspace",recovering:false,authority:null,remote:null,
        assertOwned:async()=>{},readAuthority:async()=>null,
        recordRevision:async()=>{throw Error('unbound must not record a snapshot')},
        authorize:async admission=>{assert.equal(admission,true);return {companyId:'company',projectId:'project',repositoryId:'github.com/example/permitted',frozenSha:''}}};
      const prepared=await prepareHeartbeatSourceMemory(input);
      await prepared.beforeDispatch();
      const result={exitCode:0,resultJson:{}}; await prepared.consumeResult(result);
      assert.equal(result.exitCode,0); assert.equal(prepared.evidence,null);
      const unboundCitation={exitCode:0,resultJson:{sourceCitations:[{mode:'historical'}]}};
      await prepared.consumeResult(unboundCitation);
      assert.equal(unboundCitation.exitCode,1);
      assert.equal(unboundCitation.resultJson.sourceCitationResults[0].reason,'source_memory_unbound');
    });
  } finally {
    if(saved===undefined)delete process.env.PAPERCLIP_SOURCE_MEMORY_CONFIG;else process.env.PAPERCLIP_SOURCE_MEMORY_CONFIG=saved;
    if(privacy===undefined)delete process.env.PAPERCLIP_ISSUE_PRIVACY_MODE;else process.env.PAPERCLIP_ISSUE_PRIVACY_MODE=privacy;
    await rm(root,{recursive:true,force:true});
  }
});

test('provider finish and canonical result declare optional typed citations',()=>{
  for(const schema of [PRP_COMPLETION_RESULT_PROVIDER_INPUT_SCHEMA,PRP_COMPLETION_RESULT_OUTPUT_SCHEMA]) {
    assert.equal(schema.required.includes('sourceCitations'),false);
    assert.equal(schema.properties.sourceCitations.type,'array');
    assert.equal(schema.properties.sourceCitations.items.properties.fullSha.pattern,'^[a-f0-9]{40}$');
  }
});

test('handoff capture uses emitted worker with no ledger and refuses unfinished or detached source', async t => {
  const { prepareSourceMemory } = await import(new URL('file://'+compiled+'/source-memory.js'));
  const { stat } = await import('node:fs/promises');
  const root = await mkdtemp(path.join(tmpdir(), 'review-capture-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo'); await mkdir(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
  git('init', '-q', '-b', 'candidate'); git('remote', 'add', 'origin', 'https://github.com/example/capture');
  await writeFile(path.join(repo, 'example.ts'), 'export const value = 1;\n'); git('add', '.');
  git('-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Synthetic', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'final writes');
  const sha = git('rev-parse', 'HEAD');
  const reader = process.env.SOURCE_MEMORY_READER_FIXTURE; assert.ok(reader);
  const config = path.join(root, 'config.json'), state = path.join(root, 'must-not-exist');
  await writeFile(config, JSON.stringify({ version: 1, state, reader,
    manifest: path.join(path.dirname(reader), 'tooling-9c477cebfff7-manifest.json'),
    bindings: [{ companyId: 'company', projectId: 'project', repositoryId: 'github.com/example/capture', roots: [repo] }] }));
  const input = { companyId: 'company', projectId: 'project', issueId: 'task', runId: 'run', phase: 'review',
    provider: 'server', model: 'no-provider', cwd: repo, repoUrl: 'https://github.com/example/capture', remoteAuthority: false };
  const first = await prepareSourceMemory(input, 'capture', config);
  assert.equal(first.revision, sha); assert.equal(first.ref, 'refs/heads/candidate'); assert.equal(first.blobReads, 0);
  assert.equal((await prepareSourceMemory(input, 'capture', config)).revision, sha);
  await assert.rejects(stat(state), { code: 'ENOENT' });
  await writeFile(path.join(repo, 'example.ts'), 'unfinished\n');
  await assert.rejects(prepareSourceMemory(input, 'capture', config), /review_final_writes_pending/);
  git('checkout', '--', 'example.ts'); git('checkout', '--detach', sha);
  await assert.rejects(prepareSourceMemory(input, 'capture', config), /review_detached_ambiguous/);
  await assert.rejects(stat(state), { code: 'ENOENT' });
});
