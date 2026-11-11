# A6b source implementation and final operator qualification

Source-only, activation held. Accepted base:
`41ecd2aabd5faec5ec11b21f52dd04710fe16f58`; review anchor:
`93c63ede68f18d735cda1e9616874ec8c193a5d6`. The frozen implementation SHA and
byte manifests are attached to the task, avoiding a self-referential source hash.

## Authority and implementation

The saved CTO capture decision and `actual-unblock-inputs-20261111` supersede the
first checkpoint's design/tooling hold. Five source turns remained on admission;
the implementation now includes the third bounded source turn, with one later
turn reserved for HANDOFF. No task, stage, session, budget or approval is reset.

- The generic issue-update hook owns capture and audit persistence with the stage
  transaction. Native governance exposes an opted-in configured gate; the native
  committer enters it through that hook before materializing effects which may
  release checkout. The existing policy transition selects the participant. The
  ordinary completion's notification targets that captured participant.
- The source-inspection owner reads only the currently bound isolated local Git
  worktree. It verifies current task/run identity, the native finalizer lease (or
  running legacy controller deadline), and the existing runtime-lease owner's
  exact task/run/agent proof. Rows remain locked through commit. The read uses
  the pinned source-memory Git guards, clean final writes, a named branch and
  repeated source identity. Capture opens no ledger or blob cache.
- The stage stores the server-owned full SHA and a task/project/repository,
  workspace binding revision, writer run, stage and participant receipt. The
  optional explicit SHA only narrows capture. Inherited prior request fields do
  not become explicit constraints on a new native handoff. Reasserting an existing
  stage preserves its captured candidate even if the worktree later advances.
- One audit event is deduplicated under the issue lock by `(issue, stage, sha)`.
  Incoming receipt fields never authorize dedup; only the persisted receipt does.
  Reader admission checks the captured repository scope and full candidate before
  preparation. The reviewer consumer checks task, workspace revision, stage and
  participant. No schema migration or client/UI/skill/MCP field is added.
- Unsupported local-source/lease/access cases throw a typed
  `review_candidate_capture_unavailable` hold. Native finalization records it as
  terminal with no next attempt. Trusted source-completion rejection is a typed
  terminal native failure; concurrent/replayed rejected completions coalesce
  their bounded reads before any accepted-result transaction.

Previous-release story: records without the optional capture receipt still decode
and are retained. They cannot acquire new current-evidence authority for a bound
review. Named missing-candidate/recovery failures preserve source/session/task
context; no saved session is cleared, migrated or silently rebound. Previously
accepted review records are not rewritten. Condition 3 remains a procedure
proposal only in `source-memory-review-recovery-proposal.md`.

## Evidence collected in this source worktree

Node 24.22.2; nonroot; only newly created disposable synthetic state:

| Check | Exit | Result |
| --- | --- | --- |
| Earlier `source-memory-binding` focused suite | 0 | 10 passed; retained, not repeated |
| Earlier `source-memory-current` focused suite | 0 | 6 passed; retained, not repeated |
| Earlier all-suite command without reader | 1 | Expected loud refusal; 0 suites executed |
| Changed `heartbeat/source-memory-admission` suite | 0 | 7 passed, 0 failed/skipped |
| New `captured review consumer` case only | 0 | 1 passed, 0 failed/skipped |
| Changed-source syntax and whitespace checks | 0 | Syntax/whitespace only; not semantics |

The admission attempt initially failed before cases executed because a new
parameter property was incompatible with Node strip-only mode; it was corrected
and the affected suite passed. Both logs are preserved. All 38 reader code hashes
and its manifest hash were verified before copying only those files to new scratch.
No existing knowledge state/SQLite was opened. The reader manifest remains
`0024f01f17032a78c99cd2b14c8c58ddf5501025c24e9528e9c448679514b71a`.

The seven-case suite emits JS by stripping types. It proves a real worker process
and new source admission/capture scenarios, not semantic correctness or production
bundle qualification. No old 54-case/PG/Unit/proof/smoke suite was repeated here.
The first checkpoint incorrectly looked for the checker at repository root;
the correct existing path is **server/scripts/typecheck-layers.mjs**, CWD `server`.

## Already-arranged final-source operator qualification

Use the final frozen source only, in the operator-owned no-network/no-mount,
nonroot scratch with approved cached image, reader and dependencies. No bootstrap,
Corepack, install, download or production environment is authorized. These entries
are prepared; results are not yet claimed.

1. From CWD `server`, run:
   `PAPERCLIP_TYPECHECK_LOW_MEMORY=1 node scripts/typecheck-layers.mjs --declarations-only`.
   Do not set emit-only/noCheck for this semantic proof. Then emit final native JS,
   runtime assets/stamp and the normal runtime bundle using the existing cached
   procedure. Record exact source/artifact inventories and hashes.
