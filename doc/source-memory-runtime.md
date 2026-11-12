# Maintained source evidence at runtime

Historical foundation: OSA-371 on `cbc440ad58291f8d8a6d90264c56105dcc61ba58`;
current source contract includes the A6c gates on accepted A6b `76ef6151`.
This patch is inert until an operator supplies `PAPERCLIP_SOURCE_MEMORY_CONFIG`.
Installation, configuration changes, live consumer activation, merge and deployment
remain outside the implementation handoff. Final entire-diff independent actual
Anthropic Tech Lead review and CTO acceptance are required.

## Ownership and flow

`heartbeat/source-memory.ts` prepares evidence before native/legacy runtime
selection. `heartbeat.ts` supplies authenticated company/task/project, prepared
workspace, selected phase/account/model, cancellation, existing execution-owner
checks and fresh workspace authority. Source identity is checked again immediately
before both native and legacy dispatch, outside the atomic admission transaction.
A changed source refuses dispatch instead of sending the previously built prompt. Task text supplies neither roots nor scope.
The selected route metadata describes routing; it is not proof of a completed
model session. Verify actual native run provider metadata separately for review.

For remote authority, the existing task runner executes a closed read-only Git
protocol. Each request rechecks native/controller ownership, workspace writer,
epoch, allocation, lease and remote cwd. After execution, an unchanged epoch with
no successor writer may be observed at the commit boundary. A stale controller
mirror is never substituted. Git metadata and common objects must remain within
the selected remote base. No workspace archive, raw ledger or Git directory is
copied. The exact accepted SafeGitRepository/GitStorageRepository sources are
hash-verified and reused in the remote command; arbitrary executable RPC content
is refused. Commands cannot invoke a shell, fetch, push or write repository state.

The manifest-pinned reader remains unchanged. Runtime wraps its source boundary
in **immutable Git commit mode**: index/retrieve reads committed Git objects at
an exact full SHA; before/after actual HEAD, ref, hidden index flags, tracked-diff
hash and untracked-path hash detect drift. Dirty source remains separate, is
never indexed, and is not described as a clean checkout. This is intentionally
different from the reader's original manual clean-checkout phase command.

No source checkout is switched or reset. Each task/ref and frozen review keeps
its own source; the runtime ledger retains immutable historical revisions.
Current-receipt citation checks reject scope/revision mismatches. A changed
commit builds a complete new reader manifest, excludes deleted paths and tracks
both names of a rename for affected-source triage. Old citations are historical,
not current evidence for another candidate.

An isolated worker serializes a scope with SQLite BEGIN IMMEDIATE (bounded lock
wait), then atomically records the event, ref pointer, affected queue, observation
provenance and verified source ranges. Incomplete work does not publish an event
or advance the ref pointer. The accepted reader's own complete-manifest gate
remains in force. A killed worker releases its transaction; the next actual
phase/event reconstructs unfinished work. There is no timer, background sweep,
provider inference call or agent wake from this subsystem.

Events deduplicate by company/repository/task-ref/full SHA, additionally partitioned
by project scope. The logical task ref combines authenticated task identity with
the actual Git ref; two detached or similarly named task branches cannot move
one another's cursor. Blob reuse remains scoped to company/project/repository. Duplicate events reuse complete manifests and read zero new
blobs. Remote freshness still requires task-runner filesystem commands; these
are transport calls, not model inference. An ordinary task's agent execution is
not an indexing-triggered wake.

Affected-source triage is deterministic: changed paths, lexical name references,
and inferred same-module paths, labelled with possible caller/contract/test roles.
It is not an AST, resolved call graph or semantic review. Full queues persist;
Retrieval terms come from bounded authenticated task title/description (query
text never selects scope or roots), with an affected-path fallback. Prompt
evidence exposes at most 50 queue entries (with an explicit truncation
flag), plus at most 20 affected-path reader hits, each bounded to 40 lines/4000
characters. Verified facts are source ranges with SHA/hash/line provenance;
semantic standing remains unreviewed and Discovery's writer/state is untouched.

