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
const openable = file => { try { const fd = fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NONBLOCK); fs.closeSync(fd); return true; } catch { return false; } };
let fdListable = false; try { fs.readdirSync('/proc/'+parent+'/fd'); fdListable = true; } catch {}
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
 profileEscapeSucceeded:escaped.status===0,peerPipeOpenable,workspaceWritable:turn.session==='synthetic-fixed-session',uid:process.getuid(),gid:process.getgid()}));
});
'''

PARENT = r'''
const fs = require('node:fs'), cp = require('node:child_process');
const root = '/opt/qualification', profile = process.argv[2], agent = process.argv[3];
const baseline = cp.spawnSync('node',['-e',`const fs=require('node:fs');let ok=false;try{const f=fs.openSync('/proc/${process.pid}/environ','r');fs.closeSync(f);ok=true;}catch{}console.log(JSON.stringify({environmentOpenable:ok}))`],{encoding:'utf8'});
if(baseline.status!==0)throw Error('baseline_failed');
const child = cp.spawnSync(root+'/aa-exec',['-p',agent,'--','node',root+'/peer.js',String(process.pid),profile],{encoding:'utf8'});
if(child.status!==0)throw Error('agent_profile_start_failed');
const result = JSON.parse(child.stdout);
const sleeping = cp.spawn(root+'/aa-exec',['-p',agent,'--','node','-e','setTimeout(()=>{},5000)'],{stdio:'ignore'});
sleeping.once('spawn',()=>setTimeout(()=>{if(!sleeping.kill('SIGTERM'))throw Error('cancel_failed')},100));
sleeping.once('exit',(code,signal)=>{
console.log(JSON.stringify({baseline:JSON.parse(baseline.stdout),agent:result,cancelled:signal==='SIGTERM',
 parentProfile:fs.readFileSync('/proc/self/attr/current','utf8').trim(),uid:process.getuid(),readEnvironmentBytes:0}));
});
'''


def main(profile_source, image):
    if os.getuid() != 0 or not image.startswith('sha256:') or len(image) != 71:
        raise RuntimeError('root_and_existing_image_required')
    identifier = uuid.uuid4().hex
    control, agent = 'paperclip-q-' + identifier + '-control', 'paperclip-q-' + identifier + '-agent'
    source = pathlib.Path(profile_source).read_text()
    source = source.replace('paperclip-control', control).replace('paperclip-agent', agent)
    existing = pathlib.Path('/sys/kernel/security/apparmor/profiles').read_text()
    if control in existing or agent in existing:
        raise RuntimeError('qualification_profile_not_fresh')
    name = 'paperclip-isolation-' + identifier
    loaded = False
    with tempfile.TemporaryDirectory(prefix='paperclip-isolation-', dir='/opt') as temp:
        root = pathlib.Path(temp); root.chmod(0o755)
        policy = root / 'profiles'; policy.write_text(source); policy.chmod(0o644)
        (root / 'peer.js').write_text(PEER); (root / 'peer.js').chmod(0o644)
        (root / 'parent.js').write_text(PARENT); (root / 'parent.js').chmod(0o644)
        secret = root / 'dummy'; secret.write_text('synthetic-only'); secret.chmod(0o600); os.chown(secret,1000,1000)
        subprocess.run(['/sbin/apparmor_parser','-Q',str(policy)],check=True,capture_output=True)
        try:
            subprocess.run(['/sbin/apparmor_parser','-a',str(policy)],check=True,capture_output=True); loaded=True
            lib = pathlib.Path('/usr/lib/x86_64-linux-gnu/libapparmor.so.1').resolve(strict=True)
            command = ['docker','run','--rm','--name',name,'--network','none','--read-only','--user','1000:1000',
                '--cpus','1','--memory','512m','--pids-limit','128','--security-opt','apparmor='+control,
                '--tmpfs','/tmp:rw,nosuid,nodev,size=64m',
                '--mount',f'type=bind,src={root}/parent.js,dst=/opt/qualification/parent.js,readonly',
                '--mount',f'type=bind,src={root}/peer.js,dst=/opt/qualification/peer.js,readonly',
                '--mount','type=bind,src=/usr/bin/aa-exec,dst=/opt/qualification/aa-exec,readonly',
                '--mount',f'type=bind,src={lib},dst=/usr/lib/x86_64-linux-gnu/libapparmor.so.1,readonly',
                '--mount',f'type=bind,src={secret},dst=/paperclip/instances/fixture/secrets/dummy,readonly',
                '--entrypoint','node',image,'/opt/qualification/parent.js',control,agent]
            done = subprocess.run(command, capture_output=True, text=True, timeout=25)
            if done.returncode:
                raise RuntimeError('isolated_profile_qualification_failed')
            result = json.loads(done.stdout)
            observed = result['agent']
            print(json.dumps({'measurementOnly':True,'measurements':result}),flush=True)
            if not (result['baseline']['environmentOpenable'] and result['cancelled'] and observed['workspaceWritable'] and
                    observed['label'].startswith(agent+' ') and result['parentProfile'].startswith(control+' ') and
                    observed['uid']==1000 and observed['gid']==1000 and
                    not any(observed[key] for key in ['environmentOpenable','pipeOpenable','peerPipeOpenable','secretOpenable',
                                                       'secretAliasOpenable','profileEscapeSucceeded'])):
                raise RuntimeError('agent_boundary_not_enforced')
            print(json.dumps({'passed':True,'measurements':result,'policySha256':hashlib.sha256(source.encode()).hexdigest(),
                'image':image,'imagesBuilt':0,'providersStarted':0,'candidateTests':0}))
        finally:
            subprocess.run(['docker','rm','-f',name],capture_output=True)
            if loaded:
                subprocess.run(['/sbin/apparmor_parser','-R',str(policy)],check=True,capture_output=True)


if __name__ == '__main__':
    main(*sys.argv[1:])
