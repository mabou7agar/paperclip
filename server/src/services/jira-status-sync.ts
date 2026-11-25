import { and, asc, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";
import {
  issueRelations,
  issueWorkProducts,
  issues,
  toolCatalogEntries,
  toolConnections,
  type Db,
} from "@paperclipai/db";
import { logActivity } from "./activity-log.js";
import { workProductService } from "./work-products.js";
import { logger } from "../middleware/logger.js";
import type { createToolGatewayService } from "./tool-gateway.js";

/**
 * Keeps Jira issues linked to a Paperclip task in step with the task status.
 *
 * Links are `issue_work_products` rows `{type: "external_issue", provider:
 * "jira", externalId: "KEY-123"}`; all sync state lives in their metadata.
 * Links are made automatically when a task's title names a key of a project
 * the company's Jira connection can see (or a browse URL of that site). Only
 * the title counts: descriptions often mention a story as a reference ("QA for
 * AT-28"), and syncing from such a task would move the story with it. Each project's own workflow is learned from the transitions Jira
 * offers for the issue, so no transition id is hard-coded.
 *
 * Jira is never called inside a database transaction, and a Jira failure never
 * affects the Paperclip status change: the change commits first, then this
 * worker catches up (fast path on commit, periodic sweep as the safety net).
 */

export const JIRA_SYNC_INTEGRATION = "jira_status_sync" as const;
export const JIRA_LINK_TYPE = "external_issue";
export const JIRA_LINK_PROVIDER = "jira";
const MARKER_TOOL = "getTransitionsForJiraIssue";
const CONTEXT_TTL_MS = 60 * 60_000;
const CONTEXT_FAILURE_TTL_MS = 5 * 60_000;
export const JIRA_SWEEP_INTERVAL_MS = 45_000;
const SWEEP_LINK_LIMIT = 25;
const SWEEP_ISSUE_SCAN_LIMIT = 200;
const SWEEP_INITIAL_LOOKBACK_MS = 15 * 60_000;
const BACKOFF_STEPS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000, 6 * 60 * 60_000];

export type PaperclipStatus = "backlog" | "todo" | "in_progress" | "in_review" | "done" | "blocked" | "cancelled";
export type JiraStatusCategory = "new" | "indeterminate" | "done";

export interface JiraTransition {
  id: string;
  name: string;
  toName: string;
  toCategory: JiraStatusCategory | null;
}

export interface JiraLinkMetadata {
  connectionId?: string | null;
  cloudId?: string | null;
  projectKey?: string | null;
  lastSyncedStatus?: string | null;
  lastSyncedStatusVersion?: number | null;
  lastSyncedAt?: string | null;
  lastJiraStatus?: string | null;
  lastOutcome?: string | null;
  lastError?: string | null;
  lastErrorAt?: string | null;
  failures?: number;
  nextAttemptAt?: string | null;
  attemptKey?: string | null;
  attempt?: number;
}

/** Ordered names per status, then the status category to fall back on. */
export const JIRA_STATUS_TARGETS: Record<PaperclipStatus, { names: string[]; category: JiraStatusCategory | null }> = {
  backlog: { names: ["Backlog", "To Do", "Open", "Selected for Development"], category: "new" },
  todo: { names: ["To Do", "Open", "Selected for Development", "Backlog"], category: "new" },
  in_progress: { names: ["In Progress", "In Development", "Doing"], category: "indeterminate" },
  in_review: { names: ["In Review", "Code Review", "Review", "QA", "Testing"], category: "indeterminate" },
  blocked: { names: ["Blocked", "On Hold", "Impeded"], category: null },
  done: { names: ["Done", "Closed", "Resolved"], category: "done" },
  cancelled: { names: ["Cancelled", "Canceled", "Won't Do", "Won't Fix", "Rejected"], category: null },
};

