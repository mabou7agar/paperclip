# Native Ubuntu runner result bridge

Paperclip remains the task/session/review authority. This optional integration
owns only registered external execution and delivery of measured results. It
builds no images and adds no second task scheduler or provider loop.

See [the operator and protocol reference](../../../docs/ubuntu-runner-results.mdx).

The current `reviewed_controller` adapter supports the explicit
`reviewed-controller.v2` packet convention: typed native independent review,
actual Claude ACP attestation, lead scope and worker acknowledgement, frozen
source decisions, one immutable attempt, root-retained closed diagnostics and
manifest-approved synthetic PNG/WebM/JSON evidence. That convention is not a
universal Paperclip requirement. Other execution protocols should use another
admission/packet adapter; never loosen its checks for an incompatible project.

`control_checks` executes a registered changed-input pure recipe in a disposable,
non-root, networkless container using an existing image. It has no workspace,
secret, database or Docker socket mounts. Passed matching recipe/input/image
checks are reused. These controls do not count as application acceptance.

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
