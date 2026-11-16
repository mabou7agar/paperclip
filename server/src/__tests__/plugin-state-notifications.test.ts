import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createDb, plugins } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { pluginStateStore } from "../services/plugin-state-store.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

vi.mock("../services/heartbeat.js",()=>({heartbeatService:()=>({wakeup:vi.fn()})}));
let database:Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>,db:ReturnType<typeof createDb>;
let directory:string,child:ChildProcessWithoutNullStreams|undefined,pluginId:string;
const frames:Array<{kind:string;pluginId:string}>=[];
async function until(check:()=>boolean|Promise<boolean>){
 const end=Date.now()+8000;while(!await check()){if(Date.now()>end)throw Error("native notification fixture did not settle");await delay(10);}
}
beforeAll(async()=>{
 database=await startEmbeddedPostgresTestDatabase("plugin-state-events-");db=createDb(database.connectionString);
 pluginId=randomUUID();await db.insert(plugins).values({id:pluginId,pluginKey:"test.native-state",packageName:"test",version:"1",status:"ready",manifestJson:{id:"test.native-state",apiVersion:1,version:"1",displayName:"Fixture",description:"Fixture",author:"Test",categories:[],capabilities:["plugin.state.write","plugin.state.notify"],entrypoints:{worker:"worker.mjs"}}});
 directory=await fs.mkdtemp(path.join(os.tmpdir(),"native-state-listener-"));
 const source=await fs.readFile(fileURLToPath(new URL("../../../integrations/ubuntu-runner/result-bridge/broker/native_events.mjs",import.meta.url)),"utf8");
 // Only the immutable dependency location changes on the Mac. The actual
 // observer protocol, read-only connection and reconnect callbacks are used.
 const requirePath=fileURLToPath(new URL("../../../packages/db/package.json",import.meta.url));
 await fs.writeFile(path.join(directory,"observer.mjs"),source.replace("'/app/packages/db/package.json'",JSON.stringify(requirePath)),{mode:0o600});
 child=spawn(process.execPath,[path.join(directory,"observer.mjs"),pluginId],{stdio:"pipe",env:{PATH:process.env.PATH,DATABASE_URL:database.connectionString}});
 let buffered="";child.stdout.on("data",chunk=>{buffered+=String(chunk);for(let i;(i=buffered.indexOf("\n"))>=0;){const line=buffered.slice(0,i);buffered=buffered.slice(i+1);frames.push(JSON.parse(line));}});
 await until(()=>frames.some(x=>x.kind==="listening"));
},90000);
afterAll(async()=>{
 if(child?.exitCode===null){const exit=once(child,"exit");child.stdin.end();await Promise.race([exit,delay(3000).then(()=>{if(child?.exitCode===null)child.kill("SIGKILL");})]);}
 await db?.$client.end({timeout:1});await database?.cleanup();if(directory)await fs.rm(directory,{recursive:true,force:true});
});
it("real plugin host state RPC backing notifies after commit without enabling global deployment notifications",async()=>{
 const {buildHostServices}=await import("../services/plugin-host-services.js");
 const {createPluginEventBus}=await import("../services/plugin-event-bus.js");
 const [registered]=await db.select().from(plugins);
 const host=buildHostServices(db,pluginId,"test.native-state",createPluginEventBus(),undefined,{manifest:registered!.manifestJson});
 const before=frames.filter(x=>x.kind==="changed").length;
 try{
  await host.state.set({scopeKind:"instance",namespace:"fixture",stateKey:"host",value:{phase:"committed"}});
  await until(()=>frames.filter(x=>x.kind==="changed").length===before+1);
  expect(await pluginStateStore(db,{notifyCommittedChanges:true}).get(pluginId,"instance","host",{namespace:"fixture"})).toEqual({phase:"committed"});
  await host.state.delete({scopeKind:"instance",namespace:"fixture",stateKey:"host"});
  await until(()=>frames.filter(x=>x.kind==="changed").length===before+2);
 }finally{host.dispose();}
},45000);
it("delayed outer commit and lost caller acknowledgement cannot lose a native intent; rollback emits none",async()=>{
 const before=frames.filter(x=>x.kind==="changed").length;
 await db.transaction(async outer=>{
  await outer.transaction(async nested=>{await pluginStateStore(nested as typeof db,{notifyCommittedChanges:true}).set(pluginId,{scopeKind:"instance",namespace:"fixture",stateKey:"delayed",value:"retained"});});
  expect(frames.filter(x=>x.kind==="changed")).toHaveLength(before);
 });
 await until(()=>frames.filter(x=>x.kind==="changed").length===before+1);
 await expect((async()=>{await pluginStateStore(db,{notifyCommittedChanges:true}).set(pluginId,{scopeKind:"instance",namespace:"fixture",stateKey:"lost-ack",value:"durable"});throw Error("response lost after commit");})()).rejects.toThrow("response lost");
 await until(()=>frames.filter(x=>x.kind==="changed").length===before+2);
 expect(await pluginStateStore(db,{notifyCommittedChanges:true}).get(pluginId,"instance","lost-ack",{namespace:"fixture"})).toBe("durable");
 await expect(db.transaction(async outer=>{await pluginStateStore(outer as typeof db,{notifyCommittedChanges:true}).set(pluginId,{scopeKind:"instance",namespace:"fixture",stateKey:"rolled-back",value:true});throw Error("rollback");})).rejects.toThrow("rollback");
 expect(await pluginStateStore(db,{notifyCommittedChanges:true}).get(pluginId,"instance","rolled-back",{namespace:"fixture"})).toBeNull();
 // A following committed barrier proves preceding NOTIFY deliveries drained.
 await pluginStateStore(db,{notifyCommittedChanges:true}).set(pluginId,{scopeKind:"instance",namespace:"fixture",stateKey:"barrier",value:true});
 await until(()=>frames.filter(x=>x.kind==="changed").length===before+3);
});
it("a rolled-back nested savepoint cannot notify or retain a phantom request",async()=>{
 const before=frames.filter(x=>x.kind==="changed").length;
 await db.transaction(async outer=>{
  await expect(outer.transaction(async nested=>{
   await pluginStateStore(nested as typeof db,{notifyCommittedChanges:true}).set(pluginId,{scopeKind:"instance",namespace:"fixture",stateKey:"savepoint-aborted",value:"phantom"});
   throw Error("savepoint rollback");
  })).rejects.toThrow("savepoint rollback");
 });
 expect(await pluginStateStore(db,{notifyCommittedChanges:true}).get(pluginId,"instance","savepoint-aborted",{namespace:"fixture"})).toBeNull();
 await pluginStateStore(db,{notifyCommittedChanges:true}).set(pluginId,{scopeKind:"instance",namespace:"fixture",stateKey:"savepoint-barrier",value:true});
 await until(()=>frames.filter(x=>x.kind==="changed").length===before+1);
});
it("native lifecycle readiness commits wake retained-state discovery without a state rewrite",async()=>{
 const {pluginRegistryService}=await import("../services/plugin-registry.js");
 const registry=pluginRegistryService(db);
 const before=frames.filter(x=>x.kind==="changed").length;
 await registry.updateStatus(pluginId,{status:"disabled"});
 await until(()=>frames.filter(x=>x.kind==="changed").length===before+1);
 await registry.updateStatus(pluginId,{status:"ready"});
 await until(()=>frames.filter(x=>x.kind==="changed").length===before+2);
 expect((await registry.getById(pluginId))?.status).toBe("ready");
});
it("ordinary plugins keep state and status writes without commit notifications",async()=>{
 const before=frames.filter(x=>x.kind==="changed").length;
 const [registered]=await db.select().from(plugins);
 const ordinaryManifest={...registered!.manifestJson,capabilities:registered!.manifestJson.capabilities.filter(x=>x!=="plugin.state.notify")};
 await db.update(plugins).set({manifestJson:ordinaryManifest}).where(eq(plugins.id,pluginId));
 const {buildHostServices}=await import("../services/plugin-host-services.js");
 const {createPluginEventBus}=await import("../services/plugin-event-bus.js");
 const {pluginRegistryService}=await import("../services/plugin-registry.js");
 const host=buildHostServices(db,pluginId,"test.native-state",createPluginEventBus(),undefined,{manifest:ordinaryManifest});
 try{
  await host.state.set({scopeKind:"instance",namespace:"fixture",stateKey:"ordinary",value:"unchanged"});
  expect(await host.state.get({scopeKind:"instance",namespace:"fixture",stateKey:"ordinary"})).toBe("unchanged");
  await host.state.delete({scopeKind:"instance",namespace:"fixture",stateKey:"ordinary"});
  await pluginRegistryService(db).updateStatus(pluginId,{status:"disabled"});
  await pluginRegistryService(db).updateStatus(pluginId,{status:"ready"});
 }finally{
  host.dispose();await db.update(plugins).set({manifestJson:registered!.manifestJson}).where(eq(plugins.id,pluginId));
 }
 await pluginStateStore(db,{notifyCommittedChanges:true}).set(pluginId,{scopeKind:"instance",namespace:"fixture",stateKey:"ordinary-barrier",value:true});
 await until(()=>frames.filter(x=>x.kind==="changed").length===before+1);
},45000);