const norm = (value: string | null | undefined) => (value ?? "").trim().toLowerCase().replace(/[’`]/g, "'");

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Finds Jira issue keys in free text. Only keys of the learned project keys
 * count (so `G13`, `S1-S7` or an unrelated `OSA-12` are ignored), plus browse
 * URLs of the learned Jira site hosts. Returns unique keys in order of first
 * appearance.
 */
export function findJiraKeys(text: string | null | undefined, projectKeys: Iterable<string>, siteHosts: Iterable<string> = []): string[] {
  if (!text) return [];
  const found: string[] = [];
  const add = (key: string) => { if (!found.includes(key)) found.push(key); };
  const keys = [...projectKeys].map((key) => key.toUpperCase()).filter((key) => /^[A-Z][A-Z0-9_]*$/.test(key));
  const hosts = [...siteHosts].map((host) => host.toLowerCase()).filter(Boolean);
  const hits: Array<{ index: number; key: string }> = [];
  if (hosts.length > 0) {
    const urlRe = new RegExp(`https?://(${hosts.map(escapeRegex).join("|")})/browse/([A-Z][A-Z0-9_]*-\\d+)\\b`, "gi");
    for (const match of text.matchAll(urlRe)) hits.push({ index: match.index ?? 0, key: match[2]!.toUpperCase() });
  }
  if (keys.length > 0) {
    // Longest first so `OSX` wins over `OS` in an alternation.
    const alternation = [...new Set(keys)].sort((a, b) => b.length - a.length).map(escapeRegex).join("|");
    const keyRe = new RegExp(`(?<![A-Za-z0-9_-])(${alternation})-(\\d+)(?![A-Za-z0-9_]|-\\d)`, "g");
    for (const match of text.matchAll(keyRe)) hits.push({ index: match.index ?? 0, key: `${match[1]}-${match[2]}` });
  }
  for (const hit of hits.sort((a, b) => a.index - b.index)) add(hit.key);
  return found;
}

export function jiraProjectKeyOf(issueKey: string): string {
  return issueKey.slice(0, issueKey.lastIndexOf("-"));
}

function categoryOf(value: unknown): JiraStatusCategory | null {
  const key = typeof value === "string" ? value : null;
  return key === "new" || key === "indeterminate" || key === "done" ? key : null;
}

export type JiraTransitionChoice =
  | { kind: "already"; statusName: string }
  | { kind: "transition"; transition: JiraTransition; comment?: string }
  | { kind: "comment_only"; comment: string }
  | { kind: "none"; reason: string };

function pickByNames(names: string[], candidates: JiraTransition[]): JiraTransition | null {
  for (const name of names) {
    const hit = candidates.find((transition) => norm(transition.toName) === norm(name));
    if (hit) return hit;
  }
  return null;
}

function pickByCategory(category: JiraStatusCategory, candidates: JiraTransition[], prefer?: RegExp): JiraTransition | null {
  const matching = candidates.filter((transition) => transition.toCategory === category);
  return (prefer ? matching.find((transition) => prefer.test(transition.toName)) : undefined) ?? matching[0] ?? null;
}

function targetFor(status: PaperclipStatus, candidates: JiraTransition[]): JiraTransition | null {
  const target = JIRA_STATUS_TARGETS[status];
  const named = pickByNames(target.names, candidates);
  if (named) return named;
  if (status === "in_progress") return pickByCategory("indeterminate", candidates, /progress/i);
  if (status === "in_review") {
    return pickByCategory("indeterminate", candidates, /review/i)
      ?? pickByNames(JIRA_STATUS_TARGETS.in_progress.names, candidates)
      ?? pickByCategory("indeterminate", candidates, /progress/i);
  }
  return target.category ? pickByCategory(target.category, candidates) : null;
}

/**
 * Chooses what to do in Jira for a Paperclip status, from the transitions Jira
 * offers right now. The current status counts as a candidate, so an issue
 * already in the chosen status is left alone.
 */
