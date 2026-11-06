import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export interface ManagedClaudeSessionStorageInput {
  stateDir: string;
  sessionIdentity: string;
  env: Readonly<Record<string, string>>;
}

/** Retain native transcripts only; credentials remain in the disposable home/env. */
export async function prepareManagedClaudeSessionStorage(input: ManagedClaudeSessionStorageInput): Promise<void> {
  const home = input.env.HOME;
  const configDir = input.env.CLAUDE_CONFIG_DIR;
  // Explicit/operator config directories keep their existing storage contract.
  if (!home || configDir !== path.join(home, "provider")) return;
  const namespace = createHash("sha256").update(input.sessionIdentity).digest("hex");
  const projects = path.join(input.stateDir, "claude-session-projects", namespace, "projects");
  await fs.mkdir(projects, { recursive: true, mode: 0o700 });
  await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
  const link = path.join(configDir, "projects");
  try {
    await fs.symlink(projects, link, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const stat = await fs.lstat(link);
    if (!stat.isSymbolicLink() || path.resolve(configDir, await fs.readlink(link)) !== projects) {
      throw new Error("Managed Claude transcript storage conflicts with an existing projects path");
    }
  }
}