## Configuration (future activation only)

Operator-owned JSON, outside task control:

```json
{
  "version": 1,
  "state": "/private/new-runtime-source-state",
  "reader": "/approved/tooling-9c477cebfff7",
  "manifest": "/approved/tooling-9c477cebfff7-manifest.json",
  "bindings": [{
    "companyId": "COMPANY_ID",
    "projectId": "PROJECT_ID",
    "repositoryId": "github.com/OWNER/REPOSITORY",
    "roots": ["/approved/local/task-root-parent"],
    "remoteRoots": ["/approved/remote/task-root-parent"]
  }]
}
```

Only actually used, currently authorized repositories belong in bindings.
Repository identity must match both authenticated workspace URL and source origin.
HTTPS origins and full 40-character Git SHA-1 commits are supported by this patch;
other identity formats fail closed. Roots must contain the actual repository
root, not merely a nested directory. Remote roots are checked against authorized
remote location; local roots resolve physical paths. Unbound scopes perform no
indexing. Bound scopes with missing phase/provider/model or transport authority
fail rather than reuse old evidence. The state namespace is private (0700);
SQLite journal permissions are 0600. The reader manifest and all 38 listed files
must match the accepted version. No v1/v2 or Discovery ledger is imported.

Configuration absent: no configuration, repository, database or remote reads.
Existing recovery/reattach keeps its persisted input and cleanup ownership; it
is not reinterpreted as a new phase. A subsequent ordinary admission checks fresh
source again. This preserves previous-release sessions without adding a new
saved native input schema or changing provider pack identity.

The worker has a 180-second deadline and bounded output. Source limits remain
the accepted reader limits (50,000 files, 256,000 bytes per file, 128 MiB total).
Remote batches contain at most 50 files. Initial indexing latency at production
scale is unmeasured and must be checked before activation. Failures retain the
candidate and fail source preparation; they do not silently fall back. A
post-result commit-refresh failure is recorded without replacing an accepted
provider result; the next ordinary phase must reconstruct freshness. If this
warning occurs with no subsequent phase, indexing remains pending: no autonomous
retry/wake is claimed.

## Focused verification

No PHP/application tests, production access, paid model probe or live journey is
part of these fixtures. Use new synthetic repositories and ledgers only.

With repository dependencies prepared by `node scripts/agent-preflight.mjs`,
compile only the three new service files with TypeScript into a temporary ESM
output tree. Set `SOURCE_MEMORY_HEARTBEAT_FIXTURE` to its
`heartbeat/source-memory.js` and `SOURCE_MEMORY_READER_FIXTURE` to the
manifest-verified accepted bundle. Then run:

```sh
node --test server/src/services/source-memory.test.mjs
```

Fixtures cover changed/duplicate commit, concurrent workers, rename/delete,
stale citation, all three phase labels, dirty diff, scope/root/origin mismatch,
remote transport confinement, source mutation during indexing and restart,
frozen review independence, disabled/recovery behavior, remote epoch mismatch,
and executable Git configuration. Actual native/legacy assembled-server and
provider journeys remain gated; a synthetic phase label is not a live model run.

## Gated real journey plan

After applicable acceptance and separately authorized activation, bind only the
approved synthetic repositories. At each ordinary planning, implementation and
review admission, record authenticated company/project/repository, full candidate
SHA, phase, actual effective provider/model and run ID. Check native and legacy
prompt delivery, including a native review prompt and warm continuation.

Advance an implementation branch while retaining an independent frozen review
candidate. Verify current citations follow each candidate without branch changes;
submit duplicate commits and inspect zero new blob reads and zero indexing-caused
model calls/wakes. Rename/delete a source and verify stale ranges are rejected.
Restart between partial indexing and publication and confirm one completed event.
For remote storage, include a real writer/epoch change under the actual provider's
confinement. Verify failure/Stop and accepted-result settlement preserve existing
ownership and cleanup. Record transport calls separately from model calls.