export function chooseJiraTransition(input: {
  paperclipStatus: string;
  current: { name: string | null; category: JiraStatusCategory | null };
  transitions: JiraTransition[];
  blockedReason?: string | null;
}): JiraTransitionChoice {
  const status = input.paperclipStatus as PaperclipStatus;
  if (!(status in JIRA_STATUS_TARGETS)) return { kind: "none", reason: `unknown Paperclip status ${input.paperclipStatus}` };
  const currentName = input.current.name ?? "";
  const currentAsCandidate: JiraTransition | null = currentName
    ? { id: "__current__", name: currentName, toName: currentName, toCategory: input.current.category }
    : null;
  const candidates = currentAsCandidate ? [currentAsCandidate, ...input.transitions] : input.transitions;
  const resolve = (chosen: JiraTransition | null, comment?: string): JiraTransitionChoice | null => {
    if (!chosen) return null;
    if (chosen.id === "__current__" || norm(chosen.toName) === norm(currentName)) {
      return comment ? { kind: "comment_only", comment } : { kind: "already", statusName: currentName };
    }
    return comment ? { kind: "transition", transition: chosen, comment } : { kind: "transition", transition: chosen };
  };
  const chosen = resolve(targetFor(status, candidates));
  if (chosen) return chosen;
  if (status === "blocked") {
    const reason = input.blockedReason?.trim();
    return { kind: "comment_only", comment: `Blocked in Paperclip${reason ? `: ${reason}` : "."}` };
  }
  if (status === "cancelled") {
    const doneLike = resolve(targetFor("done", candidates), "Cancelled in Paperclip (not delivered).");
    if (doneLike) return doneLike;
  }
  return { kind: "none", reason: `no transition to ${status} from ${currentName || "unknown"}` };
}

export type JiraSyncDecision = "synced" | "backoff" | "baseline" | "sync";

/**
 * Whether a link needs work. A link syncs only when the Paperclip status (or
 * its version) differs from what was last synced, so a person moving the Jira
 * issue afterwards is never undone until Paperclip itself changes again. A new
 * link for a task that has not started takes the current status as baseline
 * instead of pulling the Jira issue back.
 */
export function jiraSyncDecision(meta: JiraLinkMetadata, issue: { status: string; statusVersion: number }, now: Date): JiraSyncDecision {
  if (meta.lastSyncedStatus === issue.status && Number(meta.lastSyncedStatusVersion ?? -1) === Number(issue.statusVersion)) return "synced";
  if (meta.nextAttemptAt && meta.attemptKey === syncBaseKeyFor(issue) && Date.parse(meta.nextAttemptAt) > now.getTime()) return "backoff";
  if (!meta.lastSyncedStatus && !meta.lastSyncedAt && (issue.status === "backlog" || issue.status === "todo")) return "baseline";
  return "sync";
}

function syncBaseKeyFor(issue: { status: string; statusVersion: number }) {
  return `${issue.statusVersion}:${issue.status}`;
}

export function jiraSyncIdempotencyKey(linkId: string, issue: { status: string; statusVersion: number }) {
  return `jira-status:${linkId}:${issue.statusVersion}:${issue.status}`;
}

export function jiraBackoffMs(failures: number) {
  return BACKOFF_STEPS_MS[Math.min(Math.max(failures, 1), BACKOFF_STEPS_MS.length) - 1]!;
}

/** Reads the JSON a remote MCP tool returned, from structured content or text. */
export function parseToolJson(value: unknown): unknown {
  const tryParse = (text: string) => { try { return JSON.parse(text); } catch { return null; } };
  if (typeof value === "string") return tryParse(value);
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const data = record.data && typeof record.data === "object" ? record.data as Record<string, unknown> : null;
  if (data?.structuredContent && typeof data.structuredContent === "object") return data.structuredContent;
  if (typeof record.content === "string") return tryParse(record.content);
  const parts = Array.isArray(record.content) ? record.content : Array.isArray(data?.content) ? data!.content as unknown[] : null;
  if (parts) {
    const text = parts.map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string")
      ? (part as { text: string }).text : "").join("");
    return tryParse(text);
  }
  return record;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function parseJiraTransitions(value: unknown): JiraTransition[] {
  const parsed = parseToolJson(value);
  const list = Array.isArray(parsed) ? parsed : asRecord(parsed)?.transitions;
  if (!Array.isArray(list)) return [];
  return list.flatMap((item) => {
    const record = asRecord(item);
    const to = asRecord(record?.to);
    const id = record?.id;
    const toName = typeof to?.name === "string" ? to.name : typeof record?.name === "string" ? record.name : null;
    if ((typeof id !== "string" && typeof id !== "number") || !toName) return [];
    return [{ id: String(id), name: typeof record?.name === "string" ? record.name : toName, toName,
      toCategory: categoryOf(asRecord(to?.statusCategory)?.key) }];
  });
}

