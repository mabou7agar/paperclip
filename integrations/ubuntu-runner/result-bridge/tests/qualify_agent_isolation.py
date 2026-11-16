"""Actual AppArmor child boundary, using only a disposable existing-image fixture.

Root operator test. Never starts the app, an agent/provider, or candidate tests.
Only fresh qualification profile names are loaded and removed in finally.
"""
import hashlib
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import uuid

PEER = r'''
const fs = require('node:fs'), cp = require('node:child_process');
const label = fs.readFileSync('/proc/self/attr/current','utf8').trim();
const parent = process.argv[2], profile = process.argv[3];
const writable = file => { try { const fd=fs.openSync(file,fs.constants.O_WRONLY|fs.constants.O_NONBLOCK);fs.closeSync(fd);return true; }catch{return false;} };
const openable = file => { try { const fd = fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NONBLOCK); fs.closeSync(fd); return true; } catch { return false; } };
let fdListable = false; try { fs.readdirSync('/proc/'+parent+'/fd'); fdListable = true; } catch {}
const ancestorCases=[['/paperclip/instances','fixture/config.json'],['/paperclip/instances/fixture','config.json'],
 ['/paperclip/instances/fixture/data','backups/fixture.sql'],['/paperclip/.paperclip','plugins/fixture-worker.mjs'],
 ['/paperclip/.config','git/config'],['/paperclip/.local','bin/fixture']];
const ancestorChecks=ancestorCases.map(([target,child])=>{
 let moved=false,read=false,replaced=false;const alias=target+'-qualification-moved';
 try{fs.renameSync(target,alias);moved=true;read=openable(alias+'/'+child);
  fs.mkdirSync(target);fs.writeFileSync(target+'/replacement','synthetic-only');replaced=true;
 }catch{}finally{if(moved){try{fs.rmSync(target,{recursive:true,force:true});fs.renameSync(alias,target);}catch{}}}
 return {moved,read,replaced};
});
const serverAncestorRenameAllowed=ancestorChecks.some(x=>x.moved||x.read||x.replaced);
const escaped = cp.spawnSync('/opt/qualification/aa-exec',['-p',profile,'--','node','-e','process.exit(0)'],{encoding:'utf8'});
const peer = cp.spawn('node',['-e','setTimeout(()=>{},5000)'],{stdio:['pipe','pipe','pipe']});
let peerPipeOpenable=false;
peer.once('spawn',()=>{
peerPipeOpenable=openable('/proc/'+peer.pid+'/fd/0');peer.kill('SIGTERM');
});
peer.once('exit',()=>{
fs.writeFileSync('/tmp/agent-session.json',JSON.stringify({session:'synthetic-fixed-session',turn:1}));
const turn = JSON.parse(fs.readFileSync('/tmp/agent-session.json','utf8'));
console.log(JSON.stringify({label,environmentOpenable:openable('/proc/'+parent+'/environ'),fdListable,
 pipeOpenable:openable('/proc/'+parent+'/fd/0'),secretOpenable:openable('/paperclip/instances/fixture/secrets/dummy'),
 secretAliasOpenable:openable('/proc/'+parent+'/root/paperclip/instances/fixture/secrets/dummy'),
 serverConfigOpenable:openable('/paperclip/instances/fixture/config.json'),
 serverEnvironmentFileOpenable:openable('/paperclip/instances/fixture/.env'),
 serverDatabaseOpenable:openable('/paperclip/instances/fixture/db/PG_VERSION'),
 serverBackupOpenable:openable('/paperclip/instances/fixture/data/backups/fixture.sql'),
 serverLogOpenable:openable('/paperclip/instances/fixture/logs/server.log'),
 serverPluginWritable:writable('/paperclip/plugins/fixture-worker.mjs'),serverHomeControlWritable:writable('/paperclip/.profile'),
 serverAncestorRenameAllowed,ancestorChecks,profileEscapeSucceeded:escaped.status===0,peerPipeOpenable,workspaceWritable:turn.session==='synthetic-fixed-session',uid:process.getuid(),gid:process.getgid()}));
});
'''

