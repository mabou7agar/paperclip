import { lstat, readFile } from "node:fs/promises";
import { createPublicKey } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import type { RunnerTrust } from "./runner-policy-contract.js";
const trustFile = "/opt/paperclip-runner-trust/broker.json";
/** Same sealed public binding as the installed native result plugin. No credential fallback. */
export async function loadRunnerPolicyTrust(): Promise<RunnerTrust> {
  for (let current = trustFile; ; current = path.dirname(current)) {
    const st = await lstat(current);
    if (st.isSymbolicLink() || st.uid !== 0 || (st.mode & 0o022) ||
      (current === trustFile ? !st.isFile() || st.size > 8192 : !st.isDirectory())) throw new Error("runner_native_trust_unsealed");
    if (current === "/") break;
  }
  const value = z.object({ pluginId: z.string().uuid(), publicKey: z.string(), brokerUserId: z.string().optional() }).strict()
    .parse(JSON.parse(await readFile(trustFile, "utf8")));
  const publicKey = createPublicKey(value.publicKey);
  if (publicKey.asymmetricKeyType !== "ed25519") throw new Error("runner_native_trust_invalid");
  return { pluginId: value.pluginId, publicKey };
}