Do not run this journey, configure live consumers or retire caches as part of the
preparation task. It is an activation verification plan, not claimed evidence.

## Owner-authorized blob integrity correction

Before the accepted reader receives any cacheable batch, the runtime wrapper
validates each raw `cat-file --batch` frame, requested object id, canonical byte
length, delimiter and complete response. It computes Git's SHA-1 over
`blob <byte length>\0` followed by the exact bytes, before UTF-8 decoding. Any
mismatch rejects the whole batch before reader-cache insertion in both local and
remote paths. Local Git output is not trusted merely because Git returned it.
The accepted reader and its manifest remain unchanged. No preexisting ledger or
cache is read, repaired or migrated by this correction; previous unverified state
is not qualified for activation by this patch.

The separately runnable `source-memory-blob-integrity.test.mjs` uses only new
synthetic state and nonroot scratch. It forges a loose Git object under a genuine
blob id in each transport, checks rejection and absence of cache/event/fact
publication, then checks another task's frozen source and verified cross-task
reuse in the same synthetic cache scope. The remote transport is a local
`execFile` stand-in, not a real provider or task-runner journey. The saved original
16-test receipt is historical (one parent plus 15 cases), not a rerun or approval
of the corrected candidate. Run only the new file for this bounded cycle.

Recorded activation concerns from the first independent review remain unresolved:
unbound non-HTTPS repository parsing can fail before binding selection; write-lock
contention and production-scale latency are unmeasured; agent-authored citations
are not checked by the runtime helper; worker lifetime and facts/observations retention are addressed by the
source-only A5 candidate described below. Full server semantic typecheck,
assembled/native-provider and live journeys remain unexecuted. These concerns are
preserved for the fresh entire-diff review and CTO source-only disposition. No
installation, activation, consumer switch, cache retirement, merge or deployment
is authorized. Any new actionable finding after the authorized round parks with
the owner; this document authorizes no further corrective cycle.

## A4 structured citation consumption (source-only)

`source-citation-authorization.ts` calls the real
`assertTaskWorkspaceExecutionAccess` on each consumption and reloads the selected
source/workspace. The principal, company, task and repository are server-derived;
submitted citations cannot choose that scope. At ordinary admission the real reader resolves the prepared workspace HEAD to
its full 40-hex commit, and the server records `{workspaceId, revision}` in
`heartbeatRuns.contextSnapshot.sourceSnapshot` before provider dispatch. A
conditional write refuses to replace an existing snapshot. `baseRef` is only
workspace preparation input (a branch or older commit); it never binds citations.
Consumption reloads the snapshot for the authenticated run, company, task and
workspace. Missing/invalid run snapshots fail closed without falling back to
baseRef. Dispatch rechecks the binding and real HEAD/dirty state.

Review admission can carry a handed-off full SHA in server run context
`reviewCandidateSha` (passed to the helper as `frozenRevision`). When supplied,
it must equal the reader-resolved, recorded HEAD; a different candidate fails
closed. This is a narrowing constraint, never permission to read another repo.
The candidate is explicit structured context; prose is not scanned for SHAs.

Agents submit at most 20 structured `sourceCitations` entries: native PRP
`result.sourceCitations`, legacy adapter `resultJson.sourceCitations`. Each entry
is `{repo, fullSha, path, startLine, endLine, sha256, mode, receiptId?}`. `mode` is
explicitly `current` or `historical`; no free text is scanned. `receiptId` is
optional opaque metadata, never an authority or a replacement for verification.
Current citations must match the prepared server receipt through
`assertCurrentSourceCitation` and the frozen run commit. Reader metadata outside
these contract fields does not need to be echoed by an agent.

Both modes re-read immutable committed Git objects through the bound,
manifest-guarded transport. `readSourceCitationFromGit` verifies commit, exact
regular-file tree entry, raw Git blob digest, full-file SHA-256 and bounded line
range (40 lines, 256,000 file bytes, 16 MB tree response). It does not instantiate
the memory reader or open a ledger/cache/index. Historical mode can resolve an
older authorized SHA while HEAD stays unchanged; it is labeled historical and
cannot satisfy a current-evidence requirement. Authorization is checked before
and after each bounded read. There is no timer or network lookup. Cost is bounded
to 20 citations, with two authorization checks and one bounded worker per item;
production latency remains an activation concern.

