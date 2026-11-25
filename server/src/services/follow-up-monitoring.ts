import { and, asc, desc, eq, gte, inArray, isNull, ne, notInArray } from "drizzle-orm";
import { agents, companies, documents, issueComments, issueDocuments, issueThreadInteractions, issues, type Db } from "@paperclipai/db";
import type { MonitoringObservation } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { monitoringService, type MonitoringServiceDeps } from "./monitoring.js";

/**
 * Report-only checks for work that is left where nobody will pick it up:
 * open items written into a closed task's register with no follow-up tasks,
 * and a decision handed to the owner without an owner question card.
 * They record an alert-only monitoring observation and let the monitoring
 * nudge plumbing (dedup, locking, rate limits) wake one agent.
 */

const NON_INVOKABLE_AGENT_STATUSES = ["paused", "terminated", "pending_approval"];

/** A heading or document title that introduces a register of open items. */
const REGISTER_HEADING = /\b(gaps?|follow[- ]?ups?|open items?|open issues|outstanding items?|closure register|gap register)\b/i;
/** A short table cell whose value is an open-like state. */
const OPEN_STATE_CELL =
  /^(not tested|untested|partial(?:ly)?(?: tested| done| verified)?|blocked|open|todo|to do|follow[- ]?up(?: needed| required)?|disclosed limit(?:ation)?s?|pending)(?![\p{L}-])/iu;
