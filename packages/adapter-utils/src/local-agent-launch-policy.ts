import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess, type SpawnOptionsWithoutStdio } from "node:child_process";

/** Operator-only physical launch policy. It never changes provider identity,
 * cwd, conversation parameters, task configuration or logical agent command. */
export interface LocalAgentLaunchPolicy {
  kind: "apparmor";
  executable: string;
  profile: string;
}
const runtimePolicies = new WeakMap<object, string>();
const policyKey = (value:LocalAgentLaunchPolicy | null) => value ? JSON.stringify([value.kind,value.executable,value.profile]) : "unconfined";
export function rememberLocalAgentPolicy(runtime: object, policy:LocalAgentLaunchPolicy | null): void {
  runtimePolicies.set(runtime,policyKey(policy));
}
export function runtimeUsesLocalAgentPolicy(runtime:object, policy:LocalAgentLaunchPolicy | null): boolean {
  const known = runtimePolicies.get(runtime);
  return known === undefined ? policy === null : known === policyKey(policy);
}

function sealedPath(file: string, executable = false): void {
  for (let current = file; ; current = path.dirname(current)) {
    const st = fs.lstatSync(current);
    if (st.isSymbolicLink() || st.uid !== 0 || (st.mode & 0o022) ||
        (current === file ? !st.isFile() || st.size > (executable ? 1024 * 1024 : 8192) : !st.isDirectory()) ||
        (current === file && executable && (!(st.mode & 0o111) || (st.mode & 0o6000)))) {
      throw new Error("Local agent launch policy is not sealed by the operator");
    }
    if (current === "/") break;
  }
  if (executable && !fs.readFileSync(file).subarray(0,4).equals(Buffer.from([0x7f,0x45,0x4c,0x46]))) {
    throw new Error("Local agent transition executable must be a sealed ELF binary");
  }
}

/** Read on launch, not per token/tool. Missing required policy fails closed. */
export function readLocalAgentLaunchPolicy(environment: NodeJS.ProcessEnv = process.env): LocalAgentLaunchPolicy | null {
  const file = environment.PAPERCLIP_LOCAL_AGENT_LAUNCH_POLICY;
  if (file === undefined) return null;
  if (process.platform !== "linux" || !path.isAbsolute(file) || path.normalize(file) !== file) {
    throw new Error("Local agent launch policy requires an absolute Linux operator path");
  }
  sealedPath(file);
  const policy: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!policy || typeof policy !== "object" || Array.isArray(policy) ||
      Object.keys(policy).sort().join() !== "executable,kind,profile") throw new Error("Invalid local agent launch policy");
  const value = policy as LocalAgentLaunchPolicy;
  if (value.kind !== "apparmor" || typeof value.executable !== "string" || !path.isAbsolute(value.executable) ||
      path.normalize(value.executable) !== value.executable || typeof value.profile !== "string" ||
      !/^[a-z][a-z0-9-]{1,79}$/.test(value.profile)) throw new Error("Invalid local agent launch policy");
  sealedPath(value.executable, true);
  return Object.freeze({ ...value });
}

export function localAgentLaunchTarget(command: string, args: readonly string[], policy: LocalAgentLaunchPolicy | null) {
  return policy ? { command: policy.executable, args: ["-p", policy.profile, "--", command, ...args] }
    : { command, args: [...args] };
}

/** Confined CLI launches must not inherit the control-plane database or vault
 * credentials. Provider/runtime credentials still enter through the adapter's
 * explicit launch environment, as they already do for ACP. */
export function localAgentInheritedEnvironment(environment:NodeJS.ProcessEnv, policy:LocalAgentLaunchPolicy | null):NodeJS.ProcessEnv {
  if (!policy) return {...environment};
  const safe = /^(PATH|HOME|USER|LOGNAME|SHELL|TMP|TEMP|TMPDIR|LANG|LANGUAGE|LC_[A-Z_]+|TERM|COLORTERM|CI|FORCE_COLOR|XDG_CONFIG_HOME|XDG_DATA_HOME|XDG_CACHE_HOME|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|http_proxy|https_proxy|all_proxy|no_proxy)$/;
  return Object.fromEntries(Object.entries(environment).filter(([key])=>safe.test(key)));
}

export function assertLocalAgentLaunchEnvironment(environment: NodeJS.ProcessEnv | undefined, policy:LocalAgentLaunchPolicy | null): void {
  if (policy && Object.keys(environment ?? {}).some(key => environment?.[key] !== undefined &&
      (/^LD_/.test(key) || ["GLIBC_TUNABLES","GCONV_PATH","LOCPATH","NLSPATH"].includes(key)))) {
    // The ELF transition helper itself still starts in the control domain.
    // Never let an agent-selected loader execute code before the transition.
    throw new Error("Required local agent confinement forbids loader-injection environment settings");
  }
}

/** ACPX's native spawn hook preserves pipes, PID and all control callbacks. */
export function localAgentSpawner(policy: LocalAgentLaunchPolicy | null) {
  if (!policy) return undefined;
  return (input: { command: string; args: readonly string[]; options: SpawnOptionsWithoutStdio }): ChildProcess => {
    assertLocalAgentLaunchEnvironment(input.options.env,policy);
    const target = localAgentLaunchTarget(input.command, input.args, policy);
    return spawn(target.command, target.args, { ...input.options, shell: false, stdio: ["pipe", "pipe", "pipe"] });
  };
}

/** A provider must use its confined child tools. Letting it ask the parent to
 * read files or spawn a terminal would turn the parent into a bypass. ACP's
 * existing protocol guard runs before dispatch, and fails the connection. */
export function localAgentProtocolGuard(policy: LocalAgentLaunchPolicy | null) {
  if (!policy) return undefined;
  return () => (direction: "inbound" | "outbound", message: unknown): void => {
    if (direction === "inbound" && Array.isArray(message)) throw new Error("Confined ACP does not accept batch requests");
    const method = message && typeof message === "object" && "method" in message ? message.method : null;
    if (direction === "outbound" && method === "initialize" && message && typeof message === "object" &&
        "params" in message && message.params && typeof message.params === "object") {
      const params = message.params as Record<string,unknown>;
      const previous = params.clientCapabilities && typeof params.clientCapabilities === "object" ? params.clientCapabilities : {};
      // Advertise the actual contract, preserving unrelated typed-failure and
      // provider capabilities. Honest peers select their own confined tools.
      params.clientCapabilities = {...previous,fs:{readTextFile:false,writeTextFile:false},terminal:false};
    }
    if (direction === "inbound" && typeof method === "string" &&
        !["session/update","session/request_permission"].includes(method)) {
      throw new Error("Confined local ACP providers must use their own filesystem and terminal tools");
    }
  };
}