Per-item `{index,status,reason,mode,satisfiesCurrent}` entries are saved in
`heartbeatRuns.resultJson.sourceCitationResults`, with
`sourceCurrentEvidenceSatisfied`. Invalid input, unauthorized repository, wrong
task SHA, receipt mismatch, changed binding and sanitized authorization/reader
failure have reason codes. Every rejected citation fails closed in every phase.
Only review requires
current evidence by default when evidence preparation is enabled/bound. Planning
and implementation may omit citations or submit only verified historical ones;
these do not claim to satisfy current evidence. Both canonical PRP results and
provider-facing finish schemas declare optional typed `sourceCitations`.
Legacy settlement receives
`source_citation_rejected`. The native control-plane port checks **before**
accepted-result insertion/finalization, saves the adjudication on the run, and
refuses invalid completion. Provider terminal metadata is not rewritten.

The native pre-completion hook is runtime-only and optional. No persisted
session or checkpoint shape changes. The optional typed citation property is a
Runner result/finish contract addition; generated schemas, validators and manifest
are synchronized. Old results without citations still decode. Disabled source
memory leaves ordinary uncited execution inert. Recovery rejects citations when its saved snapshot cannot be verified and requires current evidence for configured review; old runs without a recorded snapshot
are refused by fresh citation consumption with `task_snapshot_unavailable`, never
rebound to a branch or baseRef. Ordinary new admissions bind a fresh server
snapshot. A previously accepted
native result is preserved; this patch does not reprocess or qualify old results.

Focused checks, using Node 24 without installs or database access:

```sh
node --experimental-vm-modules --test server/src/services/source-citation-consumer.test.mjs
node --experimental-test-module-mocks --test server/src/services/source-memory-current.test.mjs
```

The first fixture executes the real task-workspace access service, access facade,
authorization service, trust resolver and source-citation authorization wrapper
against an in-memory SQL/storage adapter and a synthetic Git repository. It does
not replace authorization with a callback. It covers fresh current, stale SHA,
altered hash/range, wrong frozen SHA/company, same-company unauthorized repo,
revocation before/during a read, and an accepted labeled historical lookup.
Privacy mode is explicitly off in this fixture; private-task/low-trust policy
matrices are not claimed. Unused notifications/tracing throw if called. The
native ordering fixture uses the real completion port but substitutes unrelated
schema/redaction helpers; it proves rejection precedes its database transaction,
not PRP-schema or full native-provider acceptance.

The second fixture checks prepared evidence, structured consumption and
historical-only rejection in planning, implementation and review, plus disabled
and previous recovery behavior. It mocks source preparation, independently of
the real authorization/Git fixture. These historical local fixtures establish
only their stated scope; syntax checks are not semantic typechecking. The later
E3 operator receipt on `64e4fa75` records the 2,035-file production semantic pass
and separate emit/assets/bundle checks; it does not retroactively broaden these
local fixtures or claim a test-layer semantic pass.
Assembled server, remote provider confinement, live journeys, scale checks and
activation remain outside this candidate. No production/previous ledger/cache,
indexing, DB connection, installation, activation, merge or deployment occurred.

## A4b current-range scope and focused regression

Current citations must match an exact prepared citation range and full-file
SHA-256, not merely any valid range at the run commit. The reader verifies
submitted bytes independently. Historical mode may read another authorized
committed range, but never satisfies review current evidence. Broadening the
current-range set requires a separate design decision.

`heartbeat/source-memory-admission.test.mjs` compiles the unchanged production
TypeScript modules into a temporary ESM tree so subprocesses use build-style
imports. It runs the real manifest-pinned reader and Git HEAD preparation, with
new scratch-only state and synthetic storage behind the real authorization
services; it never mocks `prepareSourceMemory`. It covers branch-name baseRef,
a commit after base, review candidate ahead of base, mismatched review candidate,
missing old snapshot, frozen binding changes, all three phases with absent,
historical, current and rejected citations, and typed finish schema exposure.