export function parseJiraIssueStatus(value: unknown): { name: string | null; category: JiraStatusCategory | null } {
  const parsed = asRecord(parseToolJson(value));
  const status = asRecord(asRecord(parsed?.fields)?.status);
  return { name: typeof status?.name === "string" ? status.name : null, category: categoryOf(asRecord(status?.statusCategory)?.key) };
}

export function parseJiraProjectKeys(value: unknown): string[] {
  const parsed = parseToolJson(value);
  const record = asRecord(parsed);
  const list = Array.isArray(parsed) ? parsed : record?.values ?? record?.projects ?? record?.results;
  if (!Array.isArray(list)) return [];
  return [...new Set(list.flatMap((item) => {
    const key = asRecord(item)?.key;
    return typeof key === "string" && /^[A-Z][A-Z0-9_]*$/.test(key) ? [key] : [];
  }))];
}

export function parseAtlassianSites(value: unknown): Array<{ id: string; url: string }> {
  const parsed = parseToolJson(value);
  const list = Array.isArray(parsed) ? parsed : asRecord(parsed)?.resources ?? asRecord(parsed)?.values;
  if (!Array.isArray(list)) return [];
  return list.flatMap((item) => {
    const record = asRecord(item);
    return typeof record?.id === "string" && typeof record.url === "string" ? [{ id: record.id, url: record.url.replace(/\/+$/, "") }] : [];
  });
}

type Gateway = Pick<ReturnType<typeof createToolGatewayService>, "executeSystemConnectionTool">;
type LinkRow = typeof issueWorkProducts.$inferSelect;
type IssueRow = Pick<typeof issues.$inferSelect, "id" | "companyId" | "projectId" | "identifier" | "title" | "description" | "status" | "statusVersion">;
interface JiraContext { connectionId: string; cloudId: string; siteUrl: string; projectKeys: Set<string>; loadedAt: number }

