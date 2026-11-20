# Native Ubuntu runner result bridge

Paperclip remains the task/session/review authority. This optional integration
owns only registered external execution and delivery of measured results. It
builds no images and adds no second task scheduler or provider loop.

See [the operator and protocol reference](../../../docs/ubuntu-runner-results.mdx).

The current `reviewed_controller` adapter supports the explicit
`reviewed-controller.v2` packet convention: typed native independent review,
actual Claude ACP attestation, lead scope and worker acknowledgement, frozen
source decisions, one immutable attempt, an operator-pinned root-code template with explicit independent Security/CTO acceptance, root-retained closed diagnostics and
manifest-approved synthetic PNG/WebM/JSON evidence. That convention is not a
universal Paperclip requirement. Other execution protocols should use another
admission/packet adapter; never loosen its checks for an incompatible project.

`control_checks` executes a registered changed-input pure recipe in a disposable,
non-root, networkless container using an existing image. It has no workspace,
secret, database or Docker socket mounts. Passed matching recipe/input/image
checks are reused only inside the same company, profile and operator policy.
These controls do not count as application acceptance.

For a new control-only profile with `allowReviewedController: false`, set its
optional `controlPacket` to the approved `attachmentId`, `packetSha256`, and
`recipe` entrypoint. The broker checks all three before recording a job and
again before staging or launching it, including launch reconciliation.
Use a new reviewed profile for a different packet. Existing profiles without
this field retain their admission contract.

Validation from the repository root:

```sh
python3 -B -m unittest discover -s integrations/ubuntu-runner/result-bridge/tests -p 'test*.py' -v
node --test integrations/ubuntu-runner/result-bridge/tests/plugin.test.mjs
pnpm --filter @paperclipai/server exec vitest run src/__tests__/plugin-wakeup-receipts.test.ts
node integrations/ubuntu-runner/result-bridge/build.mjs /private/operator/release
```

The native tests use disposable PostgreSQL and mocked provider dispatch, never
live agents. The e2e journey uses a temporary Unix socket, HTTP and durable
SQLite state; no application/proof tests or paid provider calls.

The host must implement `issues.wakeup.durable`; older stock hosts reject this
plugin capability. Existing plugins' keyed wakes retain their prior semantics.
Only this explicit opt-in reserves durable same-task receipts.
When a signed result hands off to native runner recovery, the broker accepts
the exact result receipt from the native policy ledger. A lost webhook reply
can then reconcile without sending the handled callback again. Settle pending
deliveries before rotating the signing key. A receipt signed with the prior
key needs reconciliation against those original signed bytes.

Current integration validation covers the real JobService, Unix authentication,
HTTP completion, task-document persistence, native receipt admission, lost ACK
and process restart. Local remote-worker tests use a current-user filesystem and
external daemon doubles. These do not establish real Linux systemd/Docker,
root-ownership, prepared-image or production acceptance; qualify those before
activating a registered controller. Runtime execution additionally requires an
accepted exact operator template and fresh independent packet/lead/worker gates.