```sh
SOURCE_MEMORY_READER_FIXTURE=/approved/tooling-9c477cebfff7 \
node --experimental-vm-modules --test server/src/services/heartbeat/source-memory-admission.test.mjs
```

CI semantic typecheck remains required before merge. Local syntax checks and
these focused fixtures do not establish assembled-server, remote-provider,
activation or release acceptance.

## A5 worker lifetime and provenance retention (source only)

The dedicated worker starts a fixed Node `--eval` bootstrap before importing
its service module or production bundle chunk. It validates the expected parent
PID supplied by `runWorker` against `process.ppid` and requires live IPC. It starts
a small Worker-thread watchdog with its own event loop, waits for its first
successful check/READY, then imports the server-owned module. Failure or a wrong
parent kills only the worker's own detached process group and refuses import.

The watchdog compares the current parent PID and a single monotonic
`process.hrtime.bigint()` absolute 180-second deadline every 200 ms for this active
worker lifetime. This bounded observation is needed while synchronous bundle or
SQLite work can block the main event loop. It is not an idle company scan. The
watchdog remains owned until process exit, independent of core guard release;
`unref()` lets normal exit stop it. Failed watchdog startup/exit is fail closed.
The existing main-thread IPC/deadline guards remain supplemental, inheriting the
remaining deadline during handover. The controller still owns cancellation,
output limits and its original 180-second process-group deadline.

Child argv (six arguments): `--input-type=module --eval <fixed bootstrap>
<server-owned module> --source-memory-worker <trusted parent PID>`. Only the module
at index 3 is mapped by the operator's bundle fixture. PID is supplied from the
spawning server process, never a task/config field or a kill target. The module
is still `fileURLToPath(import.meta.url)`. POSIX spawn remains detached; local Git
children inherit that group. No source/reader/state access precedes watchdog
readiness. No persisted run/session/state shape or source authorization changes.
Previous direct worker entries retain the core guard; their historical proof
cannot establish the new synchronous-work lifetime guarantee.

POSIX group kill covers the worker and local descendants even during synchronous
work. Windows kills this worker process only; descendant tree termination is an
explicit gap (no Job Object is added). OS-stopped/uninterruptible processes or
starvation of every thread are outside this guarantee. Remote reads retain their
own runner lifecycle; this does not cancel an already-dispatched remote command.
Normal completion retires only supplemental core guards; the independent
watchdog is never retired by `release()`.

### Retention proposal only (supersedes accepted A5 pruning)

Legacy and new facts/observations are retained. A6 performs no retention DDL,
backfill, deletion, truncation or overwrite of existing provenance. Compatibility
initialization/cleanup functions are inert; inserts name the original columns and
ignore duplicate provenance keys. Existing A5 timestamp columns may remain with
their defaults. The external pinned reader has no code reading these runtime
`facts`/`observations` tables (audited all `.mjs` sources, not data stores).

Proposal for a separate approval: add nullable verified timestamps, retain
unknown-age legacy rows, measure downstream use in an isolated copy, then agree
an explicit archive/export policy before any deletion. The former 30-day and
10,000/2,000 row figures are proposed bounds only, never active policy.

Focused synthetic verification (no accepted reader bundle needed):

```sh
node --test server/src/services/source-memory-lifetime-retention.test.mjs
```

The fixture exercises parent exit with a busy guarded worker and no stdin EOF
exit path,
a short worker-owned deadline with a real local subprocess, and isolated
in-memory ledgers for expiry, count ties, unknown-age rows, rollback, idempotence
and company/repository separation. It does not exercise full reader integration,
Windows process cleanup, production-size ledgers or synchronous blocking delays.

## A6 integration and rollout (source only)

