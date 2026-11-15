import { describe, expect, it } from "vitest";
import { localAgentLaunchTarget, localAgentProtocolGuard, readLocalAgentLaunchPolicy,
  runtimeUsesLocalAgentPolicy, rememberLocalAgentPolicy, assertLocalAgentLaunchEnvironment, localAgentInheritedEnvironment } from "./local-agent-launch-policy.js";

describe("operator local agent launch policy", () => {
  it("keeps absent deployments unchanged and never interprets command arguments as shell", () => {
    const args = ["a b", "$(not-executed)", "quote'\"", "--stdio"];
    expect(localAgentLaunchTarget("/tool", args, null)).toEqual({ command:"/tool", args });
    expect(localAgentLaunchTarget("/tool", args, {kind:"apparmor",executable:"/opt/aa-exec",profile:"paperclip-agent"}))
      .toEqual({ command:"/opt/aa-exec", args:["-p","paperclip-agent","--","/tool",...args] });
    expect(readLocalAgentLaunchPolicy({})).toBeNull();
    expect(() => readLocalAgentLaunchPolicy({PAPERCLIP_LOCAL_AGENT_LAUNCH_POLICY:"relative"})).toThrow();
  });
  it("rejects parent filesystem/terminal delegation before dispatch, preserving ordinary ACP", () => {
    expect(localAgentProtocolGuard(null)).toBeUndefined();
    const guard = localAgentProtocolGuard({kind:"apparmor",executable:"/opt/aa-exec",profile:"paperclip-agent"})!();
    for (const method of ["fs/read_text_file","fs/write_text_file","terminal/create","terminal/output"]) {
      expect(()=>guard("inbound",{id:1,method,params:{path:"/proc/server/environ"}})).toThrow(/confined child|Confined local/);
    }
    expect(()=>guard("inbound",{id:1,method:"client/private_data"})).toThrow();
    expect(()=>guard("inbound",[{id:1,method:"fs/read_text_file"}])).toThrow();
    expect(()=>guard("inbound",{id:1,method:"session/request_permission",params:{}})).not.toThrow();
    expect(()=>guard("inbound",{method:"session/update",params:{}})).not.toThrow();
    expect(()=>guard("inbound",{id:1,result:{}})).not.toThrow();
    expect(()=>guard("outbound",{method:"fs/read_text_file"})).not.toThrow();
    const initialize = {method:"initialize",params:{clientCapabilities:{_meta:{retained:true},fs:{readTextFile:true},terminal:true}}};
    guard("outbound",initialize);
    expect(initialize.params.clientCapabilities).toEqual({_meta:{retained:true},fs:{readTextFile:false,writeTextFile:false},terminal:false});
  });
  it("drops an unconfined or differently confined warm process without changing its conversation identity", () => {
    const runtime = {}, policy = {kind:"apparmor" as const,executable:"/opt/aa-exec",profile:"paperclip-agent"};
    expect(runtimeUsesLocalAgentPolicy(runtime,null)).toBe(true);
    expect(runtimeUsesLocalAgentPolicy(runtime,policy)).toBe(false);
    rememberLocalAgentPolicy(runtime,policy);
    expect(runtimeUsesLocalAgentPolicy(runtime,policy)).toBe(true);
    expect(runtimeUsesLocalAgentPolicy(runtime,{...policy,profile:"other-agent"})).toBe(false);
    expect(runtimeUsesLocalAgentPolicy(runtime,null)).toBe(false);
  });
  it("rejects loader injection before the transition helper can execute", () => {
    const policy={kind:"apparmor" as const,executable:"/opt/aa-exec",profile:"paperclip-agent"};
    for(const key of ["LD_PRELOAD","LD_AUDIT","LD_LIBRARY_PATH","GCONV_PATH","LOCPATH"]) {
      expect(()=>assertLocalAgentLaunchEnvironment({[key]:"fixture"},policy)).toThrow(/loader-injection/);
    }
    expect(()=>assertLocalAgentLaunchEnvironment({PATH:"/usr/bin",ANTHROPIC_API_KEY:"fixture"},policy)).not.toThrow();
    expect(()=>assertLocalAgentLaunchEnvironment({LD_PRELOAD:"legacy"},null)).not.toThrow();
  });
  it("does not pass host control-plane credentials into confined CLI children",()=>{
    const host={PATH:"/usr/bin",HOME:"/work",LC_ALL:"C",HTTPS_PROXY:"https://proxy.example",DATABASE_URL:"host-db",
      BETTER_AUTH_SECRET:"host-auth",UNRELATED_TOKEN:"host-token",NODE_OPTIONS:"--import=/host-code.js"};
    const policy={kind:"apparmor" as const,executable:"/opt/aa-exec",profile:"paperclip-agent"};
    const inherited=localAgentInheritedEnvironment(host,policy);
    expect(inherited).toEqual({PATH:host.PATH,HOME:host.HOME,LC_ALL:host.LC_ALL,HTTPS_PROXY:host.HTTPS_PROXY});
    expect({...inherited,...{ANTHROPIC_API_KEY:"explicit-adapter-grant"}}.ANTHROPIC_API_KEY).toBe("explicit-adapter-grant");
    expect(localAgentInheritedEnvironment(host,null)).toEqual(host);
  });
});