2. Set `SOURCE_MEMORY_BUILT_SERVICE` to the absolute emitted
   `server/dist/services/source-memory.js`, and `SOURCE_MEMORY_READER_FIXTURE` to
   the verified code-only fixture. From repository root, run only the new TS cases:
   `node node_modules/vitest/vitest.mjs run server/src/services/source-review-handoff.test.ts server/src/services/native-runtime/native-source-completion.test.ts server/src/services/native-runtime/native-source-completion.integration.test.ts --maxWorkers=1`.
   These create their own fresh Postgres/Git state. They never use an existing
   external database URL. The handoff fixture uses the actual emitted source
   worker and real task authorization; no authorization function is mocked.
3. The handoff cases cover default omission, explicit match/mismatch, stage and
   participant/task/workspace revision, rollback, unsupported source/lease holds,
   advanced-worktree replay, audit dedup, and a real accepted-result → native
   finalizer → configured-stage/participant notification path without any provider.
4. Condition 4 now also has `native-source-completion.integration.test.ts`:
   two focused scenarios drive the **real outer executor**, completion port,
   citation consumer, coordinator transaction, Stop API and real finalizer entry.
   Only the in-process controller is replaced; real backend construction and
   backend methods throw. Assertions cover concurrent/exact/reordered refusals
   (one guard, nineteen reads), terminal/no-next-attempt persistence, zero accepted
   results/status decisions/wakes/successors, coordinator lease/deadline release,
   active-run/session removal, and Stop's durable acknowledgement. Repeated real
   finalizer calls must refuse a missing result. The controller's synthetic
   resource closes in its own `finally`; this proves controller-resource cleanup
   and server ownership cleanup, not an OS subprocess, sandbox/environment lease
   teardown, remote confinement or paid-driver shutdown. No such resources are
   acquired. A board-owned diagnostic hold may persist on rejection, with null
   wake/monitor policies, zero attempts and no recovery task; automatic recovery
   work remains zero. The narrower three-case unit fixture remains distinct.
   These new TS integration cases are **prepared, not run locally**; the arranged
   operator must execute them before any condition-4 pass/readiness claim.
5. For condition 5, run once:
   `node scripts/source-memory/qualify-built-worker.mjs` with those two variables.
   It imports the actual emitted service in a clean child with empty
   `NODE_OPTIONS`/`NODE_PATH`, checks phase and duplicate receipts/zero duplicate
   blob reads, then kills a disposable parent and asserts its real worker stops
   after IPC disconnect. It records the artifact hash and process cleanup. All
   repositories, config and ledgers are new; the fixture removes its own state.
6. The separate required CI-roster proof is:
   `CI=1 node scripts/source-memory/run-tests.mjs` with the verified reader.
   It must run all nine suites or fail; no subset/filter is permitted in CI.
   This required roster proof is distinct from replaying old checks for status.
   No hosted Actions run is claimed while push is held.

Each remaining qualification is once-only on the final inputs. Preserve exit code,
totals, failures, run/environment IDs, cleanup and full logs. A missing/ambiguous
receipt gets one lead hold, no resubmission or monitoring loop. Do not check the
intermediate checkpoint or repeat passing cases without a changed input/gap.

## Mandatory entire-final independent review

After operator qualification, use the existing native Tech Lead → CTO stages,
with final SHA in `reviewRequest.instructions` only. The old live API must not
receive `candidateSha`. Do not create duplicate review tasks or stages.

The final Claude ACP review must inventory every authored cumulative file against
the review anchor: production, every test/fixture, configuration, Bruno, MDX and
all docs, particularly `source-memory-runtime.md`. The prior assembly document
`isolated-validation-602d-final-20261111`, revision
`05efefcb-1fbc-4ed5-8e99-9072eb920dc4`, contains the **entire external API harness
and isolation proof** and must also be read. Its body SHA-256 is
`570d3d9fb562fb67c989e628065bfced545c110f15ba10e469bad99b4e580947`.
Prior receipts are historical, not full qualification of this changed source.
Mechanical generated-validator reproducibility can replace manual reading of
its generated bytes, with explicit coverage recorded.

All configuration enablement, real indexing, activation, merge/push/install/deploy,
production/legacy data, root, DBA and source-anchor holds remain in force. There
were no new questions for the supplied technical inputs, paid test providers,
session resets, arbitrary Git reads or changes outside this task's worktree.

## Third-turn operator findings and corrected inputs

The operator's first source-semantic check on `05e683bd` exited **2** after
2,035 production files (1,107 below / 664 cycle / 264 above). Three unique errors:
missing `IssueSourceReviewCapture` type-barrel export and two out-of-scope
`reviewAgentId` references in continuation/retry effects. The correction exports
that existing type and restores `effect.agentId` for those two ordinary effects;
the scoped captured-review override remains exclusive to `notify_owner`.
No schema, dependency, provider, capture contract or approval gate changes.

