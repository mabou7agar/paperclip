"""New-only SSH/npm directory controls, not a repeat of the accepted Git/proc cases."""
import hashlib,json,os,pathlib,subprocess,sys,tempfile,uuid
PROGRAM=r'''
const fs=require('node:fs'),cp=require('node:child_process');
const paths=[['/paperclip/.ssh','config'],['/paperclip/.config/npm','npmrc']];
if(process.argv[2]==='peer'){
 const cases=paths.map(([target,child])=>{const moved=target+'-moved';let renamed=false,read=false,replaced=false;
 try{fs.renameSync(target,moved);renamed=true;const fd=fs.openSync(moved+'/'+child,'r');fs.closeSync(fd);read=true;fs.mkdirSync(target);fs.writeFileSync(target+'/replacement','synthetic');replaced=true;}
 catch{}finally{if(renamed){fs.rmSync(target,{force:true,recursive:true});fs.renameSync(moved,target);}}
 return{renamed,read,replaced};});
 console.log(JSON.stringify({cases,label:fs.readFileSync('/proc/self/attr/current','utf8').trim(),uid:process.getuid()}));
}else{
 const control=cp.spawnSync('node',['/opt/qualification/extra.cjs','peer'],{encoding:'utf8'});
 const agent=cp.spawnSync('/opt/qualification/aa-exec',['-p',process.argv[2],'--','node','/opt/qualification/extra.cjs','peer'],{encoding:'utf8'});
 if(control.status||agent.status)throw Error('extra_path_child_failed');
 console.log(JSON.stringify({control:JSON.parse(control.stdout),agent:JSON.parse(agent.stdout)}));
}
'''
def main(policy_path,image):
 if os.getuid()!=0 or not image.startswith('sha256:')or len(image)!=71:raise RuntimeError('root_existing_image_required')
 marker=uuid.uuid4().hex;control='paperclip-extra-'+marker+'-control';agent='paperclip-extra-'+marker+'-agent';name='pc-extra-'+marker
 source=pathlib.Path(policy_path).read_bytes();text=source.decode().replace('paperclip-control',control).replace('paperclip-agent',agent)
 loaded=False
 with tempfile.TemporaryDirectory(prefix='pc-extra-paths-',dir='/opt')as temp:
  root=pathlib.Path(temp);root.chmod(0o755);policy=root/'policy';policy.write_text(text);policy.chmod(0o644)
  program=root/'extra.cjs';program.write_text(PROGRAM);program.chmod(0o644)
  home=root/'home';home.mkdir()
  for name_path in ['.ssh/config','.config/npm/npmrc']:
   p=home/name_path;p.parent.mkdir(parents=True,exist_ok=True);p.write_text('synthetic')
  for p in [home,*home.rglob('*')]:os.chown(p,1000,1000);p.chmod(0o700 if p.is_dir()else 0o600)
  library=pathlib.Path('/usr/lib/x86_64-linux-gnu/libapparmor.so.1').resolve(strict=True)
  args=['docker','run','--rm','--name',name,'--network','none','--user','1000:1000','--cpus','1','--memory','128m','--pids-limit','32','--security-opt','apparmor='+control,'--mount',f'type=bind,src={program},dst=/opt/qualification/extra.cjs,readonly','--mount','type=bind,src=/usr/bin/aa-exec,dst=/opt/qualification/aa-exec,readonly','--mount',f'type=bind,src={library},dst=/usr/lib/x86_64-linux-gnu/libapparmor.so.1,readonly','--mount',f'type=bind,src={home},dst=/paperclip','--entrypoint','/usr/bin/timeout',image,'--kill-after=2s','20s','node','/opt/qualification/extra.cjs',agent]
  try:
   subprocess.run(['/sbin/apparmor_parser','-a',str(policy)],check=True,capture_output=True);loaded=True
   q=subprocess.run(args,capture_output=True,text=True,timeout=25);assert q.returncode==0,q.stderr[-2000:]
   value=json.loads(q.stdout)
   assert value['agent']['uid']==value['control']['uid']==1000
   assert value['agent']['label'].startswith(agent+' ')and value['control']['label'].startswith(control+' ')
   assert all(all(case.values())for case in value['control']['cases'])
   assert all(not any(case.values())for case in value['agent']['cases'])
   print(json.dumps({'passed':True,'newPaths':['.ssh/','.config/npm/'],'measurements':value,'policySha256':hashlib.sha256(source).hexdigest(),'image':image,'applicationRuns':0,'providers':0,'previousCasesRepeated':0}),flush=True)
  finally:
   subprocess.run(['docker','rm','--force',name],capture_output=True,timeout=10)
   if loaded:subprocess.run(['/sbin/apparmor_parser','-R',str(policy)],check=True,capture_output=True,timeout=10)
if __name__=='__main__':main(*sys.argv[1:])