The base is PR13 `93c63ede68f18d735cda1e9616874ec8c193a5d6`. The three source-memory
foundation commits are ported separately, preserving PR13 session continuity.
A2, A4+A4b and A5 are then applied with their exact accepted patch hashes.
The only textual conflict joins both appended runtime-document sections.

Review handoff captures clean writer HEAD on the server in the normal native
stage transaction. Optional `reviewRequest.candidateSha` only constrains that capture. The shared API validator requires 40 lowercase hex
characters when supplied. Heartbeat produces `reviewCandidateSha` only from the
server-owned pending review stage assigned to that reviewer; caller context and
baseRef never supply it. A configured, bound review missing this field refuses
admission with `source_memory_review_candidate_missing`. Retry creation removes
the prior `sourceSnapshot` without changing the predecessor; the new run records
its own actual HEAD through the existing conditional write.

With configuration unset, volunteered citations and claimed evidence standing are
stripped without failing completion. Configured but unbound citations are rejected. Recovery does not index a new HEAD
as though it were the completed run's saved source: submitted citations fail
closed with `recovery_snapshot_unverified` until saved authority can be verified.
Configured recovery reviews without current evidence also fail closed. There is
no warning-only acceptance. Previously accepted completion records are retained.

The SQLite busy timeout is 120,000 ms per lock acquisition. It is inside the
180,000 ms worker deadline, not an additional grant beyond it. SQLite is
synchronous in the worker: the parent deadline can kill its process group while
the worker's own timer cannot interrupt a blocked synchronous call. Opening/schema
work can acquire locks separately; do not sum individual waits as an extension.

Mixed-version rollout remains unapproved. Keep activation disabled, quiesce old
workers and wait for their transactions to settle before any approved cutover.
Old result records decode, but an old saved run without an authenticated snapshot
cannot gain new current-evidence standing. Preserve its session/workspace and
surface the named failure. Pre-A6 A5 pruning workers must never overlap a retained
ledger; a binary rollback to those workers is unsafe. The pinned reader manifest
remains authoritative; the A1 replacement is proposed only.

`node scripts/source-memory/run-tests.mjs` requires all nine `.mjs` contracts in CI.
`SOURCE_MEMORY_READER_FIXTURE` must name the manifest-verified reader; absence
fails before any suite runs instead of silently excluding the four reader suites.
Local focused checks may append roster names, for example `source-memory-binding`;
CI rejects subset arguments. The pinned-reader synthetic journey, blob-integrity
and C2 tests use new scratch state only. This emits JS by stripping types for worker
execution and explicitly does not replace semantic TypeScript compilation.


## A6b binding pre-filter checkpoint (source only)

Heartbeat first checks that a persisted workspace exists and that its non-null
repository URL matches the operator's company/project/repository opt-in. This
filter grants no authority and reads no repository or ledger. Unbound scopes
return before task authorization; bound scopes retain the full authorization,
root, reader, revision and execution-owner checks. Claimed citations in unbound
scopes remain rejected, while ordinary uncited work is unaffected. Bound recovery
reviews still fail closed; the proposed operator procedure is in
[source-memory-review-recovery-proposal.md](source-memory-review-recovery-proposal.md).

## A6b server-owned native handoff capture (source only)

The CTO-approved generic issue transaction hook captures the candidate after final
writes and before native completion effects can release the current writer. Native
arbitration exposes a configured opted-in source review and uses the normal policy
transition to select its participant. The source-inspection owner admits only the
task's bound isolated local Git worktree, current task/run identity, exact writer
runtime lease and native finalizer lease (or live legacy controller deadline).
The existing runtime-lease owner supplies the locked proof; capture neither claims
nor extends it. Remote/plugin, nonrepository, detached/dirty or unverifiable source
fails with a typed terminal hold and no automatic retry.

