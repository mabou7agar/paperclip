# A6b isolated validation checkpoint

This is a partial source checkpoint, not a completed candidate or activation
qualification. Accepted base: `41ecd2aabd5faec5ec11b21f52dd04710fe16f58`.
Review anchor: `93c63ede68f18d735cda1e9616874ec8c193a5d6`.

## Recorded focused checks

Node 24.22.2, UID 1000, disposable synthetic state only:

| Command | Exit | Result |
| --- | --- | --- |
| `node scripts/source-memory/run-tests.mjs source-memory-binding` | 0 | 10 tests passed, 0 failed/skipped |
| `node scripts/source-memory/run-tests.mjs source-memory-current` | 0 | 6 tests passed, 0 failed/skipped |
| `node scripts/source-memory/run-tests.mjs` without reader variable | 1 | Expected loud refusal, 0 suites executed |
| `node --check scripts/source-memory/run-tests.mjs` | 0 | Syntax only |
| `git diff --check` | 0 | Whitespace only |

The binding regression executes real authorization services over synthetic
storage, including a bound scope reaching authorization and a revoked agent
being refused before reader access. Full bound-reader success remains in
`heartbeat/source-memory-admission.test.mjs` and has not run in this checkpoint.
The existing mocked current-evidence tests remain distinct from that proof.
The runner emits stripped JS for tests; this is not a semantic build.

## Missing validation inputs; one operator request

This checkout has no `node_modules`, `server/node_modules`, or `server/dist`.
`SOURCE_MEMORY_READER_FIXTURE` was not supplied. The task-named command
`node scripts/typecheck-layers.mjs --declarations-only` cannot run because that
script is absent at this accepted base. Do not install, bootstrap Corepack,
download, traverse private caches, or run a substitute monolithic compiler.
A lead/operator must provide approved cached dependencies, the verified reader
bundle and a matching declaration-checker/build procedure for this exact source.
No missing-fixture suite was reported as passing; no hosted Actions run occurred.

## Prepared finite isolated checks for conditions 4 and 5

These checks are not executed evidence and do not authorize paid/live dispatch.
Bind them to the final frozen SHA after the remaining producer implementation.
Run each changed scenario once, using fresh disposable Git and database state;
any missing/ambiguous result causes one lead hold, never automatic resubmission.

- Condition 4: use the real native completion port, finalizer and status committer
  with a never-paid in-process driver/fake controller. Submit a structurally valid
  review result with absent current evidence, then a bad digest, and ensure each
  rejection yields the named terminal failure with no accepted result or successor
  review dispatch. Deliver the same completion identity twice and record bounded
  authorization/read counts and durable dedup effects. Include cancellation during
  the read and a terminal replay. The earlier port-only throw test does not prove
  finalizer terminal/retry behavior. Capture exit, assertions, accepted-result and
  finalization counts, controller calls and cleanup evidence. Do not rewrite real
  stage/session/assignment records to construct the test.
- Condition 5: build with approved cached tools, then import the actual emitted
  `source-memory.js` in a child with empty `NODE_OPTIONS`/`NODE_PATH`. Use the
  manifest-verified reader and a new synthetic repository/config/state namespace.
  Invoke one phase and its duplicate commit; require a full-SHA receipt, bounded
  citations, zero new blob reads on the duplicate and no provider calls. Stop the
  parent during a separate disposable worker operation and prove process-group
  termination/transaction release. Record build/artifact hashes and child paths;
  stripped-source test output is not the built artifact proof.

## Unresolved trusted producer boundary

`heartbeat.ts` records `sourceSnapshot` during preparation before provider
execution. It cannot identify the final implementation commit. Its pending-stage
consumer in `heartbeat/source-memory-run-state.ts` accepts a candidate but never
produces one. `workspace-source-inspection.ts` returns source verification status,
not a handoff-time commit. The local close-readiness inspection in
`execution-workspaces.ts` returns dirty/ref/ancestry metadata without a head SHA;
remote inspection returns persistence readiness rather than a revision. Plugin
inspection may return a head but is not a generic active native-writer capture.

What is missing is a generic, authorized handoff-boundary revision capture tied
to task/workspace selection and current native writer/lease, persisted atomically
with the review stage. Implementing an ad hoc route Git read, trusting the initial
run snapshot, or waiting until reviewer startup would violate the requested trust
boundary. The Platform Lead should resolve the internal CTO design gap once:
identify an existing eligible primitive or authorize its narrowly scoped owner
extension, preserving current source/access/lease checks and same-task budgets.
No automatic producer or omission/explicit/mismatch/stage-binding acceptance
proof is claimed here. No client or API workaround was added.

## Required final independent review

After implementation and isolated verification, the existing native Claude ACP
review must inventory the entire combined diff against the review anchor,
including production, all tests/fixtures, configuration, Bruno, MDX and all docs,
especially `source-memory-runtime.md`. It must also read the external API harness
and isolation proof from the prior assembly's final validation document. Preserve
prior receipts without treating them as full final coverage. Generated validator
reproducibility may replace a manual read of generated bytes. Then use the
existing Tech Lead → CTO stages, with full final SHA in review instructions;
never submit `candidateSha` to the old live API or create duplicate stages/tasks.

Production inputs outside this checkpoint delta are unchanged. No configuration
was enabled, real repository indexed, model dispatched by a test, data/ledger
opened, branch changed, push/merge/install/deployment performed, or old proof,
full Unit suite or installation smoke repeated.