PARENT = r'''
(async()=>{
const fs = require('node:fs'), cp = require('node:child_process');
const root = '/opt/qualification', profile = process.argv[2], agent = process.argv[3];
const baseline = cp.spawnSync('node',['-e',`const fs=require('node:fs');let ok=false;try{const f=fs.openSync('/proc/${process.pid}/environ','r');fs.closeSync(f);ok=true;}catch{}console.log(JSON.stringify({environmentOpenable:ok}))`],{encoding:'utf8'});
if(baseline.status!==0)throw Error('baseline_failed');
for(const file of ['/paperclip/instances/fixture/config.json','/paperclip/instances/fixture/.env','/paperclip/instances/fixture/db/PG_VERSION','/paperclip/instances/fixture/data/backups/fixture.sql','/paperclip/instances/fixture/logs/server.log']){const fd=fs.openSync(file,'r');fs.closeSync(fd);}
for(const file of ['/paperclip/plugins/fixture-worker.mjs','/paperclip/.profile']){const fd=fs.openSync(file,'r+');fs.closeSync(fd);}

fs.writeFileSync('/tmp/qualification-parent.pid',String(process.pid));
// Each ordinary ancestor must genuinely be movable/readable/replaceable in
// the control domain, otherwise a denied rename would be a fixture artefact.
const ancestorProgram=fs.readFileSync(root+'/peer.js','utf8');
process.env.DATABASE_URL='synthetic-control-only';
process.env.PAPERCLIP_LOCAL_AGENT_LAUNCH_POLICY=root+'/policy.json';
const repo='/tmp/git-worktree';fs.mkdirSync(repo);
const raw=(args)=>{const r=cp.spawnSync('git',args,{cwd:repo,encoding:'utf8',env:{...process.env,FIXTURE_PARENT_PID:String(process.pid)}});if(r.status!==0)throw Error('git_fixture_failed');};
raw(['init','-q']);fs.writeFileSync(repo+'/file','first');raw(['add','file']);
fs.writeFileSync(repo+'/.git/hooks/pre-commit','#!/bin/sh\nexec node /opt/qualification/git-hook.cjs\n',{mode:0o755});
const commit=['-c','core.hooksPath='+repo+'/.git/hooks','-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture'];
raw(commit);const baselineGit=JSON.parse(fs.readFileSync('/tmp/git-hook-result.json'));
if(!baselineGit.environmentOpenable||!baselineGit.inheritedControlCredential)throw Error('git_negative_control_failed');
fs.writeFileSync(repo+'/file','second');raw(['add','file']);
const workspace=await import(root+'/local-workspace-process.ts');
await new Promise((resolve,reject)=>workspace.execFile('git',commit,{cwd:repo,env:{...process.env,FIXTURE_PARENT_PID:String(process.pid)}},error=>error?reject(error):resolve()));
const git=JSON.parse(fs.readFileSync('/tmp/git-hook-result.json'));
const serverGitEscapesConfinement=!git.label.startsWith(agent+' ')||git.environmentOpenable||git.inheritedControlCredential;
raw(['config','core.fsmonitor','/opt/qualification/fsmonitor.sh']);
raw(['ls-files','-z']);const baselineFsmonitor=JSON.parse(fs.readFileSync('/tmp/git-hook-result.json'));
if(!baselineFsmonitor.environmentOpenable||!baselineFsmonitor.inheritedControlCredential)throw Error('fsmonitor_negative_control_failed');
fs.writeFileSync(repo+'/.gitignore','node_modules/\n');fs.mkdirSync(repo+'/node_modules');
fs.unlinkSync('/tmp/git-hook-result.json');
const compaction=await import(root+'/workspace-compaction.ts');
await compaction.findRegenerableWorkspaceDirs(repo);
const fsmonitor=JSON.parse(fs.readFileSync('/tmp/git-hook-result.json'));
const serverRepositoryHelperEscapesConfinement=!fsmonitor.label.startsWith(agent+' ')||fsmonitor.environmentOpenable||fsmonitor.inheritedControlCredential;
const controlPeer=cp.spawnSync('node',[root+'/peer.js',String(process.pid),profile],{encoding:'utf8'});
if(controlPeer.status!==0)throw Error('rename_negative_control_failed');const baselineAncestors=JSON.parse(controlPeer.stdout);
if(!baselineAncestors.ancestorChecks.every(x=>x.moved&&x.read&&x.replaced))throw Error('rename_negative_control_invalid');


const child = cp.spawnSync(root+'/aa-exec',['-p',agent,'--','node',root+'/peer.js',String(process.pid),profile],{encoding:'utf8'});
if(child.status!==0)throw Error('agent_profile_start_failed');
const result = JSON.parse(child.stdout);
const sleeping = cp.spawn(root+'/aa-exec',['-p',agent,'--','node','-e','setTimeout(()=>{},5000)'],{stdio:'ignore'});
sleeping.once('spawn',()=>setTimeout(()=>{if(!sleeping.kill('SIGTERM'))throw Error('cancel_failed')},100));
sleeping.once('exit',(code,signal)=>{
console.log(JSON.stringify({baseline:JSON.parse(baseline.stdout),agent:result,cancelled:signal==='SIGTERM',
 serverGitEscapesConfinement,serverRepositoryHelperEscapesConfinement,serverAncestorRenameAllowed:result.serverAncestorRenameAllowed,
 baselineAncestors:baselineAncestors.ancestorChecks,fsmonitor,baselineFsmonitor,git,baselineGit,parentProfile:fs.readFileSync('/proc/self/attr/current','utf8').trim(),uid:process.getuid(),readEnvironmentBytes:0}));
});
})().catch(error=>{process.stderr.write('qualification_parent_failed:'+String(error?.stack??error).slice(0,4000));process.exitCode=1});
'''