Capture uses the pinned Git execution/storage guards and repeated source identity,
reads no ledger/cache, and persists its full SHA in the stage's existing state in
the same transaction as the stage change. The receipt binds company, task, project,
repository, workspace binding revision, writer run, stage and participant. An
explicit request SHA is only a matching constraint; omission captures automatically.
No client/UI/skill/MCP changes are needed. Only the parsed explicit constraint is
carried through the route; there is no route-level Git read or authority shortcut.
The prep snapshot, provider prose and reviewer-time HEAD are never substitutes.
An existing stage reassertion preserves its frozen target; an advanced worktree
fails normal review admission against that target. Audit capture is deduplicated
by task/stage/SHA under the task row lock. New reviewer notifications use the
captured configured participant.

Shared state has an optional server-owned receipt and needs no migration. Old
state still decodes and is preserved, but missing capture cannot acquire current
source standing. A typed completion-guard rejection becomes a terminal native
failure; concurrent/replayed rejected completions coalesce their bounded reads.
Accepted prior reviews are retained. Recovery remains fail closed and its operator
procedure is a proposal, not a bypass.

Final source semantic checking, actual built-worker re-entry and no-provider
native qualification are the already-arranged operator gates described in
[source-memory-a6b-isolated-validation.md](source-memory-a6b-isolated-validation.md).
The local Node emitted-worker tests do not replace those gates or final entire-diff
independent Claude ACP review. Activation remains disabled.


## A6c pre-activation requirements

The server must run below an init (the shipped image uses tini), or another
non-PID-1 parent. Node as PID 1 refuses source-memory work with
`source_memory_parent_pid1_unsupported` before import or source access. The
bootstrap also reports that code if supplied trusted parent PID 1. It does not
weaken disconnect or watchdog checks to support a no-init deployment.

Review-to-review advancement retains the original writerRunId, candidate SHA and
capture event identity, rebinding only stage and participant. It never reads HEAD
under a reviewer's lease. A missing/mismatched frozen receipt refuses with
`frozen_review_receipt_mismatch`. Board/user entry without a writer run retains
`writer_missing`; an operator must use the existing authorized writer handoff.

Configuration must be readable JSON with a bindings array so scope can be
identified. After that envelope is read, only matching company/project bindings
and their shared paths are validated. Invalid paths or bindings in another scope
do not fail unrelated work. An unreadable or syntactically invalid envelope
cannot safely identify scope and still refuses; no cached authority is inferred.
Unsupported/non-HTTPS workspace URLs are treated as unbound, never read. A realized
workspace URL mismatch remains an unbound policy path, not source authorization.

### CI fixture lane

The normal policy lane and default Vitest shards require no source-memory fixture.
The separate `source_memory` job is explicitly gated by repository variable
`SOURCE_MEMORY_TESTS_ENABLED=true`. An operator must provision a code-only pinned
reader (`SOURCE_MEMORY_READER_FIXTURE`) and the qualified emitted service for the
exact checked-out source (`SOURCE_MEMORY_BUILT_SERVICE`) on that runner before
enabling it. Missing files fail loudly. This source patch provisions neither,
activates no repository variable and claims no hosted Actions execution.
The lane runs all nine Node suites and the review-stage and transaction suites.
Only that lane sets `PAPERCLIP_SOURCE_MEMORY_TESTS=1` to include the transaction
suite; later normal policy checks are independent of its fixture result.

The dependency-free authorization fixture executes real authorization and access
modules with synthetic rows and SQL predicate approximations. It does not prove
PostgreSQL joins, SQL NULL semantics, transaction locks, protocol schema validation,
or concurrency. Its completion normalizer/schema stubs are fixture boundaries;
full transaction evidence remains the separate qualified integration suite.
The reviewer-time two-stage unit fixture similarly tests actual handoff logic
with parsed synthetic policy states, not the database transition engine.

Previous-release rollback restrictions are recorded in
`rules/upgrade-safe-run-state.mdc`. Actual-bundle parent-kill qualification at the
final candidate remains an operator activation gate; no earlier bundle receipt
is promoted to this candidate. Recovery policy remains a separate CTO decision.


### E2 review liveness and enablement preparation

