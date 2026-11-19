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

When registering a reviewed controller that uses retained data, record each
required archive-relative path and exact SHA-256 from its accepted source in
the operator-owned `requiredPacketInputs` profile map. Capture the list from the
reviewed input contract before the producer builds the archive. The archive's
own inventory only describes what it contains. The broker checks these pins
after validating that inventory and before staging or claiming an execution
attempt. Missing or changed input terminates the submission with a named
refusal. Correct the package and use a fresh review and scope. Keep the map
with the versioned profile. A path such as
`qualification-{key}/retained-evidence.json` uses the verified controller key so
the same pinned bytes apply across qualification revisions. Enroll or change a
profile when it has no unfinished jobs. Omit the map for controllers with no
retained inputs or existing profiles that have not been enrolled.
Use path components that start with an ASCII letter or digit and contain only
ASCII letters, digits, underscores, hyphens or dots after key substitution.

`control_checks` executes a registered changed-input pure recipe in a disposable,
non-root, networkless container using an existing image. It has no workspace,
secret, database or Docker socket mounts. Passed matching recipe/input/image
checks are reused only inside the same company, profile and operator policy. These controls do not count as application acceptance.

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

Current integration validation covers the real JobService, Unix authentication,
HTTP completion, task-document persistence, native receipt admission, lost ACK
and process restart. Local remote-worker tests use a current-user filesystem and
external daemon doubles. These do not establish real Linux systemd/Docker,
root-ownership, prepared-image or production acceptance; qualify those before
activating a registered controller. Runtime execution additionally requires an
accepted exact operator template and fresh independent packet/lead/worker gates.
