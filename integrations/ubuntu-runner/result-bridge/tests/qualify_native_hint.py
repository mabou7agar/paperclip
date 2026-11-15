"""Real Linux UID/profile-bound notification and durable ACK; no native task run."""
import hashlib
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import uuid


def main(bridge_path,image):
    if os.getuid()!=0 or not image.startswith('sha256:') or len(image)!=71:raise RuntimeError('root_existing_image_required')
    bridge=pathlib.Path(bridge_path).resolve(strict=True);sys.path.insert(0,str(bridge/'broker'))
    from repository import JobRepository
    from native_queue_repository import NativeQueueRepository
    from native_work_loop import NativeHintInbox
    marker=uuid.uuid4().hex;control='paperclip-h-'+marker+'-control';agent='paperclip-h-'+marker+'-agent'
    source=(bridge/'agent-isolation.apparmor').read_text().replace('paperclip-control',control).replace('paperclip-agent',agent)
    if any(value in pathlib.Path('/sys/kernel/security/apparmor/profiles').read_text() for value in [control,agent]):raise RuntimeError('fresh_profiles_required')
    with tempfile.TemporaryDirectory(prefix='paperclip-hint-',dir='/opt') as directory:
        root=pathlib.Path(directory);root.chmod(0o755)
        state=root/'state';state.mkdir(mode=0o700);public=root/'public';public.mkdir(mode=0o755)
        policy=root/'policy';policy.write_text(source);policy.chmod(0o644)
        (public/'native-wake.mjs').write_bytes((bridge/'plugin/native-wake.mjs').read_bytes());(public/'native-wake.mjs').chmod(0o644)
        request={key:str(uuid.uuid4()) for key in ['companyId','jobId','sourceRunId','taskId']}
        program="import {notifyNativeBroker} from '/opt/qualification/native-wake.mjs';const accepted=await notifyNativeBroker("+json.dumps(request)+");console.log(JSON.stringify({accepted,uid:process.getuid(),label:(await import('node:fs')).readFileSync('/proc/self/attr/current','utf8').trim()}));"
        loaded=False;inbox=None;names=[]
        try:
            subprocess.run(['/sbin/apparmor_parser','-Q',str(policy)],capture_output=True,check=True)
            subprocess.run(['/sbin/apparmor_parser','-a',str(policy)],capture_output=True,check=True);loaded=True
            repository=JobRepository(state);ledger=NativeQueueRepository(repository)
            inbox=NativeHintInbox(ledger,{request['companyId']},path=str(public/'wake.sock'),peer_profile=control)
            outcomes={}
            for role,profile in [('control',control),('agent',agent)]:
                name='paperclip-hint-'+marker+'-'+role;names.append(name)
                args=['docker','run','--rm','--name',name,'--network','none','--read-only','--user','1000:1000',
                    '--cpus','1','--memory','256m','--pids-limit','64','--security-opt','apparmor='+profile,
                    '--mount',f'type=bind,src={public},dst=/opt/paperclip-runner-wake,readonly',
                    '--mount',f'type=bind,src={public}/native-wake.mjs,dst=/opt/qualification/native-wake.mjs,readonly',
                    '--entrypoint','node',image,'--input-type=module','-e',program]
                result=subprocess.run(args,text=True,capture_output=True,timeout=12)
                if result.returncode:raise RuntimeError('hint_peer_fixture_failed:'+role+':'+result.stderr[-1800:])
                outcomes[role]=json.loads(result.stdout)
            recovered=NativeQueueRepository(JobRepository(state))
            print(json.dumps({'measurementOnly':True,'outcomes':outcomes,'pendingHint':recovered.has_pending_hints(),
                'unfinishedJobs':len(repository.unfinished()),'lastRefusalCode':inbox.last_refusal_code}),flush=True)
            if not (outcomes['control']['accepted'] is True and outcomes['control']['uid']==1000 and
                    outcomes['agent']['accepted'] is False and outcomes['agent']['uid']==1000 and
                    recovered.has_pending_hints() and repository.unfinished()==[]):raise RuntimeError('hint_boundary_or_durability_failed')
            print(json.dumps({'passed':True,'controlUidProfileAccepted':True,'sameUidAgentRejected':True,
                'durableHintSurvivesReaderRestart':True,'executionAuthorityGranted':False,'nativeCalls':0,'providerRuns':0,
                'candidateRuns':0,'imagesBuilt':0,'policySha256':hashlib.sha256((bridge/'agent-isolation.apparmor').read_bytes()).hexdigest()}))
        finally:
            if inbox:inbox.close()
            for name in names:subprocess.run(['docker','rm','-f',name],capture_output=True,timeout=10)
            if loaded:subprocess.run(['/sbin/apparmor_parser','-R',str(policy)],capture_output=True,check=True)


if __name__=='__main__':main(*sys.argv[1:])
