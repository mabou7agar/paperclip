/** Names only: forward run-scoped Paperclip capabilities, never ambient host secrets. */
export function codexShellEnvironmentKeys(env: Readonly<Record<string, string>>): string[] {
  const capabilities = new Set([
    "PAPERCLIP_API_KEY", "PAPERCLIP_GITHUB_BROKER_TOKEN", "PAPERCLIP_GITHUB_BRIDGE_TOKEN",
    "PAPERCLIP_AGENT_KEY_ID", "PAPERCLIP_AGENT_PUBLIC_KEY", "PAPERCLIP_AGENT_PRIVATE_KEY",
  ]);
  return [...new Set([
    "PATH", "HOME", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR", "TEMP", "TMP", "CODEX_HOME",
    ...Object.keys(env).filter(key => capabilities.has(key) || !/key|secret|token/i.test(key)),
    ...capabilities,
  ])];
}
