import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { prepareManagedClaudeSessionStorage } from "./managed-claude-session-storage.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

it("leaves explicit provider directories untouched", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "claude-storage-")); roots.push(root);
  await prepareManagedClaudeSessionStorage({ stateDir: path.join(root, "state"), sessionIdentity: "grant:user:1",
    env: { HOME: path.join(root, "home"), CLAUDE_CONFIG_DIR: path.join(root, "explicit") } });
  expect(await fs.readdir(root)).toEqual([]);
});

it("never replaces an existing transcript directory or a link into another account", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "claude-storage-")); roots.push(root);
  const home = path.join(root, "home"), config = path.join(home, "provider");
  const input = { stateDir: path.join(root, "state"), sessionIdentity: "grant:user:1", env: { HOME: home, CLAUDE_CONFIG_DIR: config } };
  await fs.mkdir(path.join(config, "projects"), { recursive: true });
  await fs.writeFile(path.join(config, "projects", "retained.jsonl"), "preserve");
  await expect(prepareManagedClaudeSessionStorage(input)).rejects.toThrow("conflicts");
  expect(await fs.readFile(path.join(config, "projects", "retained.jsonl"), "utf8")).toBe("preserve");
  await fs.rename(path.join(config, "projects"), path.join(config, "original-projects"));
  await prepareManagedClaudeSessionStorage(input);
  await prepareManagedClaudeSessionStorage(input);
  await expect(prepareManagedClaudeSessionStorage({ ...input, sessionIdentity: "other-grant:user:1" })).rejects.toThrow("conflicts");
});
