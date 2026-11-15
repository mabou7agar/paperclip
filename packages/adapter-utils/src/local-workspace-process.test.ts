import { describe,it,expect,vi } from "vitest";
import { promisify } from "node:util";
import * as policy from "./local-agent-launch-policy.js";
import { execFile,spawn } from "./local-workspace-process.js";

describe("optional local workspace process boundary",()=>{
  it("keeps native execFile promise and buffer contracts when the policy is absent",async()=>{
    const reading=vi.spyOn(policy,"readLocalAgentLaunchPolicy").mockReturnValue(null);
    try {
      const pending=promisify(execFile)(process.execPath,["-e","process.stdout.write('out');process.stderr.write('err')"],{encoding:"buffer"});
      expect((pending as typeof pending&{child:unknown}).child).toBeTruthy();
      const result=await pending;expect(Buffer.isBuffer(result.stdout)).toBe(true);
      expect(result.stdout.toString()).toBe("out");expect(result.stderr.toString()).toBe("err");
    } finally {reading.mockRestore();}
  });
  it("confines workspace commands and drops host secrets even when callers spread process.env",async()=>{
    vi.stubEnv("BOUNDARY_FIXTURE_SECRET","synthetic-server-only");
    const reading=vi.spyOn(policy,"readLocalAgentLaunchPolicy").mockReturnValue({kind:"apparmor",profile:"paperclip-agent",executable:"/fixture/aa-exec"});
    // The actual kernel transition is covered separately on Linux. This fixture
    // executes Node to check the real environment, pipes and callback contract.
    const launch=vi.spyOn(policy,"localAgentLaunchTarget").mockImplementation((command,args)=>({command,args:[...args]}));
    try {
      const result=await promisify(execFile)(process.execPath,["-e","console.log(JSON.stringify({secret:!!process.env.BOUNDARY_FIXTURE_SECRET,grant:process.env.RUN_GRANT}))"],
        {env:{...process.env,RUN_GRANT:"explicit-fixture-grant"}});
      expect(JSON.parse(result.stdout)).toEqual({secret:false,grant:"explicit-fixture-grant"});
      expect(launch).toHaveBeenCalledTimes(1);
      expect(launch.mock.calls[0]?.[2]?.profile).toBe("paperclip-agent");
      expect(()=>spawn("git",[],{shell:true})).toThrow(/explicit shell/);
    } finally {reading.mockRestore();launch.mockRestore();vi.unstubAllEnvs();}
  });
  it("keeps callback overloads and caller-provided cancellation handles",async()=>{
    const reading=vi.spyOn(policy,"readLocalAgentLaunchPolicy").mockReturnValue(null);
    try {
      await new Promise<void>((resolve,reject)=>{
        const child=execFile(process.execPath,["-e","process.stdout.write('ok')"],(error,stdout)=>{
          if(error)return reject(error);expect(stdout).toBe("ok");resolve();
        });
        expect(child.pid).toBeTypeOf("number");
      });
    } finally {reading.mockRestore();}
  });
});
