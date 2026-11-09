import type { Db } from "@paperclipai/db";
import { readPreparationJournalEvidence, type CancelledExecutionStopRun } from "../repositories/agent-execution-stop.js";
import { claimedAdapterType } from "./conversation-continuation.js";
import { legacyControllerBootId } from "./legacy-controller-lease.js";
import { executionStartedEventPredicate } from "./pre-dispatch-execution-evidence.js";
import { hasRequiredWorkspaceRecovery } from "./workspace-restore-recovery-state.js";

const accountingKeys = new Set(["ledgerScope", "accountingReceiptReady", "accountingReceiptSequence",
  "accountingReceiptSourceId", "accountingProviderWorkStarted"]);
const refusalBeforeDispatch = new Set(["legacy_disposition_repair_suppressed", "continuation_task_ownership_changed"]);
const preparationResultKeys = new Set(["cancellation", "conversationContinuation", "stopReason", "timeoutFired",
  "timeoutSource", "timeoutConfigured", "effectiveTimeoutSec", "startupCancellation", "cancelledByActorType",
  "cancelledByUserId", "retryAt", "executionRecovery"]);

/** Physical Stop proof only. Never resolves a task recovery hold or authorizes replay.
 * These built-in adapters await adapter.invoke publication before a CLI execution
 * or ACP prompt. A sealed controller plus the COMPLETE non-execution journal can
 * therefore certify their old cancelled preparations without inventing an ACK.
 */
export async function hasSettledLegacyPreparation(db: Db, run: CancelledExecutionStopRun): Promise<boolean> {
  if (run.runtimeMode !== "legacy" || run.status !== "cancelled" || run.executionStage !== "settled"
    || !run.startedAt || !run.finishedAt || run.startedAt > run.finishedAt
    || !run.controllerBootId || run.controllerBootId === legacyControllerBootId || run.controllerLeaseExpiresAt !== null
    || run.processPid || run.processGroupId || run.processStartedAt || run.sessionIdAfter
    || run.nativeIssueId || run.nativeSessionId || run.externalRunId
    || !["claude_local", "codex_local"].includes(claimedAdapterType(run) ?? "")
    || run.runnerProfileJson?.nativeExecutionInput != null || run.runnerProfileJson?.nativeWorkspaceSync != null
    || run.runnerProfileJson?.remoteWorkspace != null || run.resultJson?.workspaceRestoreFailure != null
    || hasRequiredWorkspaceRecovery(run.resultJson)
    || run.resultOutputPresent || Object.keys(run.resultJson ?? {}).some(key => !preparationResultKeys.has(key))
    || (run.resultJson?.executionRecovery as Record<string, unknown> | undefined)?.providerWorkStarted === true
    || run.usageJson?.accountingProviderWorkStarted === true
    || Object.keys(run.usageJson ?? {}).some(key => !accountingKeys.has(key))
    || Boolean(run.stdoutExcerpt) || Boolean(run.stderrExcerpt) || (run.logBytes ?? 0) > 0
    || !Number.isSafeInteger(run.nextEventSeq) || run.nextEventSeq <= 1) return false;
  // Unclassified output cannot be assumed to be a preparation diagnostic. The
  // named refusals are server-owned gates which return before adapter dispatch.
  if (run.lastOutputSeq !== 0 && !refusalBeforeDispatch.has(run.errorCode ?? "")) return false;
  const executionStarted = executionStartedEventPredicate();
  if (!executionStarted) return false;
  const journal = await readPreparationJournalEvidence(db, run, executionStarted);
  return Boolean(journal && !journal.executionStarted && !journal.resultExists
    && journal.firstSeq === 1 && Number(journal.lastSeq) === run.nextEventSeq - 1
    && journal.count === run.nextEventSeq - 1 && journal.distinctCount === journal.count);
}