/** In a bullet, a state written as a marker: bold, bracketed, after "status:" or a dash. */
const OPEN_STATE_MARKER =
  /(?:\*\*|\[|\(|status:\s*|[—–]\s*|\s-\s+)(not tested|partial(?:ly)?|blocked|open|todo|follow[- ]?up|disclosed limit(?:ation)?|pending)(?![\p{L}-])/iu;
/** In a bullet, a state written in capitals as its own word. */
const OPEN_STATE_CAPS = /(?<![\p{L}-])(NOT TESTED|PARTIAL|BLOCKED|OPEN|TODO|PENDING)(?![\p{L}-])/u;
const STATE_CELL_MAX_LENGTH = 40;
const MAX_LISTED_ITEMS = 12;

export type OpenRegisterItem = { id: string | null; state: string; text: string };

function stripFencedCode(markdown: string) {
  return markdown.replace(/^(\s*)(```|~~~)[\s\S]*?^\1\2\s*$/gm, "");
}

function cleanCell(cell: string) {
  return cell.replace(/[*_`]/g, "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
}

function itemId(token: string | undefined) {
  const match = /^([A-Z]{1,4}-?\d{1,3})(?=$|[\s:.)\]—–-])/.exec(cleanCell(token ?? ""));
  return match ? match[1]! : null;
}

const isTableSeparator = (line: string) => /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes("-") && line.includes("|");

/**
 * Open items of a register section (a heading, or the whole document when its
 * title names a register): table rows with a short open-like state cell, or
 * bullets with an unchecked box or a marked open-like state. Conservative by
 * design: prose outside a register, done/waived rows, and long description
 * cells that merely start with "Blocked" or "Open" are not items.
 */
export function findOpenRegisterItems(markdown: string, title?: string | null): OpenRegisterItem[] {
  const lines = stripFencedCode(markdown).split(/\r?\n/);
  const titleIsRegister = Boolean(title && REGISTER_HEADING.test(title));
  let inRegister = titleIsRegister;
  let registerLevel = 0;
  const items: OpenRegisterItem[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const heading = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      if (REGISTER_HEADING.test(heading[2]!)) {
        inRegister = true;
        registerLevel = level;
      } else if (registerLevel > 0 && level <= registerLevel) {
        inRegister = titleIsRegister;
        registerLevel = 0;
      }
      continue;
    }
    if (!inRegister) continue;
    if (/^\s*\|/.test(line)) {
      if (isTableSeparator(line) || isTableSeparator(lines[index + 1] ?? "")) continue;
      const cells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(cleanCell);
      const state = cells.find(cell => cell.length > 0 && cell.length <= STATE_CELL_MAX_LENGTH && OPEN_STATE_CELL.test(cell));
      if (state) items.push({ id: itemId(cells[0]), state: OPEN_STATE_CELL.exec(state)![1]!, text: cells.filter(Boolean).join(" | ") });
      continue;
    }
    const bullet = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (!bullet) continue;
    const body = bullet[1]!;
    if (/^\[[xX]\]/.test(body)) continue;
    const state = /^\[ \]/.test(body) ? "unchecked" : (OPEN_STATE_MARKER.exec(body)?.[1] ?? OPEN_STATE_CAPS.exec(body)?.[1]);
    if (state) items.push({ id: itemId(body.replace(/^\[ \]\s*/, "")), state, text: cleanCell(body.replace(/^\[ \]\s*/, "")) });
  }
  return items;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The register items no follow-up task covers. Child tasks cover the register
 * when there are at least as many as open items; otherwise an item is covered
 * when a child's title names its id (for example "G3").
 */
export function untrackedRegisterItems(items: readonly OpenRegisterItem[], childTitles: readonly string[]): OpenRegisterItem[] {
  if (items.length === 0 || childTitles.length >= items.length) return [];
  return items.filter(item => !(item.id && childTitles.some(title =>
    new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(item.id!)}(?![\\p{N}])`, "iu").test(title))));
}

export function untrackedFollowUpsInstruction(items: readonly OpenRegisterItem[], sources: readonly string[]) {
  const listed = items.slice(0, MAX_LISTED_ITEMS).map(item => {
    const text = item.text.length > 70 ? `${item.text.slice(0, 67)}...` : item.text;
    return `${text} (${item.state})`;
  });
  const more = items.length > MAX_LISTED_ITEMS ? `; and ${items.length - MAX_LISTED_ITEMS} more` : "";
  return [
    `This task closed with ${items.length} open item${items.length === 1 ? "" : "s"} in ${sources.join(", ")} and no follow-up tasks: ${listed.join("; ")}${more}.`,
    "For each item, create one follow-up task (its id in the title, this task as parent), or raise one owner question card asking which items to waive.",
  ].join(" ");
}

/** Statements that the owner must decide, conservative on purpose. */
const OWNER_DECISION_PATTERNS = [
  /\b(?:the |an? )?owner (?:decides|will decide|to decide|must decide|needs to decide|should decide|has to decide)\b/i,
  /\bfor (?:the )?owner(?:'s)? (?:decision|approval|sign-?off)\b/i,
  /\bowner's (?:decision|approval)\b/i,
  /\bawaiting (?:the |an? )?owner\b/i,
  /\bwaiting (?:on|for) (?:the |an? )?owner\b/i,
  /\bneeds? (?:the )?owner(?:'s)? approval\b/i,
];
const NEGATION_BEFORE = /\b(?:no|not|without|never|don't|doesn't|isn't)\b[^.!?\n]{0,25}$/i;
/** "the owner's decision: ..." or "... was ..." reports a decision already made. */
const DECISION_MADE_AFTER = /^\s*(?::|was\b|is to\b|has been\b|came\b)/i;

/**
 * The phrase in a comment or document that hands a decision to the owner, or
 * null. Quoted lines and fenced code are ignored, as are negated phrases
 * ("no owner decision needed") and reports of a decision already made.
 */
export function findOwnerDecisionRequest(text: string): string | null {
  const body = stripFencedCode(text).replace(/[\u2018\u2019]/g, "'")
    .split(/\r?\n/).filter(line => !/^\s*>/.test(line)).join("\n");
  for (const pattern of OWNER_DECISION_PATTERNS) {
    const global = new RegExp(pattern.source, "gi");
    for (const match of body.matchAll(global)) {
      const before = body.slice(Math.max(0, match.index! - 40), match.index!);
      const after = body.slice(match.index! + match[0].length, match.index! + match[0].length + 20);
      if (NEGATION_BEFORE.test(before) || DECISION_MADE_AFTER.test(after)) continue;
      return match[0];
    }
  }
  return null;
}

export function ownerDecisionInstruction(phrase: string, closed: boolean) {
  return `This task says "${phrase}", but no owner question card was raised, so nobody will decide. ` +
    `Raise one owner question card with concrete options${closed ? " (on a follow-up task, since this task is closed)" : ""}, then wait for the answer.`;
}

async function invokableAgent(db: Db, companyId: string, agentId: string | null | undefined) {
  if (!agentId) return null;
  const [agent] = await db.select({ id: agents.id, status: agents.status }).from(agents)
    .where(and(eq(agents.companyId, companyId), eq(agents.id, agentId))).limit(1);
  return agent && !NON_INVOKABLE_AGENT_STATUSES.includes(agent.status) ? agent.id : null;
}

async function invokableAgentWithRole(db: Db, companyId: string, role: string) {
  const [agent] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, companyId), eq(agents.role, role),
    notInArray(agents.status, NON_INVOKABLE_AGENT_STATUSES))).orderBy(asc(agents.createdAt)).limit(1);
  return agent?.id ?? null;
}

/**
 * The agent woken about a task's untracked work: its assignee when that agent
 * can run, otherwise (optionally an agent with the preferred role, then) the
 * company's review escalation agent, then the CTO.
 */
export async function resolveFollowUpNudgeAgent(db: Db, companyId: string, assigneeAgentId: string | null,
  options: { preferRole?: string } = {}) {
  const assignee = await invokableAgent(db, companyId, assigneeAgentId);
  if (assignee) return assignee;
  if (options.preferRole) {
    const preferred = await invokableAgentWithRole(db, companyId, options.preferRole);
    if (preferred) return preferred;
  }
  const [company] = await db.select({ agentId: companies.defaultReviewEscalationAgentId }).from(companies)
    .where(eq(companies.id, companyId)).limit(1);
  return await invokableAgent(db, companyId, company?.agentId) ?? await invokableAgentWithRole(db, companyId, "cto");
}

export function followUpMonitoring(db: Db, deps: MonitoringServiceDeps = {}) {
  const monitoring = monitoringService(db, deps);

  /**
   * After a task closes: open register items in its documents or latest
   * comment that no child task tracks are reported once per source revision,
   * and one agent is nudged to file them or ask the owner. Never blocks.
   */
  async function checkClosedIssue(companyId: string, issueId: string): Promise<MonitoringObservation | null> {
    if ((await monitoring.policy(companyId)).mode !== "alert_only") return null;
    const [issue] = await db.select({ id: issues.id, status: issues.status, assigneeAgentId: issues.assigneeAgentId,
      conversationAgentId: issues.conversationAgentId, conversationUserId: issues.conversationUserId })
      .from(issues).where(and(eq(issues.companyId, companyId), eq(issues.id, issueId))).limit(1);
    if (!issue || !["done", "cancelled"].includes(issue.status)) return null;
    if (issue.conversationAgentId && issue.conversationUserId) return null;
    const sources: { ref: string; label: string; createdAt: Date; items: OpenRegisterItem[] }[] = [];
    const docs = await db.select({ id: documents.id, key: issueDocuments.key, title: documents.title, body: documents.latestBody,
      revisionId: documents.latestRevisionId, revisionNumber: documents.latestRevisionNumber, createdAt: documents.createdAt })
      .from(issueDocuments).innerJoin(documents, eq(issueDocuments.documentId, documents.id))
      .where(and(eq(issueDocuments.companyId, companyId), eq(issueDocuments.issueId, issueId)));
    for (const doc of docs) {
      const items = findOpenRegisterItems(doc.body, doc.title);
      if (items.length > 0) sources.push({ ref: `document:${doc.id}:${doc.revisionId ?? doc.revisionNumber}`,
        label: `document "${doc.title ?? doc.key}"`, createdAt: doc.createdAt, items });
    }
    const [comment] = await db.select({ id: issueComments.id, body: issueComments.body, createdAt: issueComments.createdAt })
      .from(issueComments).where(and(eq(issueComments.companyId, companyId), eq(issueComments.issueId, issueId),
        isNull(issueComments.deletedAt))).orderBy(desc(issueComments.createdAt)).limit(1);
    if (comment) {
      const items = findOpenRegisterItems(comment.body);
      if (items.length > 0) sources.push({ ref: `comment:${comment.id}`, label: "the closing comment", createdAt: comment.createdAt, items });
    }
    if (sources.length === 0) return null;
    const since = new Date(Math.min(...sources.map(source => source.createdAt.getTime())));
    const children = await db.select({ title: issues.title }).from(issues).where(and(eq(issues.companyId, companyId),
      eq(issues.parentId, issueId), ne(issues.status, "cancelled"), gte(issues.createdAt, since)));
    const untracked = untrackedRegisterItems(sources.flatMap(source => source.items), children.map(child => child.title));
    if (untracked.length === 0) return null;
    const observation: MonitoringObservation = {
      companyId, issueId, kind: "untracked_follow_ups",
      fingerprint: JSON.stringify(["untracked_follow_ups", ...sources.map(source => source.ref).sort()]),
      nudgeAgentId: await resolveFollowUpNudgeAgent(db, companyId, issue.assigneeAgentId),
      nudgeInstruction: untrackedFollowUpsInstruction(untracked, sources.map(source => source.label)),
      details: { openItems: untracked.slice(0, 50).map(item => ({ id: item.id, state: item.state })), openItemCount: untracked.length },
    };
    await monitoring.observe(observation);
    return observation;
  }

  /**
   * A task (open, or closed with this check run at close) whose latest agent
   * comment or agent-written document hands a decision to the owner, with no
   * owner question card on it or its parent since, is reported once per
   * source and one agent is nudged to raise the card.
   */
  async function checkOwnerDecision(companyId: string, issueId: string): Promise<MonitoringObservation | null> {
    if ((await monitoring.policy(companyId)).mode !== "alert_only") return null;
    const [issue] = await db.select({ id: issues.id, status: issues.status, parentId: issues.parentId, assigneeAgentId: issues.assigneeAgentId,
      assigneeUserId: issues.assigneeUserId, conversationAgentId: issues.conversationAgentId, conversationUserId: issues.conversationUserId })
      .from(issues).where(and(eq(issues.companyId, companyId), eq(issues.id, issueId))).limit(1);
    if (!issue || issue.status === "backlog" || issue.assigneeUserId) return null;
    if (issue.conversationAgentId && issue.conversationUserId) return null;
    const candidates: { ref: string; at: Date; text: string }[] = [];
    const [comment] = await db.select({ id: issueComments.id, body: issueComments.body, createdAt: issueComments.createdAt,
      authorAgentId: issueComments.authorAgentId })
      .from(issueComments).where(and(eq(issueComments.companyId, companyId), eq(issueComments.issueId, issueId),
        isNull(issueComments.deletedAt))).orderBy(desc(issueComments.createdAt)).limit(1);
    // A person writing "the owner decides" is not waiting for a card.
    if (comment?.authorAgentId) candidates.push({ ref: `comment:${comment.id}`, at: comment.createdAt, text: comment.body });
    const docs = await db.select({ id: documents.id, body: documents.latestBody, revisionId: documents.latestRevisionId,
      revisionNumber: documents.latestRevisionNumber, updatedAt: documents.updatedAt, updatedByAgentId: documents.updatedByAgentId })
      .from(issueDocuments).innerJoin(documents, eq(issueDocuments.documentId, documents.id))
      .where(and(eq(issueDocuments.companyId, companyId), eq(issueDocuments.issueId, issueId)));
    for (const doc of docs) {
      if (doc.updatedByAgentId) candidates.push({ ref: `document:${doc.id}:${doc.revisionId ?? doc.revisionNumber}`, at: doc.updatedAt, text: doc.body });
    }
    const source = candidates.map(candidate => ({ ...candidate, phrase: findOwnerDecisionRequest(candidate.text) }))
      .filter(candidate => candidate.phrase).sort((a, b) => b.at.getTime() - a.at.getTime())[0];
    if (!source) return null;
    const cards = await db.select({ status: issueThreadInteractions.status, createdAt: issueThreadInteractions.createdAt })
      .from(issueThreadInteractions).where(and(eq(issueThreadInteractions.companyId, companyId),
        inArray(issueThreadInteractions.issueId, issue.parentId ? [issueId, issue.parentId] : [issueId]),
        eq(issueThreadInteractions.kind, "ask_user_questions")));
    if (cards.some(card => card.status === "pending" || card.createdAt >= source.at)) return null;
    const closed = issue.status === "done" || issue.status === "cancelled";
    const observation: MonitoringObservation = {
      companyId, issueId, kind: "owner_decision_without_card",
      fingerprint: JSON.stringify(["owner_decision_without_card", source.ref]),
      nudgeAgentId: await resolveFollowUpNudgeAgent(db, companyId, issue.assigneeAgentId, { preferRole: "pm" }),
      nudgeInstruction: ownerDecisionInstruction(source.phrase!, closed),
      details: { source: source.ref, phrase: source.phrase },
    };
    await monitoring.observe(observation);
    return observation;
  }

  return { checkClosedIssue, checkOwnerDecision };
}

/** How often the periodic sweep re-reads one task for an unasked owner decision. */
const OWNER_DECISION_SWEEP_INTERVAL_MS = 15 * 60 * 1000;
const ownerDecisionSweptAt = new Map<string, number>();

/**
 * Called by the periodic issue recovery sweep for each task it visits:
 * throttled per task, detached and best effort, so it never slows or fails
 * the recovery pass.
 */
export function sweepIssueOwnerDecision(db: Db, companyId: string, issueId: string, now = Date.now()) {
  const last = ownerDecisionSweptAt.get(issueId);
  if (last !== undefined && now - last < OWNER_DECISION_SWEEP_INTERVAL_MS) return;
  if (ownerDecisionSweptAt.size > 50_000) {
    for (const [key, at] of ownerDecisionSweptAt) if (now - at >= OWNER_DECISION_SWEEP_INTERVAL_MS) ownerDecisionSweptAt.delete(key);
  }
  ownerDecisionSweptAt.set(issueId, now);
  void followUpMonitoring(db).checkOwnerDecision(companyId, issueId).catch(error =>
    logger.warn({ err: error, companyId, issueId }, "owner decision check failed"));
}

/** A just-closed task's comment may be written right after the status change. */
const CLOSED_ISSUE_CHECK_DELAY_MS = 5_000;

/** Run the closed-task check shortly after the transition commits, detached and best effort. */
export function scheduleClosedIssueFollowUpCheck(db: Db, companyId: string, issueId: string) {
  const timer = setTimeout(() => {
    const checks = followUpMonitoring(db);
    checks.checkClosedIssue(companyId, issueId).catch(error =>
      logger.warn({ err: error, companyId, issueId }, "closed task follow-up check failed"));
    checks.checkOwnerDecision(companyId, issueId).catch(error =>
      logger.warn({ err: error, companyId, issueId }, "closed task owner decision check failed"));
  }, CLOSED_ISSUE_CHECK_DELAY_MS);
  timer.unref?.();
}