it("observer reconnect reconstructs durable state and remains idle until a commit",async()=>{
 const ready=frames.filter(x=>x.kind==="listening").length;
 const rows=await db.execute<{pid:number;state:string;wait:string}>(sql`select pid,state,wait_event as wait from pg_stat_activity where application_name='paperclip-runner-state-events'`);
 expect(rows).toHaveLength(1);expect(rows[0]!.state).toBe("idle");expect(rows[0]!.wait).toBe("ClientRead");
 await db.execute(sql`select pg_terminate_backend(${rows[0]!.pid})`);
 await pluginStateStore(db,{notifyCommittedChanges:true}).set(pluginId,{scopeKind:"instance",namespace:"fixture",stateKey:"during-reconnect",value:"same-context"});
 await until(()=>frames.filter(x=>x.kind==="listening").length>ready);
 expect(await pluginStateStore(db,{notifyCommittedChanges:true}).get(pluginId,"instance","during-reconnect",{namespace:"fixture"})).toBe("same-context");
 const count=frames.length;await delay(80);expect(frames).toHaveLength(count);
 expect(child?.exitCode).toBeNull();
});
it("closing the owning input stops the observer instead of leaking a listener",async()=>{
 const exit=once(child!,"exit");child!.stdin.end();const [code]=await exit;expect(code).toBe(0);
 await until(async()=>{const [row]=await db.execute<{count:number}>(sql`select count(*)::int as count from pg_stat_activity where application_name='paperclip-runner-state-events'`);return row!.count===0;});
});