A same-stage participant replacement carries the persisted receipt to the new
eligible participant; it never captures that participant's checkout HEAD. Review
advancement selects the next policy stage not already in completedStageIds, so
completed intervening stages do not force an index-plus-one refusal. Existing
company/task/workspace/binding/repository and candidate constraints still apply.

Before any separately approved enablement, identify reviews already pending
without a server capture. Do not synthesize a receipt from their reviewer's HEAD,
clear state or replay completion. Through the existing authorized changes-request
transition, return such work to its writer for a fresh leased handoff and capture.
Reviews whose saved capture no longer matches scope also remain held for that
same governed writer path. Enablement and recovery are not authorized here.
JSON null, arrays and primitive configuration envelopes refuse with
`source_memory_configuration_invalid` before any reader or authorization work.


## F2 activation recovery runbook (documentation; enablement remains gated)

Before any enablement, complete the F2 independent review and CTO acceptance,
apply the reviewed operator tooling patch before reusing that controller for
post-deploy or A3 evidence, and verify the reserved native result fields cannot
be provider-supplied. Source acceptance is not permission to enable indexing.
Capture can hold issue/workspace/run row locks for up to the worker's 180-second
bound while reading clean final HEAD; allow that bounded settlement during
quiescence and never clear locks, stages or sessions to accelerate cutover.

- **Disable:** unset `PAPERCLIP_SOURCE_MEMORY_CONFIG` in the approved deployment
  configuration and restart. This returns new work to default-off; it does not
  remove saved captures, accepted results or retained provenance. Do not rewrite
  those records as part of disablement.
- **Runaway worker/cancel:** the bounded-lifetime watchdog/reaper owns termination
  of its worker group. The accepted E3 A3 proof records actual SIGKILL 9 and zero
  running group members. An authorized operator checks the recorded group and
  start identity, confirms no running group members and no worker execution after
  cancel, and retains the terminal reaper/cleanup receipt. Do not signal a reused
  PID or extend/restart a failed qualification without a new bounded decision.
- **Retention:** the named compatibility entry points are
  `initializeSourceMemoryRetention` and `cleanupSourceMemoryRetention` in
  `server/src/services/source-memory.ts`. On accepted `64e4fa75`, both are inert:
  legacy/new `facts` and `observations` are retained, without expiry or pruning.
  `SOURCE_MEMORY_RETENTION` (30 days / 10,000 facts / 2,000 observations) is a
  proposal only. Verify against the accepted source and the focused synthetic
  `legacy provenance is retained without migration or pruning` receipt; do not
  claim an expiry run or perform ad-hoc production deletes. The F2 CTO brief
  calls expiry cleanup accepted, which conflicts with this actual source and
  the earlier retained-provenance contract. That discrepancy is recorded for
  lead/CTO disposition before enablement; this documentation enables no cleanup.
- **Full binary rollback target:** the CTO specifies release `987e3e0e`, image
  `67dfdeeb`. Keep config unset, quiesce/drain writers and preserve evidence before
  any authorized rollback. No migration is introduced by F2. This target is safe
  only while its strict parser can decode all persisted review state: disabling
  configuration alone cannot erase new `candidateSha`/`sourceReviewCapture` fields.
  If those fields have been saved, follow `rules/upgrade-safe-run-state.mdc`:
  keep work quiesced, preserve state, and use a compatible binary or a separate
  explicit CTO data-recovery disposition. Do not strip fields, restore a backup,
  clear stages/sessions or replay completion as an automatic rollback workaround.

Reviews already pending without a capture follow the E2 runbook above: an
existing authorized changes-request returns work to its writer for a fresh
leased handoff. A reviewer never manufactures capture authority from its HEAD.

F2 strips the two reserved standing fields before native validation guards and
again before canonical hashing/persistence. Server-computed evidence remains on
its existing company/run-scoped path. Existing accepted records are preserved;
no stored result or fingerprint is migrated. A replay against a pre-F2 accepted
result containing those extra fields can encounter the existing named
`structured_result_replay_conflict`; it must preserve that record/session and
must not trigger a provider rerun or erase the accepted receipt.
