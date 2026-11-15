"""OpenSSL→Node signature and identity vectors; disposable networkless fixture."""
import base64
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import uuid


def main(bridge_path,image):
    bridge=pathlib.Path(bridge_path).resolve(strict=True)
    if os.getuid()!=0 or not image.startswith('sha256:') or len(image)!=71:raise RuntimeError('root_existing_image_required')
    sys.path.insert(0,str(bridge/'broker'))
    from native_envelope import EnvelopeSigner
    from contracts import digest,stable_input,job_id
    from native_transport import wake_receipt
    vector=json.loads((bridge/'tests/fixtures/native-protocol-vectors.json').read_text())
    request=vector['request'];job=job_id(request)
    if job!=vector['jobId'] or digest(stable_input(request))!=vector['requestDigest']:raise RuntimeError('python_identity_vector_mismatch')
    if wake_receipt(request['companyId'],vector['pluginId'],vector['wakeKey'],request['taskId'],request['agentId'],
                    'runner_result_received','ubuntu.runner.result')!=(vector['wakeId'],vector['wakeDigest']):raise RuntimeError('python_wake_vector_mismatch')
    name='paperclip-envelope-'+uuid.uuid4().hex
    with tempfile.TemporaryDirectory(prefix='paperclip-envelope-',dir='/opt') as directory:
        root=pathlib.Path(directory);root.chmod(0o700)
        key=root/'fixture-key.pem'
        subprocess.run(['/usr/bin/openssl','genpkey','-algorithm','ED25519','-out',str(key)],check=True,capture_output=True);key.chmod(0o600)
        public=subprocess.check_output(['/usr/bin/openssl','pkey','-in',str(key),'-pubout']).decode()
        value={'schema':'paperclip.runner-envelope.v1','pluginKey':'paperclip.ubuntu-runner-results','pluginId':vector['pluginId'],
            'kind':'admission','companyId':request['companyId'],'projectId':request['projectId'],'issueId':request['taskId'],
            'agentId':request['agentId'],'jobId':job,'requestDigest':vector['requestDigest'],'sequence':0,'data':{'jobId':job,'state':'queued'}}
        envelope=EnvelopeSigner(str(key)).sign(value)
        payload={'envelope':envelope,'publicKey':public,'vector':vector}
        program="""
import fs from 'node:fs';import {createPublicKey,createHash} from 'node:crypto';
import {verifyEnvelope} from '/code/native-envelope.mjs';
import {jobId,digest,stableInput} from '/code/native-contracts.mjs';
const {envelope,publicKey,vector}=JSON.parse(fs.readFileSync(0,'utf8'));
const trust={publicKey:createPublicKey(publicKey),pluginId:vector.pluginId,brokerUserId:'fixture-broker'};
const context={companyId:vector.request.companyId,actor:{type:'user',userId:'fixture-broker',companyId:vector.request.companyId}};
const accepted=verifyEnvelope(envelope,context,trust);
let tamperRejected=false,agentRejected=false;
try{verifyEnvelope({...envelope,payload:Buffer.from('{}').toString('base64')},context,trust)}catch{tamperRejected=true}
try{verifyEnvelope(envelope,{...context,actor:{...context.actor,type:'agent'}},trust)}catch{agentRejected=true}
if(accepted.jobId!==vector.jobId||jobId(vector.request)!==vector.jobId||digest(stableInput(vector.request))!==vector.requestDigest||!tamperRejected||!agentRejected)throw Error('cross_language_vector_failed');
console.log(JSON.stringify({opensslToNodeVerified:true,jobIdentityVerified:true,wakeIdentityVerifiedByPython:true,tamperRejected,agentRejected}));
"""
        # stdin is only public key, signed fixture bytes and non-secret vectors.
        command=['docker','run','--rm','--name',name,'--network','none','--read-only','--user','1000:1000',
            '--cpus','1','--memory','256m','--pids-limit','64','-i','--mount',f'type=bind,src={bridge}/plugin,dst=/code,readonly',
            '--entrypoint','node',image,'--input-type=module','-e',program]
        try:
            result=subprocess.run(command,input=json.dumps(payload),capture_output=True,text=True,timeout=25)
            if result.returncode:raise RuntimeError('native_signature_qualification_failed')
            measured=json.loads(result.stdout)
            print(json.dumps({'passed':True,**measured,'ephemeralKeyRemovedOnExit':True,'imagesBuilt':0,'providerRuns':0,'candidateRuns':0}))
        finally:subprocess.run(['docker','rm','-f',name],capture_output=True)


if __name__=='__main__':main(*sys.argv[1:])
