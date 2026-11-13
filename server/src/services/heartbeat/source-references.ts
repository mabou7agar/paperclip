import { heartbeatRuns, type Db } from "@paperclipai/db";
import { and, eq, sql } from "drizzle-orm";
import type { SourceMemoryInput } from "../source-memory.js";
import { prepareSourceMemoryReferences, attachSourceReferenceContext } from "../source-memory-reference.js";
import type { SourceReferenceUsage } from "../source-memory-reference-types.js";

/** A prepared-reference receipt is advisory metadata, never completion authority. */
export async function recordSourceReferenceUsage(db:Db,run:{companyId:string;runId:string},usage:SourceReferenceUsage) {
  const changed=await db.update(heartbeatRuns).set({contextSnapshot:sql`coalesce(${heartbeatRuns.contextSnapshot}, '{}'::jsonb) || ${JSON.stringify({sourceReferenceUsage:usage})}::jsonb`})
    .where(and(eq(heartbeatRuns.id,run.runId),eq(heartbeatRuns.companyId,run.companyId),eq(heartbeatRuns.status,"running"),sql`${heartbeatRuns.contextSnapshot}->'sourceReferenceUsage' IS NULL`))
    .returning({id:heartbeatRuns.id});
  return changed.length===1;
}

/** Shared by actual heartbeat wiring and the assembled native-input tests. */
export async function prepareHeartbeatSourceReferences(input:{
  identity:SourceMemoryInput; recovering:boolean; context:Record<string,unknown>;
  assertOwned:()=>Promise<void>; recordUsage:(usage:SourceReferenceUsage)=>Promise<unknown>; warn:()=>void;
  lookup?:typeof prepareSourceMemoryReferences;
}) {
  if(input.recovering)return;
  const lookup=await(input.lookup??prepareSourceMemoryReferences)(input.identity,input.assertOwned);
  const usage=attachSourceReferenceContext(input.context,lookup);
  if(!usage)return;
  try{await input.recordUsage(usage);}catch{input.warn();}
}
