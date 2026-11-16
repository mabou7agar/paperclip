// Root-owned code, unprivileged passive observer, not an agent or application entrypoint.
// Reuse the installed driver. Credentials stay inside the container process;
// stdout contains only closed readiness/invalidation frames, never row data.
import { createRequire } from 'node:module';
const pluginId=process.argv[2];
if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(pluginId??''))throw Error('native_event_plugin_invalid');
const topic='plugin-state:'+pluginId;
const emit=kind=>process.stdout.write(JSON.stringify({kind,pluginId})+'\n');
const postgres=createRequire('/app/packages/db/package.json')('postgres');
const databaseUrl=process.env.PAPERCLIP_DATABASE_LISTEN_URL||process.env.DATABASE_URL;
if(!databaseUrl)throw Error('native_event_database_binding_missing');
const client=postgres(databaseUrl,{max:1,connect_timeout:5,keep_alive:30,onnotice:()=>{},
 connection:{application_name:'paperclip-runner-state-events',default_transaction_read_only:'on'}});
let stopping=false;
const stop=async()=>{if(stopping)return;stopping=true;await client.end({timeout:1});};
process.stdin.resume();
process.stdin.once('end',()=>{void stop().finally(()=>process.exit(0));});
process.once('SIGTERM',()=>{void stop().finally(()=>process.exit(0));});
process.once('SIGINT',()=>{void stop().finally(()=>process.exit(0));});
try{
 await client.listen('paperclip_work_v1',payload=>{
  if(typeof payload!=='string'||Buffer.byteLength(payload)>1024)return;
  let message;try{message=JSON.parse(payload);}catch{return;}
  if(message?.version===1&&message.topic===topic)emit('changed');
 },()=>emit('listening'));
}catch{
 emit('unavailable');await stop();process.exitCode=1;
}