GIT_HOOK = r'''
const fs=require('node:fs');let environmentOpenable=false;
try{const parent=process.env.FIXTURE_PARENT_PID||fs.readFileSync('/tmp/qualification-parent.pid','utf8');const fd=fs.openSync('/proc/'+parent+'/environ','r');fs.closeSync(fd);environmentOpenable=true}catch{}
fs.writeFileSync('/tmp/git-hook-result.json',JSON.stringify({label:fs.readFileSync('/proc/self/attr/current','utf8').trim(),environmentOpenable,inheritedControlCredential:!!process.env.DATABASE_URL}));
'''

def main(profile_source, image, utility_source):
    if os.getuid() != 0 or not image.startswith('sha256:') or len(image) != 71:
        raise RuntimeError('root_and_existing_image_required')
    identifier = uuid.uuid4().hex
    control, agent = 'paperclip-q-' + identifier + '-control', 'paperclip-q-' + identifier + '-agent'
    source = pathlib.Path(profile_source).read_text()
    source = source.replace('paperclip-control', control).replace('paperclip-agent', agent)
    existing = pathlib.Path('/sys/kernel/security/apparmor/profiles').read_text()
    if control in existing or agent in existing:
        raise RuntimeError('qualification_profile_not_fresh')
    container_name = 'paperclip-isolation-' + identifier
    loaded = False
    with tempfile.TemporaryDirectory(prefix='paperclip-isolation-', dir='/opt') as temp:
        root = pathlib.Path(temp); root.chmod(0o755)
        policy = root / 'profiles'; policy.write_text(source); policy.chmod(0o644)
        (root / 'peer.js').write_text(PEER); (root / 'peer.js').chmod(0o644)
        (root / 'parent.js').write_text(PARENT); (root / 'parent.js').chmod(0o644)
        (root/'git-hook.cjs').write_text(GIT_HOOK);(root/'git-hook.cjs').chmod(0o644)
        (root/'policy.json').write_text(json.dumps({'kind':'apparmor','executable':'/opt/qualification/aa-exec','profile':agent}));(root/'policy.json').chmod(0o644)
        utility=pathlib.Path(utility_source).resolve(strict=True)
        for name in ['local-workspace-process.ts','local-agent-launch-policy.ts']:
            (root/name).write_bytes((utility/name).read_bytes());(root/name).chmod(0o644)
        home=root/'home';home.mkdir(mode=0o700)
        names=['instances/fixture/secrets/dummy','instances/fixture/config.json','instances/fixture/.env',
            'instances/fixture/db/PG_VERSION','instances/fixture/data/backups/fixture.sql','instances/fixture/logs/server.log',
            'plugins/fixture-worker.mjs','.profile','.paperclip/plugins/fixture-worker.mjs','.config/git/config','.local/bin/fixture']
        for name in names:
            file=home/name;file.parent.mkdir(parents=True,exist_ok=True);file.write_text('synthetic-only');file.chmod(0o600)
        for file in [home,*home.rglob('*')]:os.chown(file,1000,1000);file.chmod(0o700 if file.is_dir()else 0o600)
        compaction=utility.parents[2]/'server/src/services/workspace-compaction.ts'
        code=compaction.read_text();expected='@paperclipai/adapter-utils/local-workspace-process'
        if code.count(expected)!=1:raise RuntimeError('compaction_module_binding_changed')
        (root/'workspace-compaction.ts').write_text(code.replace(expected,'./local-workspace-process.ts'));(root/'workspace-compaction.ts').chmod(0o644)
        (root/'fsmonitor.sh').write_text('#!/bin/sh\nexec node /opt/qualification/git-hook.cjs\n');(root/'fsmonitor.sh').chmod(0o755)
        subprocess.run(['/sbin/apparmor_parser','-Q',str(policy)],check=True,capture_output=True)
        try:
            subprocess.run(['/sbin/apparmor_parser','-a',str(policy)],check=True,capture_output=True); loaded=True
            lib = pathlib.Path('/usr/lib/x86_64-linux-gnu/libapparmor.so.1').resolve(strict=True)
            command = ['docker','run','--rm','--name',container_name,'--network','none','--user','1000:1000',
                '--cpus','1','--memory','512m','--pids-limit','128','--security-opt','apparmor='+control,
                '--tmpfs','/tmp:rw,exec,nosuid,nodev,size=64m',
                '--mount',f'type=bind,src={root}/parent.js,dst=/opt/qualification/parent.js,readonly',
                '--mount',f'type=bind,src={root}/peer.js,dst=/opt/qualification/peer.js,readonly',
                '--mount','type=bind,src=/usr/bin/aa-exec,dst=/opt/qualification/aa-exec,readonly',
                '--mount',f'type=bind,src={lib},dst=/usr/lib/x86_64-linux-gnu/libapparmor.so.1,readonly',
                '--mount',f'type=bind,src={home},dst=/paperclip',
                *[item for name in ['git-hook.cjs','fsmonitor.sh','workspace-compaction.ts','policy.json','local-workspace-process.ts','local-agent-launch-policy.ts'] for item in ['--mount',f'type=bind,src={root/name},dst=/opt/qualification/{name},readonly']],
                '--entrypoint','node',image,'--import','/app/server/node_modules/tsx/dist/loader.mjs','/opt/qualification/parent.js',control,agent]
            done = subprocess.run(command, capture_output=True, text=True, timeout=25)
            if done.returncode:
                raise RuntimeError('isolated_profile_qualification_failed:'+done.stderr[-4000:])
            result = json.loads(done.stdout)
            observed = result['agent']
            print(json.dumps({'measurementOnly':True,'measurements':result}),flush=True)
            if not (result['baseline']['environmentOpenable'] and result['cancelled'] and observed['workspaceWritable'] and
                    observed['label'].startswith(agent+' ') and result['parentProfile'].startswith(control+' ') and
                    observed['uid']==1000 and observed['gid']==1000 and result['serverGitEscapesConfinement'] is False and
                    result['serverRepositoryHelperEscapesConfinement'] is False and result['serverAncestorRenameAllowed'] is False and
                    not any(observed[key] for key in ['environmentOpenable','pipeOpenable','peerPipeOpenable','secretOpenable',
                                                       'secretAliasOpenable','profileEscapeSucceeded','serverConfigOpenable','serverEnvironmentFileOpenable','serverDatabaseOpenable',
                                                       'serverBackupOpenable','serverLogOpenable','serverPluginWritable','serverHomeControlWritable'])):
                raise RuntimeError('agent_boundary_not_enforced')
            print(json.dumps({'passed':True,'measurements':result,'policySha256':hashlib.sha256(pathlib.Path(profile_source).read_bytes()).hexdigest(),
                'qualifiedProfileSha256':hashlib.sha256(source.encode()).hexdigest(),
                'image':image,'imagesBuilt':0,'providersStarted':0,'candidateTests':0}))
        finally:
            subprocess.run(['docker','rm','-f',container_name],capture_output=True)
            if loaded:
                subprocess.run(['/sbin/apparmor_parser','-R',str(policy)],check=True,capture_output=True)


if __name__ == '__main__':
    main(*sys.argv[1:])
