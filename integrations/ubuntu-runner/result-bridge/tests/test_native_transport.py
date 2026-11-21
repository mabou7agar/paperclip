import base64
import json
import pathlib
import sys
import tempfile
import subprocess
import unittest
import uuid
from unittest.mock import Mock, patch

sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'broker'))
from contracts import Refusal, canonical, digest, job_id
from native_transport import NativeTransport, wake_receipt
from repository import JobRepository


class NativeFixture:
    def __init__(self,request,plugin):
        self.request,self.plugin=request,plugin
        self.rows=[{'key':job_id(request),'issue':request['taskId'],'value':request,'withinRun':True,'sourceMatches':True}]
        self.actions=[];self.admissions={};self.http_only=False;self.wake=False;self.lose_result_response=False
        self.issue={'companyId':request['companyId'],'projectId':request['projectId'],'assigneeAgentId':request['agentId'],'status':'in_progress'}
        self.document=None;self.policy_enabled=False;self.policy_receipt=None;self.policy_owned=False

    def query(self,sql):
        if 'FROM plugins ' in sql:return [{'id':self.plugin,'status':'ready','key':'paperclip.ubuntu-runner-results'}]
        if 'FROM plugin_state s LEFT' in sql:return self.rows
        if "namespace='runner-admissions'" in sql:return [{'matches':bool(self.admissions)}] if self.admissions else []
        if 'to_regclass' in sql:return [{'available':self.policy_enabled}]
        if 'FROM runner_recovery_results r' in sql:
            if not self.policy_receipt or "r.envelope_sha256='%s'" % self.policy_receipt not in sql:
                return []
            return [{'matches':self.policy_owned}]
        if 'FROM agent_wakeup_requests' in sql:return [{'matches':self.wake}] if self.wake else []
        return []

    def deliver_envelope(self,plugin,envelope):
        value=json.loads(base64.b64decode(envelope['payload']))
        assert plugin==self.plugin
        if self.http_only:return {'status':'success'}
        self.actions.append(value)
        if value['kind']=='admission':self.rows=[];self.admissions[value['jobId']]=envelope
        else:
            if self.policy_enabled:
                self.policy_receipt=digest(envelope)
            else:
                self.wake=True
            if self.lose_result_response:raise OSError('lost response after native receipt commit')
        return {'data':{'recorded':True}}

    def read(self,url):
        if '/documents/' in url:
            if not self.document:raise RuntimeError('native_read_unavailable')
            return self.document
        return self.issue


class NativeTransportTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=pathlib.Path(self.temp.name).resolve();self.root.chmod(0o700)
        self.repo=JobRepository(self.root)
        self.request={key:str(uuid.uuid4()) for key in ['taskId','attachmentId','companyId','projectId','agentId','sourceRunId']}
        self.request.update(profile='fixture',kind='control_checks',packetSha256='a'*64,scopeIssueId=None,scopeCommentId=None,ackCommentId=None,recipe='fixture-new.py')
        self.plugin=str(uuid.uuid4());self.native=NativeFixture(self.request,self.plugin)
        receipt=self.root/'isolation.json'
        policy=self.root/'policy';policy.write_text('synthetic-policy-only');policy.chmod(0o600)
        # Synthetic fixture authority only; never published as a live receipt.
        receipt.write_bytes(canonical({'schema':'paperclip.agent-isolation.v2','actualAgentQualified':True,
            'serverEnvironmentOpenable':False,'serverPipeOpenable':False,'serverVaultOpenable':False,
            'serverConfigOpenable':False,'serverEnvironmentFileOpenable':False,'serverDatabaseOpenable':False,
            'serverBackupOpenable':False,'serverLogOpenable':False,'serverPluginWritable':False,
            'serverHomeControlWritable':False,'serverGitEscapesConfinement':False,
            'serverAncestorRenameAllowed':False,'serverRepositoryHelperEscapesConfinement':False,
            'policySha256':__import__('hashlib').sha256(policy.read_bytes()).hexdigest()}));receipt.chmod(0o600)
        self.config={'profiles':{'fixture':{'companyId':self.request['companyId']}},'nativeQueue':{'pluginId':self.plugin,
            'signingKeyFile':str(self.root/'unused-fixture-key'),'isolationReceiptFile':str(receipt),'agentPolicyFile':str(policy),
            'isolationReceiptSha256':__import__('hashlib').sha256(receipt.read_bytes()).hexdigest()}}
        self.service=Mock(repository=self.repo)
        self.service.admission.assert_profile=Mock()
        self.service.profile.return_value={'policyDigest':'p'}
        self.created=0
        def submit(request):
            identity,created=self.repo.register(request,'p');self.created+=int(created)
            return {'jobId':identity,'state':'queued','replayed':not created}
        self.service.submit.side_effect=submit
        self.patcher=patch('native_transport.EnvelopeSigner');signer=self.patcher.start().return_value
        signer.sign.side_effect=lambda value:{'payload':base64.b64encode(canonical(value)).decode(),'signature':'synthetic-test-only'}
        self.transport=NativeTransport(self.config,self.service,self.native)

    def tearDown(self):
        self.patcher.stop();self.temp.cleanup()

    def test_pending_scan_replays_one_immutable_job_and_late_commit_is_not_lost(self):
        original=self.native.rows;self.native.rows=[];self.transport.receive()
        self.native.rows=original;self.transport.receive();self.transport.receive()
        self.assertEqual(self.created,1)
        self.native.rows=[{**original[0],'value':{**self.request,'attachmentId':str(uuid.uuid4())}}]
        self.transport.receive();self.assertEqual(self.service.submit.call_count,2)
        self.assertEqual(self.created,1)

    def test_host_run_window_and_scope_are_required_before_registration(self):
        for key in ['withinRun','sourceMatches']:
            self.native.rows[0][key]=False;self.transport.receive();self.native.rows[0][key]=True
        self.assertEqual(self.service.submit.call_count,0)
        self.assertEqual(self.created,0)

    def test_lost_result_response_then_broker_restart_reads_native_ack_before_another_push(self):
        self.transport.receive();self.transport.deliver()
        identity=job_id(self.request)
        self.repo.terminal(identity,{'jobId':identity,'companyId':self.request['companyId'],'projectId':self.request['projectId'],
            'issueId':self.request['taskId'],'agentId':self.request['agentId'],'profile':'fixture','status':'passed',
            'receiptSha256':'b'*64,'fingerprint':'c'*64,'result':{'status':'passed','cleanupComplete':True}})
        self.native.lose_result_response=True;self.transport.deliver()
        self.assertEqual(len([x for x in self.native.actions if x['kind']=='result']),1)
        restarted=NativeTransport(self.config,self.service,self.native);restarted.deliver()
        self.assertEqual(len([x for x in self.native.actions if x['kind']=='result']),1)
        self.assertEqual(self.repo.pending(),[]);self.assertEqual(self.created,1)

    def test_exact_policy_receipt_recovers_lost_response_without_legacy_wake(self):
        self.transport.receive();self.transport.deliver()
        identity=job_id(self.request)
        result={'jobId':identity,'companyId':self.request['companyId'],'projectId':self.request['projectId'],
            'issueId':self.request['taskId'],'agentId':self.request['agentId'],'profile':'fixture','status':'failed',
            'receiptSha256':'b'*64,'fingerprint':'c'*64,'newEvidence':True,
            'result':{'status':'failed','cleanupComplete':True}}
        self.repo.terminal(identity,result)
        self.native.policy_enabled=True
        self.native.lose_result_response=True
        self.transport.deliver()
        self.assertEqual(self.repo.pending(),[identity])
        self.assertFalse(self.native.wake)

        # Only the same committed result and a positive native handoff can
        # settle the broker delivery. A different signed receipt stays pending.
        self.native.policy_owned=True
        native_receipt=self.native.policy_receipt
        self.native.policy_receipt='0'*64
        self.assertFalse(self.transport.result_acknowledged(self.request,result,'runner-result:'+identity+':'+result['receiptSha256']))
        self.native.policy_receipt=native_receipt
        restarted=NativeTransport(self.config,self.service,self.native)
        restarted.deliver()
        self.assertEqual(self.repo.pending(),[])
        self.assertEqual(len([x for x in self.native.actions if x['kind']=='result']),1)
        self.assertEqual(self.created,1)

    def test_optional_policy_read_failure_does_not_block_ordinary_callback(self):
        self.transport.receive();self.transport.deliver()
        identity=job_id(self.request)
        self.repo.terminal(identity,{'jobId':identity,'companyId':self.request['companyId'],'projectId':self.request['projectId'],
            'issueId':self.request['taskId'],'agentId':self.request['agentId'],'profile':'fixture','status':'failed',
            'receiptSha256':'b'*64,'fingerprint':'c'*64,'newEvidence':True,
            'result':{'status':'failed','cleanupComplete':True}})
        with patch.object(self.transport.reader,'policy_result_matches',side_effect=Refusal('native_attestation_unavailable')):
            self.transport.deliver()
        self.assertTrue(self.native.wake)
        self.assertEqual(self.repo.pending(),[])
        self.assertEqual(len([x for x in self.native.actions if x['kind']=='result']),1)

    def test_webhook_http_success_alone_cannot_ack_admission_or_result(self):
        self.transport.receive();self.native.http_only=True
        self.transport.deliver()
        self.assertEqual(len(self.transport.ledger.pending_admissions()),1)
        identity=job_id(self.request)
        self.repo.terminal(identity,{'jobId':identity,'companyId':self.request['companyId'],'projectId':self.request['projectId'],
            'issueId':self.request['taskId'],'agentId':self.request['agentId'],'profile':'fixture','status':'passed',
            'receiptSha256':'b'*64,'fingerprint':'c'*64,'result':{'status':'passed','cleanupComplete':True}})
        self.transport.deliver()
        self.assertEqual(self.repo.pending(),[identity]);self.assertEqual(self.created,1)
        self.native.http_only=False;self.transport.deliver()
        self.assertEqual(self.repo.pending(),[]);self.assertEqual(self.transport.ledger.pending_admissions(),[])

    def test_native_plugin_reinstall_or_changed_isolation_receipt_fails_closed(self):
        self.native.query=Mock(return_value=[])
        with self.assertRaises(Exception):self.transport.receive()
        pathlib.Path(self.config['nativeQueue']['isolationReceiptFile']).write_text('{}')
        with self.assertRaises(Exception):NativeTransport(self.config,self.service,self.native)

    def test_missing_bypass_measurement_or_changed_final_policy_cannot_activate(self):
        import hashlib
        receipt=pathlib.Path(self.config['nativeQueue']['isolationReceiptFile'])
        original=json.loads(receipt.read_bytes())
        for key in ['serverConfigOpenable','serverPluginWritable','serverGitEscapesConfinement','serverAncestorRenameAllowed','serverRepositoryHelperEscapesConfinement']:
            altered=dict(original);del altered[key];receipt.write_bytes(canonical(altered))
            self.config['nativeQueue']['isolationReceiptSha256']=hashlib.sha256(receipt.read_bytes()).hexdigest()
            with self.assertRaises(Exception):NativeTransport(self.config,self.service,self.native)
        receipt.write_bytes(canonical(original))
        self.config['nativeQueue']['isolationReceiptSha256']=hashlib.sha256(receipt.read_bytes()).hexdigest()
        pathlib.Path(self.config['nativeQueue']['agentPolicyFile']).write_text('different-policy')
        with self.assertRaises(Exception):NativeTransport(self.config,self.service,self.native)

    def test_recorded_only_ack_requires_real_plugin_document_and_closed_task(self):
        result={'jobId':job_id(self.request),'companyId':self.request['companyId'],'projectId':self.request['projectId'],
            'issueId':self.request['taskId'],'agentId':self.request['agentId'],'profile':'fixture','status':'passed',
            'receiptSha256':'d'*64,'fingerprint':'e'*64,'newEvidence':True,'result':{'status':'passed','cleanupComplete':True}}
        module=(pathlib.Path(__file__).resolve().parents[1]/'plugin/result-service.mjs').as_uri()
        program="""
import {ResultService} from %s;
let raw='';for await(const chunk of process.stdin)raw+=chunk;
const result=JSON.parse(raw);let document;
const ctx={config:{get:async()=>({profiles:['fixture']})},issues:{
 get:async()=>({companyId:result.companyId,projectId:result.projectId,status:'done'}),
 documents:{get:async()=>null,upsert:async value=>{document=value;}}}};
await new ResultService(ctx,{call:async()=>({acknowledged:true})}).deliverResult(result);
console.log(JSON.stringify(document));
""" % json.dumps(module)
        rendered=subprocess.run(['node','--input-type=module','-e',program],input=json.dumps(result),
            text=True,capture_output=True,check=True,timeout=10)
        self.native.document=json.loads(rendered.stdout)
        self.assertFalse(self.transport.recorded_only(self.request,result))
        self.native.issue['status']='done'
        self.assertTrue(self.transport.recorded_only(self.request,result))
        self.assertFalse(self.transport.recorded_only(self.request,{**result,'fingerprint':'f'*64}))

    def test_reconciled_receipt_sequence_is_newer_without_consuming_it_on_old_ack(self):
        identity,_=self.repo.register(self.request,'p')
        result={'jobId':identity,'companyId':self.request['companyId'],'projectId':self.request['projectId'],
            'issueId':self.request['taskId'],'agentId':self.request['agentId'],'profile':'fixture','status':'unknown',
            'receiptSha256':'1'*64,'fingerprint':'2'*64,'result':{'status':'unknown','cleanupComplete':False}}
        self.repo.terminal(identity,result)
        first=self.repo.delivery_sequence(identity,result['receiptSha256'])
        newer={**result,'status':'passed','receiptSha256':'3'*64,'result':{'status':'passed','cleanupComplete':True}}
        self.repo.terminal(identity,newer)
        self.assertGreater(self.repo.delivery_sequence(identity,newer['receiptSha256']),first)
        self.repo.acknowledge(identity,result['receiptSha256'])
        self.assertEqual(self.repo.pending(),[identity])
        self.repo.acknowledge(identity,newer['receiptSha256'])
        self.assertEqual(self.repo.pending(),[])


if __name__=='__main__':unittest.main()
