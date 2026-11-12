"""Pure operator guards only: no Docker, production reads, providers or jobs."""
import ast, copy, datetime, hashlib, json, os, pathlib, re, stat, tempfile, types, unittest

SOURCE=pathlib.Path(__file__).with_name('qualify-final-source-candidate.py')
NAMES={'assert_controller_binding','assert_container_security','read_regular_bytes','read_regular_text','assert_regular_tree','security'}
namespace={'Path':pathlib.Path,'os':os,'stat':stat,'hashlib':hashlib,'re':re,'datetime':datetime,'json':json}
module=ast.Module(body=[n for n in ast.parse(SOURCE.read_text()).body if isinstance(n,ast.FunctionDef)and n.name in NAMES],type_ignores=[])
exec(compile(module,str(SOURCE),'exec'),namespace)

def baseline():
 return {'Config':{'User':'1000:1000','Labels':{'paperclip.operator.candidate':'synthetic'}},'State':{'Running':True,'StartedAt':datetime.datetime.now(datetime.timezone.utc).isoformat()},'Mounts':[],
  'HostConfig':{'NetworkMode':'none','Privileged':False,'CapDrop':['ALL'],'CapAdd':None,'Devices':None,'DeviceRequests':None,'DeviceCgroupRules':None,'SecurityOpt':['no-new-privileges'],'PidsLimit':256,'Memory':6*1024**3,'NanoCpus':2000000000}}

class Safety(unittest.TestCase):
 def test_security_checks_actual_controller_and_new_drift_fields(self):
  raw=baseline();namespace.update(ident=lambda:'fixture',s={'candidate':'synthetic'},run=lambda _:types.SimpleNamespace(stdout=json.dumps([raw]).encode()))
  self.assertEqual(namespace['security'](1),'fixture')
  for field,bad in [('SecurityOpt',None),('SecurityOpt',['no-new-privileges','seccomp=unconfined']),('CapAdd',['SYS_ADMIN']),('Devices',[{'PathOnHost':'/dev/sda'}]),('DeviceRequests',[{}]),('DeviceCgroupRules',['a *:* rwm']),('PidsLimit',0),('PidsLimit',257)]:
   with self.subTest(field=field,bad=bad):
    raw=baseline();raw['HostConfig'][field]=bad
    with self.assertRaises(AssertionError):namespace['security'](1)
 def test_host_reads_refuse_leaf_parent_links_and_special_files(self):
  with tempfile.TemporaryDirectory()as tmp:
   root=pathlib.Path(tmp);outside=root/'outside';outside.write_text('must not publish');good=root/'evidence';good.mkdir();(good/'receipt').write_text('valid')
   self.assertEqual(namespace['read_regular_text'](good/'receipt'),'valid');namespace['assert_regular_tree'](good)
   (good/'receipt').unlink();(good/'receipt').symlink_to(outside)
   with self.assertRaises(OSError):namespace['read_regular_bytes'](good/'receipt')
   with self.assertRaises(ValueError):namespace['assert_regular_tree'](good)
   (good/'receipt').unlink();(root/'alias').symlink_to(good,target_is_directory=True);(good/'receipt').write_text('valid')
   with self.assertRaises(OSError):namespace['read_regular_bytes'](root/'alias'/'receipt')
   fifo=root/'fifo';os.mkfifo(fifo)
   with self.assertRaises(ValueError):namespace['read_regular_bytes'](fifo)
 def test_controller_requires_the_reviewed_byte_binding(self):
  with tempfile.TemporaryDirectory()as tmp:
   source=pathlib.Path(tmp)/'controller.py';source.write_text('approved bytes');namespace['__file__']=str(source)
   prior=os.environ.get('PAPERCLIP_OPERATOR_CONTROLLER_SHA256')
   try:
    os.environ.pop('PAPERCLIP_OPERATOR_CONTROLLER_SHA256',None)
    with self.assertRaisesRegex(AssertionError,'required'):namespace['assert_controller_binding']()
    os.environ['PAPERCLIP_OPERATOR_CONTROLLER_SHA256']=hashlib.sha256(source.read_bytes()).hexdigest();namespace['assert_controller_binding']()
    source.write_text('changed bytes')
    with self.assertRaisesRegex(AssertionError,'mismatch'):namespace['assert_controller_binding']()
   finally:
    if prior is None:os.environ.pop('PAPERCLIP_OPERATOR_CONTROLLER_SHA256',None)
    else:os.environ['PAPERCLIP_OPERATOR_CONTROLLER_SHA256']=prior
 def test_copy_guard_runs_before_consumption(self):
  text=SOURCE.read_text()
  self.assertIn("if copied[label]:assert_regular_tree(dest)",text)
  # Every actual Python file read in the copied-input controller uses the
  # descriptor-safe reader, including logs/receipts hashed for publication.
  unsafe=[n for n in ast.walk(ast.parse(text))if isinstance(n,ast.Call)and isinstance(n.func,ast.Attribute)and n.func.attr in ('read_text','read_bytes')]
  self.assertEqual(unsafe,[])

if __name__=='__main__':unittest.main()
