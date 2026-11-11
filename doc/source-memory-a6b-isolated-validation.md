# A6b source implementation and final operator qualification

Source-only, activation held. Accepted base:
`41ecd2aabd5faec5ec11b21f52dd04710fe16f58`; review anchor:
`93c63ede68f18d735cda1e9616874ec8c193a5d6`. The frozen implementation SHA and
byte manifests are attached to the task, avoiding a self-referential source hash.

## Authority and implementation

The saved CTO capture decision and `actual-unblock-inputs-20261111` supersede the
first checkpoint's design/tooling hold. Five source turns remained on admission;
this is the second implementation run overall, with one later turn reserved for
HANDOFF. No task, stage, session, budget or approval is reset.

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
   `node node_modules/vitest/vitest.mjs run server/src/services/source-review-handoff.test.ts server/src/services/native-runtime/native-source-completion.test.ts --maxWorkers=1`.
   These create their own fresh Postgres/Git state. They never use an existing
   external database URL. The handoff fixture uses the actual emitted source
   worker and real task authorization; no authorization function is mocked.
3. The handoff cases cover default omission, explicit match/mismatch, stage and
   participant/task/workspace revision, rollback, unsupported source/lease holds,
   advanced-worktree replay, audit dedup, and a real accepted-result → native
   finalizer → configured-stage/participant notification path without any provider.
4. Condition 4's never-paid controller fixture drives the real completion port,
   bounded citation consumer and executor failure classifier. It checks terminal
   no-retry disposition, concurrent/rejected replay read counts, no accepted-result
   transaction, and Stop. Distinguish this scope from a full native executor
   dispatch/cleanup trace; the arranged operator qualification must supply that
   terminal/resource-cleanup proof before readiness. No paid provider is allowed.
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
