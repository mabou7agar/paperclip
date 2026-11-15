import { execFile as nativeExecFile, spawn as nativeSpawn } from "node:child_process";
import { promisify } from "node:util";
import { assertLocalAgentLaunchEnvironment, localAgentInheritedEnvironment, localAgentLaunchTarget,
  readLocalAgentLaunchPolicy } from "./local-agent-launch-policy.js";

/** Workspace commands can execute repository hooks, filters and helpers.
 * Apply the same optional physical boundary as provider children. */
function target(command:string,args:readonly string[],options:Record<string,unknown>) {
  const policy=readLocalAgentLaunchPolicy();
  if (!policy) return {command,args:[...args],options};
  if (options.shell) throw new Error("Confined workspace commands require an explicit shell executable");
  const inherited=localAgentInheritedEnvironment(process.env,policy);
  const supplied=(options.env??process.env) as NodeJS.ProcessEnv;
  const env={...inherited};
  for(const [key,value] of Object.entries(supplied)) {
    // Many existing callers spread process.env into an explicit options object.
    // Keep run-specific grants, but never carry the unchanged server secrets.
    if(value===process.env[key] && !Object.hasOwn(inherited,key))continue;
    env[key]=value;
  }
  assertLocalAgentLaunchEnvironment(env,policy);
  return {...localAgentLaunchTarget(command,args,policy),options:{...options,env,shell:false}};
}

export const spawn:typeof nativeSpawn = ((command:string,argsOrOptions?:unknown,options?:unknown)=>{
  const args=Array.isArray(argsOrOptions)?argsOrOptions:[];
  const value=target(command,args,(Array.isArray(argsOrOptions)?options:argsOrOptions??options) as Record<string,unknown>??{});
  return nativeSpawn(value.command,value.args,value.options);
}) as typeof nativeSpawn;

export const execFile:typeof nativeExecFile = ((command:string,argsOrOptions?:unknown,optionsOrCallback?:unknown,callback?:unknown)=>{
  const args=Array.isArray(argsOrOptions)?argsOrOptions:[];
  const rawOptions=Array.isArray(argsOrOptions)?optionsOrCallback:argsOrOptions??optionsOrCallback;
  const options=rawOptions && typeof rawOptions==='object'?rawOptions as Record<string,unknown>:{};
  const done=typeof callback==='function'?callback:typeof optionsOrCallback==='function'?optionsOrCallback:
    typeof argsOrOptions==='function'?argsOrOptions:undefined;
  const value=target(command,args,options);
  return nativeExecFile(value.command,value.args,value.options,done as Parameters<typeof nativeExecFile>[3]);
}) as typeof nativeExecFile;

// Preserve Node's promisified {stdout,stderr} contract and cancellable child.
Object.defineProperty(execFile,promisify.custom,{value:(...args:unknown[])=>{
  let child:ReturnType<typeof nativeExecFile>;
  const promise=new Promise((resolve,reject)=>{
    child=(execFile as (...input:unknown[])=>ReturnType<typeof nativeExecFile>)(...args,
      (error:Error|null,stdout:unknown,stderr:unknown)=>error?reject(Object.assign(error,{stdout,stderr})):resolve({stdout,stderr}));
  });
  return Object.assign(promise,{child:child!});
}});
