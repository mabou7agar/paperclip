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
    }, {}, false);
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
      const keys = new Set(codexShellEnvironmentKeys(env, {}, false));
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

it("admits assigned service secrets by name while retaining unassigned secret exclusions", () => {
  const assigned = { SLACK_BOT_TOKEN: "slack-canary", SERVICE_API_KEY: "key-canary", APP_SECRET: "secret-canary" };
  const names = codexShellEnvironmentKeys({ ...assigned, HOST_API_TOKEN: "host-canary" }, assigned, false);
  expect(names).toEqual(expect.arrayContaining(Object.keys(assigned)));
  expect(names).not.toContain("HOST_API_TOKEN");
  for (const value of Object.values(assigned)) expect(JSON.stringify(names)).not.toContain(value);
});

it("keeps Codex authentication, observability and runtime transports out of the service-secret opt-in", () => {
  const configured = {
    SLACK_BOT_TOKEN: "assigned", OPENAI_API_KEY: "openai", CODEX_API_KEY: "codex",
    PAPERCLIP_AI_PROVIDER_KEY: "managed", OTEL_EXPORTER_OTLP_HEADERS: "authorization=export",
    PAPERCLIP_NATIVE_MCP_TOKEN: "mcp",
  };
  const names = codexShellEnvironmentKeys(configured, configured, true);
  expect(names).toContain("SLACK_BOT_TOKEN");
  for (const key of Object.keys(configured).filter(key => key !== "SLACK_BOT_TOKEN")) expect(names).not.toContain(key);
});

it("does not turn a configured glob into permission to inherit other secrets", () => {
  const configured = { "*TOKEN*": "wildcard", "SERVICE[AB]_KEY": "pattern" };
  const names = codexShellEnvironmentKeys({ ...configured, HOST_TOKEN: "host" }, configured, true);
  expect(names).not.toContain("*TOKEN*");
  expect(names).not.toContain("SERVICE[AB]_KEY");
  expect(names).not.toContain("HOST_TOKEN");
});

it("removes the secret opt-in when a binding is removed or has not been resolved", () => {
  const environment = { SLACK_BOT_TOKEN: "old-provider-environment" };
  expect(codexShellEnvironmentKeys(environment, {}, false)).not.toContain("SLACK_BOT_TOKEN");
  expect(codexShellEnvironmentKeys(environment, { SLACK_BOT_TOKEN: { type: "secret_ref" } }, false)).not.toContain("SLACK_BOT_TOKEN");
  expect(codexShellEnvironmentKeys(environment, {}, true)).not.toContain("SLACK_BOT_TOKEN");
});

it("passes the run's GitHub broker capability so the gh and git launchers can fetch its credential", () => {
  const environment = { PAPERCLIP_GITHUB_BROKER_URL: "https://paperclip.example", PAPERCLIP_GITHUB_BROKER_TOKEN: "capability", PAPERCLIP_GITHUB_BRIDGE_TOKEN: "" };
  const names = codexShellEnvironmentKeys(environment, environment, true);
  expect(names).toEqual(expect.arrayContaining(["PAPERCLIP_GITHUB_BROKER_URL", "PAPERCLIP_GITHUB_BROKER_TOKEN"]));
  expect(names).not.toContain("PAPERCLIP_GITHUB_BRIDGE_TOKEN");
  expect(JSON.stringify(names)).not.toContain("capability");
});
