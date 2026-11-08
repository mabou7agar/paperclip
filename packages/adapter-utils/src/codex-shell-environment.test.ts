import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { githubLauncherSource } from "./github-launcher.js";
import { describe, expect, it } from "vitest";
import { codexShellEnvironmentKeys } from "./codex-shell-environment.js";

describe("Codex command environment", () => {
  it("preserves scoped GitHub capabilities while excluding provider and unrelated service secrets", () => {
    const keys = codexShellEnvironmentKeys({
      PAPERCLIP_GITHUB_BROKER_TOKEN: "broker-secret",
      PAPERCLIP_GITHUB_BRIDGE_TOKEN: "bridge-secret",
      PAPERCLIP_API_KEY: "run-secret", PAPERCLIP_RUN_ID: "run-1",
      ANTHROPIC_API_KEY: "provider-secret", OPENAI_API_KEY: "provider-secret",
      GH_TOKEN: "host-secret", GITHUB_TOKEN: "host-secret", SERVICE_SECRET: "private",
    });
    expect(keys).toEqual(expect.arrayContaining([
      "PAPERCLIP_GITHUB_BROKER_TOKEN", "PAPERCLIP_GITHUB_BRIDGE_TOKEN", "PAPERCLIP_API_KEY", "PAPERCLIP_RUN_ID",
    ]));
    for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GH_TOKEN", "GITHUB_TOKEN", "SERVICE_SECRET"])
      expect(keys).not.toContain(key);
    expect(JSON.stringify(keys)).not.toContain("broker-secret");
  });
  it("runs a shell Git operation through the scoped broker without inheriting a host GitHub token", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-shell-broker-"));
    const requests: string[] = [];
    const server = createServer((req, res) => {
      requests.push(String(req.headers["x-paperclip-github-capability"]));
      if (req.url !== "/runtime-tools/github/credentials" ||
          req.headers.authorization !== "Bearer run-capability" ||
          req.headers["x-paperclip-github-capability"] !== "broker-capability") {
        res.writeHead(403).end(); return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ status: "available", env: { GH_TOKEN: "operation-credential" } }));
    });
    try {
      await mkdir(path.join(root, "managed")); await mkdir(path.join(root, "real"));
      await writeFile(path.join(root, "managed/git"), githubLauncherSource(), { mode: 0o700 });
      await writeFile(path.join(root, "real/git"), `#!${process.execPath}\nprocess.exit(process.env.GH_TOKEN === 'operation-credential' ? 0 : 97);\n`, { mode: 0o700 });
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const address = server.address() as { port: number };
      const env = {
        PATH: `${root}/managed:${root}/real:${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: root,
        PAPERCLIP_GITHUB_BROKER_URL: `http://127.0.0.1:${address.port}`,
        PAPERCLIP_GITHUB_BROKER_TOKEN: "broker-capability", PAPERCLIP_API_KEY: "run-capability",
        GH_TOKEN: "host-credential", OPENAI_API_KEY: "provider-credential",
      };
      const keys = new Set(codexShellEnvironmentKeys(env));
      const filtered = Object.fromEntries(Object.entries(env).filter(([key]) => keys.has(key)));
      const result = await promisify(execFile)("/bin/sh", ["-c", "git status"], { env: filtered });
      expect(requests).toEqual(["broker-capability"]);
      expect(result.stderr).not.toContain("capability_missing");
      expect(result.stdout + result.stderr).not.toContain("credential");
      expect(filtered).not.toHaveProperty("GH_TOKEN");
      expect(filtered).not.toHaveProperty("OPENAI_API_KEY");
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });

});
