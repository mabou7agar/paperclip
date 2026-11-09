import { createHash } from "node:crypto";
import path from "node:path";
import { linkManagedSessionDirectory } from "./managed-session-directory.js";

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
  await linkManagedSessionDirectory(projects, path.join(configDir, "projects"));
}
