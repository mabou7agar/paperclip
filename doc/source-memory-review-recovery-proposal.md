# Review recovery procedure proposal

Status: proposal for CTO decision; no recovery bypass is implemented or authorized.
Scope: configured, bound source-memory reviews. Existing accepted results, task,
stage, participant, session, source and lease context remain intact.

1. Keep the recovered completion fail closed with `recovery_snapshot_unverified`
   when its original source/reader authority cannot be verified. Retain the
   original run and session. Do not reinterpret a newly observed HEAD as its
   candidate, clear the saved snapshot, or restart all source reviews.
2. An operator records the original full candidate SHA, company/project/repository,
   task, stage/participant, source run, workspace binding revision, reader manifest
   hash and retained lease/epoch/allocation. Use authorized metadata only; never
   copy private ledgers or credentials into the task. A mismatch stays held.
3. Proposed exact resumption event: the normal protected recovery owner commits
   a verified original-source recovery receipt for that same run/candidate and
   current stage/participant. This event is not currently implemented by this
   proposal. Configuration changes, comments, timers and provider prose do not
   constitute the event. Missing original source requires a separate CTO decision,
   not an automatic candidate replacement.
4. Before any permitted attempt, persist a durable idempotency key containing the
   source run, task, stage and candidate, plus the already-authorized finite
   attempt cap/deadline. Atomically claim at most one continuation; accepted or
   terminal receipts consume that key and cannot dispatch another provider run.
   A lost, cancelled or ambiguous receipt causes one lead hold; no automatic retry,
   counter reset, deadline extension or new task is permitted.
5. Recheck current company/task/workspace access, native ownership and original
   source authority before bounded immutable reads and before publishing their
   verdict. Existing success receipts stay accepted; verify only the unresolved
   evidence obligation. If paid execution becomes necessary, stop for separately
   authorized bounded execution rather than replaying completed provider work.
6. Use native completion and existing review/CTO stages once verified. Record exit,
   totals, candidate, run and evidence hashes. Any new candidate invalidates the
   affected reviews and requires a new admitted decision within existing budgets.

This procedure needs an implementation/design decision about the protected
original-source recovery receipt and its durable single-consumer owner before it
can operate. It grants no activation, deployment, production-data access, test
resubmission or blanket SourceReview restart.