export function jiraStatusSyncService(db: Db, gateway: Gateway, options: { now?: () => Date } = {}) {
  const now = options.now ?? (() => new Date());
  const contexts = new Map<string, { value: JiraContext | null; expiresAt: number }>();
  const pendingIssueIds = new Set<string>();
  let issueScanWatermark: Date | null = null;

  async function call(companyId: string, connectionId: string, toolName: string, parameters: Record<string, unknown>,
    extra: { issueId?: string | null; idempotencyKey?: string | null } = {}) {
    const result = await gateway.executeSystemConnectionTool({
      companyId, connectionId, integration: JIRA_SYNC_INTEGRATION, upstreamToolName: toolName, parameters,
      issueId: extra.issueId ?? null, idempotencyKey: extra.idempotencyKey ?? null, timeoutMs: 30_000,
    });
    if (result.outcome !== "succeeded") {
      throw new JiraCallError(`${toolName}: ${result.outcome} (${result.reasonCode}) ${result.message}`.slice(0, 500));
    }
    return result.result;
  }

  /** Active Jira connections by company: those whose catalog lists the marker tool. */
  async function jiraConnections(companyIds?: string[]) {
    const rows = await db.select({ companyId: toolCatalogEntries.companyId, connectionId: toolCatalogEntries.connectionId })
      .from(toolCatalogEntries)
      .innerJoin(toolConnections, eq(toolConnections.id, toolCatalogEntries.connectionId))
      .where(and(
        eq(toolCatalogEntries.toolName, MARKER_TOOL),
        eq(toolCatalogEntries.status, "active"),
        isNull(toolCatalogEntries.quarantinedAt),
        eq(toolConnections.enabled, true),
        ne(toolConnections.status, "disabled"),
        ne(toolConnections.status, "archived"),
        ...(companyIds?.length ? [inArray(toolCatalogEntries.companyId, companyIds)] : []),
      ))
      .orderBy(asc(toolConnections.createdAt));
    const byCompany = new Map<string, string>();
    for (const row of rows) if (!byCompany.has(row.companyId)) byCompany.set(row.companyId, row.connectionId);
    return byCompany;
  }

  async function jiraContext(companyId: string, connectionId: string): Promise<JiraContext | null> {
    const cached = contexts.get(companyId);
    if (cached && cached.expiresAt > Date.now() && (cached.value === null || cached.value.connectionId === connectionId)) return cached.value;
    try {
      const sites = parseAtlassianSites(await call(companyId, connectionId, "getAccessibleAtlassianResources", {}));
      const site = sites[0];
      if (!site) throw new JiraCallError("getAccessibleAtlassianResources returned no Jira site");
      const projectKeys = parseJiraProjectKeys(await call(companyId, connectionId, "getVisibleJiraProjects", { cloudId: site.id }));
      const value: JiraContext = { connectionId, cloudId: site.id, siteUrl: site.url, projectKeys: new Set(projectKeys), loadedAt: Date.now() };
      contexts.set(companyId, { value, expiresAt: Date.now() + CONTEXT_TTL_MS });
      return value;
    } catch (error) {
      logger.warn({ companyId, connectionId, err: errorMessage(error) }, "jira status sync could not learn the Jira site and projects");
      contexts.set(companyId, { value: null, expiresAt: Date.now() + CONTEXT_FAILURE_TTL_MS });
      return null;
    }
  }

  async function existingLinks(issueId: string) {
    return db.select().from(issueWorkProducts).where(and(eq(issueWorkProducts.issueId, issueId),
      eq(issueWorkProducts.type, JIRA_LINK_TYPE), eq(issueWorkProducts.provider, JIRA_LINK_PROVIDER)));
  }

  /** Links every Jira key named in the task title that is not linked yet (title only; see header). */
  async function linkIssue(issue: IssueRow, context: JiraContext) {
    const host = hostOf(context.siteUrl);
    const keys = findJiraKeys(issue.title, context.projectKeys, host ? [host] : []);
    if (keys.length === 0) return 0;
    const linked = new Set((await existingLinks(issue.id)).map((link) => (link.externalId ?? "").toUpperCase()));
    let created = 0;
    for (const key of keys) {
      if (linked.has(key)) continue;
      const metadata: JiraLinkMetadata = { connectionId: context.connectionId, cloudId: context.cloudId, projectKey: jiraProjectKeyOf(key),
        lastSyncedStatus: null, lastSyncedStatusVersion: null, lastSyncedAt: null, lastJiraStatus: null, lastError: null, lastErrorAt: null };
      await workProductService(db).createForIssue(issue.id, issue.companyId, {
        projectId: issue.projectId ?? null, type: JIRA_LINK_TYPE, provider: JIRA_LINK_PROVIDER, externalId: key,
        title: `Jira ${key}`, url: `${context.siteUrl}/browse/${key}`, status: "active", metadata: metadata as Record<string, unknown>,
      });
      await logActivity(db, { companyId: issue.companyId, actorType: "system", actorId: JIRA_SYNC_INTEGRATION,
        action: "issue.jira_linked", entityType: "issue", entityId: issue.id, issueId: issue.id, details: { jiraKey: key } });
      created += 1;
    }
    return created;
  }

  async function blockedReason(issue: IssueRow) {
    const blockers = await db.select({ identifier: issues.identifier, title: issues.title, status: issues.status })
      .from(issueRelations).innerJoin(issues, eq(issues.id, issueRelations.issueId))
      .where(and(eq(issueRelations.companyId, issue.companyId), eq(issueRelations.relatedIssueId, issue.id), eq(issueRelations.type, "blocks")))
      .limit(3);
    const open = blockers.filter((blocker) => blocker.status !== "done" && blocker.status !== "cancelled");
    return open.length ? `waiting on ${open.map((blocker) => blocker.identifier ?? blocker.title).join(", ")}` : null;
  }

  async function saveMeta(link: LinkRow, meta: JiraLinkMetadata) {
    await db.update(issueWorkProducts).set({ metadata: { ...(link.metadata ?? {}), ...meta } as Record<string, unknown>, updatedAt: new Date() })
      .where(eq(issueWorkProducts.id, link.id));
  }

  /** Syncs one link. Never throws for Jira problems; records them on the link. */
  async function syncLink(link: LinkRow, issue: IssueRow, connectionIdFallback: string | null) {
    const meta = (link.metadata ?? {}) as JiraLinkMetadata;
    const at = now();
    const decision = jiraSyncDecision(meta, issue, at);
    if (decision === "synced" || decision === "backoff") return decision;
    const key = (link.externalId ?? "").toUpperCase();
    if (decision === "baseline") {
      await saveMeta(link, { lastSyncedStatus: issue.status, lastSyncedStatusVersion: issue.statusVersion, lastSyncedAt: at.toISOString(),
        lastOutcome: "baseline", failures: 0, nextAttemptAt: null, attemptKey: null, attempt: 0 });
      return decision;
    }
    const baseKey = syncBaseKeyFor(issue);
    const attempt = meta.attemptKey === baseKey ? Number(meta.attempt ?? 0) : 0;
    const idempotencyBase = jiraSyncIdempotencyKey(link.id, issue) + (attempt > 0 ? `:a${attempt}` : "");
    const connectionId = meta.connectionId ?? connectionIdFallback;
    let from: string | null = null;
    try {
      if (!connectionId) throw new JiraCallError("no active Jira connection");
      let cloudId = meta.cloudId ?? null;
      if (!cloudId) cloudId = (await jiraContext(issue.companyId, connectionId))?.cloudId ?? null;
      if (!cloudId) throw new JiraCallError("Jira site is unknown");
      const ref = { cloudId, issueIdOrKey: key };
      const current = parseJiraIssueStatus(await call(issue.companyId, connectionId, "getJiraIssue", ref, { issueId: issue.id }));
      from = current.name;
      const transitions = parseJiraTransitions(await call(issue.companyId, connectionId, "getTransitionsForJiraIssue", ref, { issueId: issue.id }));
      const choice = chooseJiraTransition({ paperclipStatus: issue.status, current, transitions,
        blockedReason: issue.status === "blocked" ? await blockedReason(issue) : null });
      let to = current.name;
      if (choice.kind === "transition") {
        await call(issue.companyId, connectionId, "transitionJiraIssue", { ...ref, transition: { id: choice.transition.id } },
          { issueId: issue.id, idempotencyKey: `${idempotencyBase}:transition` });
        to = choice.transition.toName;
      }
      if ((choice.kind === "transition" && choice.comment) || choice.kind === "comment_only") {
        await call(issue.companyId, connectionId, "addCommentToJiraIssue", { ...ref, commentBody: choice.comment, contentFormat: "markdown" },
          { issueId: issue.id, idempotencyKey: `${idempotencyBase}:comment` });
      }
      const noTransition = choice.kind === "none";
      await saveMeta(link, {
        connectionId, cloudId, lastSyncedStatus: issue.status, lastSyncedStatusVersion: issue.statusVersion, lastSyncedAt: at.toISOString(),
        lastJiraStatus: to, lastOutcome: choice.kind, failures: 0, nextAttemptAt: null, attemptKey: null, attempt: 0,
        ...(noTransition ? { lastError: choice.reason, lastErrorAt: at.toISOString() } : { lastError: null, lastErrorAt: null }),
      });
      await logActivity(db, { companyId: issue.companyId, actorType: "system", actorId: JIRA_SYNC_INTEGRATION,
        action: noTransition ? "issue.jira_status_sync_failed" : "issue.jira_status_synced", entityType: "issue", entityId: issue.id, issueId: issue.id,
        details: { jiraKey: key, paperclipStatus: issue.status, from, to, outcome: choice.kind, ...(noTransition ? { reason: choice.reason } : {}) } });
      return "sync";
    } catch (error) {
      const failures = (attempt === 0 && meta.attemptKey !== baseKey ? 0 : Number(meta.failures ?? 0)) + 1;
      const message = errorMessage(error);
      await saveMeta(link, { lastError: message, lastErrorAt: at.toISOString(), failures, attemptKey: baseKey, attempt: attempt + 1,
        nextAttemptAt: new Date(at.getTime() + jiraBackoffMs(failures)).toISOString(), lastOutcome: "error" });
      // One failure entry per Paperclip status change; retries stay on the link.
      if (failures === 1) {
        await logActivity(db, { companyId: issue.companyId, actorType: "system", actorId: JIRA_SYNC_INTEGRATION,
          action: "issue.jira_status_sync_failed", entityType: "issue", entityId: issue.id, issueId: issue.id,
          details: { jiraKey: key, paperclipStatus: issue.status, from, reason: message.slice(0, 300) } }).catch(() => undefined);
      }
      return "failed";
    }
  }

  const issueColumns = { id: issues.id, companyId: issues.companyId, projectId: issues.projectId, identifier: issues.identifier,
    title: issues.title, description: issues.description, status: issues.status, statusVersion: issues.statusVersion };

  async function sweep(signal?: AbortSignal) {
    const connections = await jiraConnections();
    if (connections.size === 0) { pendingIssueIds.clear(); return; }
    const companyIds = [...connections.keys()];

    // 1. Auto-link: tasks named by the fast path, then tasks changed recently.
    const named = [...pendingIssueIds];
    pendingIssueIds.clear();
    const since = issueScanWatermark ?? new Date(now().getTime() - SWEEP_INITIAL_LOOKBACK_MS);
    const recent = await db.select({ ...issueColumns, updatedAt: issues.updatedAt, conversationAgentId: issues.conversationAgentId }).from(issues)
      .where(and(inArray(issues.companyId, companyIds), gt(issues.updatedAt, since)))
      .orderBy(asc(issues.updatedAt)).limit(SWEEP_ISSUE_SCAN_LIMIT);
    if (recent.length) issueScanWatermark = recent[recent.length - 1]!.updatedAt;
    else if (!issueScanWatermark) issueScanWatermark = since;
    const namedRows = named.length ? await db.select({ ...issueColumns, conversationAgentId: issues.conversationAgentId }).from(issues)
      .where(and(inArray(issues.id, named.slice(0, SWEEP_ISSUE_SCAN_LIMIT)), inArray(issues.companyId, companyIds))) : [];
    const toScan = new Map<string, IssueRow>();
    // Chat conversations are not deliverable tasks; only tasks get Jira links.
    for (const row of [...namedRows, ...recent]) if (!row.conversationAgentId) toScan.set(row.id, row);
    for (const issue of toScan.values()) {
      if (signal?.aborted) return;
      const connectionId = connections.get(issue.companyId);
      if (!connectionId) continue;
      const context = await jiraContext(issue.companyId, connectionId);
      if (!context) continue;
      try { await linkIssue(issue, context); }
      catch (error) { logger.warn({ issueId: issue.id, err: errorMessage(error) }, "jira status sync could not link a task"); }
    }

    // 2. Status: links whose task status moved since the last sync.
    const due = await db.select({ link: issueWorkProducts, issue: issueColumns }).from(issueWorkProducts)
      .innerJoin(issues, eq(issues.id, issueWorkProducts.issueId))
      .where(and(
        inArray(issueWorkProducts.companyId, companyIds),
        eq(issueWorkProducts.type, JIRA_LINK_TYPE),
        eq(issueWorkProducts.provider, JIRA_LINK_PROVIDER),
        eq(issueWorkProducts.status, "active"),
        sql`((${issueWorkProducts.metadata} ->> 'lastSyncedStatus') is distinct from ${issues.status}
          or (${issueWorkProducts.metadata} ->> 'lastSyncedStatusVersion') is distinct from (${issues.statusVersion})::text)`,
        // Backoff applies only to the status change that failed; a new change goes now.
        sql`(coalesce(${issueWorkProducts.metadata} ->> 'nextAttemptAt', '') <= ${now().toISOString()}
          or (${issueWorkProducts.metadata} ->> 'attemptKey') is distinct from ((${issues.statusVersion})::text || ':' || ${issues.status}))`,
      ))
      .orderBy(asc(issueWorkProducts.updatedAt)).limit(SWEEP_LINK_LIMIT);
    for (const row of due) {
      if (signal?.aborted) return;
      await syncLink(row.link, row.issue, connections.get(row.issue.companyId) ?? null);
    }
  }

  return {
    sweep,
    syncLink,
    linkIssue,
    /** Fast path: a task changed; link and sync it on the next (immediate) run. */
    noteIssueChanged(issueId: string) {
      if (pendingIssueIds.size < 1_000) pendingIssueIds.add(issueId);
    },
    hasPending: async () => pendingIssueIds.size > 0,
  };
}

class JiraCallError extends Error {}

function errorMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

function hostOf(url: string) {
  try { return new URL(url).host; } catch { return null; }
}