The prior Runner inputs were byte-identical to qualified inputs; the operator's
mechanical emit exited **0**, which is preparation only. New semantic, TS test,
full native fixture, built worker and CI-nine qualification have no pass yet.
The full operator log remains in task document
`operator-05e-semantic-findings-and-native-gate-20261111`; its failure is retained.
Do not repeat earlier 16, reader 7, captured-consumer 1 or historical proof suites.
The next operator event uses only the corrected source delta and the new fixture
inside the already-owned isolated scratch. No install/bootstrap or new question.

## Fourth-turn runtime findings and bounded corrections

The operator qualified `331385e9` with source semantics **exit 0 / 2,035 production
files**, mechanical emit/assets/stamp/bundle exit 0. Actual environment was the
same uninterrupted compiler process increased to **6 GiB / 2 CPU**, nonroot,
network none, mounts zero, capability drop all/no-new-privileges. Do not report
a 4-GiB-only pass. Runner source remained unchanged; its prior semantic receipt
was retained. Native focused execution had **18 pass / 3 fail of 21**; nine-suite
CI had **59 pass / 2 fail / 61 counters / zero skipped**, with one unique failed
child plus its failed parent aggregate. Actual bundle cancellation failed its
five-second bound; no full packaging pass exists. All failures and the original
external wrapper remain in the task documents and packet.

Corrections are scoped to those findings:

- Handoff fixture passes only the real structured binding DTO (company, issue,
  run, agent, session, contract and source/controller identities), excluding its
  synthetic Git helper function. Real capture/authorization/finalizer are retained.
- The native failed-execution hold starts at one in `issue-recovery-actions.ts`.
  The fixture now asserts that original accounting value **and its equality
  before/after rejected finalizer replays**; no count is reset. No wake/monitor,
  recovery task, accepted result or successor is permitted.
- The prior Stop fixture called native controller cancellation without the user
  attribution that `hasAcknowledgedNativeStopIntent` requires. It now supplies
  synthetic trusted caller attribution before the actual cancellation API creates
  the durable intent/ACK. The expected cancellation exception and all terminal,
  no-retry, normal heartbeat Stop projection and ownership/resource assertions
  remain. No production cancellation bypass or exception-text-only fix is added.
- The .mjs loader accidentally joined three module paths into one path. It now
  loads the actual completion-port class, whose dependency graph already includes
  the real canonical and validation modules. The affected consumer suite locally
  passed **exit 0 / 13 tests / zero skipped**. This checks the repaired shared
  synthetic loader; no guard is mocked away.
- The bundle core registered disconnect handling only after its shared imports
  initialized. A fixed lightweight bootstrap now owns disconnect and the original
  absolute deadline **before dynamic import**, with gap-free handover to the
  existing core guard. No reader/state/Git access precedes lifetime ownership;
  subprocess groups, input/output/read budgets, clean env and protocol stay.
  New bootstrap-during-initialization regression passed locally **exit 0 / 1**
  using fresh strip-emitted code. A direct TS invocation first failed to resolve
  the existing `.js` sibling before executing a case; that attempt is retained.

Local Node syntax/whitespace is separate from production semantic qualification.
The production worker input changed, so `331` semantics and packaging are
historical and require corrected-input qualification. Do not rerun unchanged
native cases: filter `ordinary native done|terminalizes` (three cases). The core
and loader change affects the CI roster, so the arranged operator must qualify
all nine suites once on final inputs, with no silent skips. No old Unit/proof/
smoke/54-case baseline is repeated.

For the actual bundle gate use source-controlled
`scripts/source-memory/qualify-bundled-worker.mjs` (the successor to the retained
external wrapper) with its four existing arguments: absolute final qualifier,
absolute unique `.mjs` worker chunk, qualifier SHA-256, chunk SHA-256. Set the
existing emitted-service and code-only-reader variables. It checks the **five
worker arguments** and maps **only index 3**, the module filename, to the actual
chunk. The `--eval` bootstrap string, final worker flag, IPC/options/env and all
deadlines remain exact production inputs. The old first-argument mapping is
incompatible and must not be used. Save exact derived driver through
`SOURCE_MEMORY_BUNDLED_DRIVER_EVIDENCE`; set `SOURCE_MEMORY_WORKER_CASE_EVIDENCE`
to a new owned absolute JSONL path for phase/duplicate receipt and cancellation
PIDs/timestamps/status even if a later assertion fails. No standalone emitted
packaging replay is required in addition to the actual bundle gate.

Final whole Claude ACP must cover this wrapper **and** the entire retained old
external wrapper/derived-driver evidence and API harness, all cumulative authored
files and actual qualification receipts. Fourth source turn uses the same session
and branch; **4/6 used, 2 remain including reserved HANDOFF**. All holds remain.
