import path from "node:path";

/** A token-era identity can migrate only before any manual credential replacement. */
export function managedAiSessionIdentityCompatible(stored: unknown, sessionIdentity: string, credentialIdentity: string): boolean {
  return stored === sessionIdentity || (sessionIdentity.endsWith(":0") && stored === credentialIdentity);
}

export function managedAiHomeEnvironment(home: string): Record<string, string> {
  const providerHome = path.join(home, "provider");
  return {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_DATA_HOME: path.join(home, "data"),
    CODEX_HOME: providerHome,
    GROK_HOME: providerHome,
    CLAUDE_CONFIG_DIR: providerHome,
    HERMES_HOME: providerHome,
  };
}

/** Canonicalize only server-owned launch data; preserve configured overrides. */
export function managedAiSessionFingerprintConfig(
  config: Record<string, unknown>,
  managedHome: string | undefined,
): Record<string, unknown> {
  if (!managedHome) return config;
  const env = { ...(config.env as Record<string, unknown> | undefined) };
  const stable = managedAiHomeEnvironment("<managed-ai-home>");
  for (const [key, value] of Object.entries(managedAiHomeEnvironment(managedHome))) {
    if (env[key] === value) env[key] = stable[key];
  }
  if (env.GEMINI_HOME === path.join(managedHome, "provider")) env.GEMINI_HOME = path.join("<managed-ai-home>", "provider");
  const managed = config.managedAiConnection as Record<string, unknown> | undefined;
  if (managed?.sessionIdentity) {
    for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY", "OPENROUTER_API_KEY", "XAI_API_KEY", "GROK_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "OPENCODE_AUTH_JSON", "OPENCODE_CONFIG_CONTENT"]) {
      if (env[key]) env[key] = "<managed-ai-credential>";
    }
  }
  return { ...config, env, ...(managed?.sessionIdentity ? { managedAiConnection: { ...managed, identity: managed.sessionIdentity } } : {}) };
}
