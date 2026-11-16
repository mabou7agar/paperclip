"""Old stopped-container/new-reader and pre-cleanup durable fact regressions."""
import copy,json,pathlib,sys,tempfile,unittest
from types import SimpleNamespace
from unittest.mock import Mock,patch
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'broker'))
import control_results as results
from contracts import Refusal,digest

class CompletionTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=pathlib.Path(self.temp.name)
        (self.root/'packet.tar.gz').write_bytes(b'previous-release-packet')
        self.plan={'jobId':'owned','profile':{'uid':1001,'gid':999,'preparedImage':'sha256:'+'a'*64},
                   'request':{'recipe':'fixture-new.py','packetSha256':'b'*64},'admission':{'controlDigest':'c'*64}}
        self.packet=SimpleNamespace(file_sha=lambda name:'d'*64)
        self.facts={'uid':1001,'network':'none','workspaceMounts':0,'exit':0,'scratchRemoved':True,'overflow':False,'timedOut':False,'checks':{'newControls':39,'oldChecks':0}}
        self.identity={'job':'owned','plan':digest(self.plan),'running':False,'exit':0,'image':'sha256:'+'a'*64,'user':'1001:999','network':'none','readonly':True,'privileged':False,'mountCount':0,'capDrop':['ALL'],'securityOpt':['no-new-privileges']}
        self.capture={'exit':0,'timedOut':False,'stdout':{'overflow':False,'retained':json.dumps(self.facts).encode()},'stderr':{'overflow':False,'bytes':0}}
        self.ledger=Mock();self.ledger.read.side_effect=lambda name:json.loads((self.root/name).read_bytes())
        self.ledger.once.side_effect=lambda name,value:(self.root/name).write_text(json.dumps(value))
        self.patches=[patch.object(results,'Packet',return_value=self.packet),patch.object(results,'OwnershipLedger',return_value=self.ledger)]
        for p in self.patches:p.start()
    def tearDown(self):
        for p in reversed(self.patches):p.stop()
        self.temp.cleanup()
    def test_legacy_stopped_owned_container_recovers_actual_pass_without_start(self):
        with patch.object(results,'capture',return_value=self.capture)as capture:
            value=results.recover_completion(self.root,self.plan,self.identity)
            self.assertEqual(value['status'],'passed');self.assertFalse(value['cleanupComplete'])
            self.assertEqual(value['facts']['checks']['newControls'],39)
            self.assertEqual(capture.call_args.args[0],['docker','logs','paperclip-controls-owned'])
            self.assertTrue((self.root/results.NAME).exists())
    def test_durable_completion_survives_lost_cleanup_ack_without_docker_logs(self):
        value=results.validated_result(self.plan,self.packet,self.facts);results.preserve_completion(self.root,self.plan,value)
        with patch.object(results,'capture')as capture:
            self.assertEqual(results.recover_completion(self.root,self.plan,None),value);capture.assert_not_called()
    def test_mismatched_scope_or_result_does_not_reuse_saved_record(self):
        value=results.validated_result(self.plan,self.packet,self.facts);results.preserve_completion(self.root,self.plan,value)
        raw=json.loads((self.root/results.NAME).read_text());raw['planSha256']='f'*64;(self.root/results.NAME).write_text(json.dumps(raw))
        with self.assertRaises(Refusal):results.recover_completion(self.root,self.plan,None)
    def test_unsafe_container_cannot_supply_a_pass_or_be_removed(self):
        for field,bad in [('job','foreign'),('plan','foreign'),('image','foreign'),('user','0:0'),('network','host'),('readonly',False),('privileged',True),('mountCount',1),('capDrop',[]),('securityOpt',[])]:
            with self.subTest(field=field),patch.object(results,'capture')as capture:
                altered={**self.identity,field:bad}
                with self.assertRaises(Refusal):results.recover_completion(self.root,self.plan,altered)
                capture.assert_not_called()
    def test_running_or_nonzero_outer_exit_is_never_inferred_as_pass(self):
        for identity in [None,{**self.identity,'running':True},{**self.identity,'exit':1}]:
            with patch.object(results,'capture')as capture:
                self.assertIsNone(results.recover_completion(self.root,self.plan,identity));capture.assert_not_called()
    def test_unavailable_or_overflowed_logs_fail_closed(self):
        for altered in [{**self.capture,'exit':1},{**self.capture,'timedOut':True},{**self.capture,'stdout':{**self.capture['stdout'],'overflow':True}},{**self.capture,'stderr':{'bytes':1,'overflow':False}}]:
            with self.subTest(altered=altered),patch.object(results,'capture',return_value=altered):
                with self.assertRaises(Refusal):results.recover_completion(self.root,self.plan,self.identity)
    def test_malformed_or_concatenated_log_json_has_named_wait_without_cleanup(self):
        for raw in [b'not-json', b'{}{}', b'\xff']:
            output=copy.deepcopy(self.capture);output['stdout']['retained']=raw
            with self.subTest(raw=raw),patch.object(results,'capture',return_value=output):
                with self.assertRaises(Refusal) as error:results.recover_completion(self.root,self.plan,self.identity)
                self.assertEqual(error.exception.code,'control_completion_unavailable')
                self.assertFalse((self.root/results.NAME).exists())
    def test_nonzero_inner_exit_remains_failed(self):
        self.assertEqual(results.validated_result(self.plan,self.packet,{**self.facts,'exit':1})['status'],'failed')
    def test_timeout_or_incomplete_scratch_is_not_pass(self):
        for changed in [{'timedOut':True},{'scratchRemoved':False},{'workspaceMounts':1},{'exit':False}]:
            with self.subTest(changed=changed):
                with self.assertRaises(Refusal):results.validated_result(self.plan,self.packet,{**self.facts,**changed})
if __name__=='__main__':unittest.main()
