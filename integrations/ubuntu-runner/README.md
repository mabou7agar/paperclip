# Ubuntu preview integration

This optional Paperclip integration adds local project domains and TLS to an
already prepared Ubuntu execution container. Paperclip keeps task, session,
budget, review and handoff ownership. This module starts no agent or application,
creates no task, probes no model and retries no proof. It does not depend on the
Hermas application, its APIs, or its source repository. An existing container or
volume can retain a historical name; that is an operator deployment binding.

The integration has a request DTO, naming and lifecycle services, a root-owned
lease repository, an exact-name certificate issuer, a small sudo command boundary
and a loopback forward-auth guard. It extends a standard Traefik file-provider
gateway. It does not add an Internet listener or a control-plane REST API.
This adapter requires an existing **root-run** Traefik process and root-owned
file-provider directory in the same container PID/network namespaces. Set
`gateway_binary` to its root-owned executable. This adapter verifies the executable,
namespace, explicit `--providers.file.directory` and TLS entrypoint address flags,
and UID; spoofed program names are ignored. Installation checks these prerequisites. A proxy using
another UID needs a separate permission adapter; do not loosen private-key modes.

## Configuration and installation

Start with `example.json`. Register actual canonical Paperclip company and project
UUIDs under `projects`. Each project has `company_id`, a unique DNS `label`, and an
optional `concurrent` boolean. Register each non-root execution UID under
`principals` with its trusted `company_id` and allowed `workspace_roots`.
Unregistered callers and projects fail closed. Candidate input cannot change
registrations, ports, template, lifetime, proxy configuration or CA keys.

The default global template is `{project}-agent.test`. It must contain exactly
one `{project}` placeholder, and every project root must be a separate immediate
child of `.test`. Fixed prefixes and suffixes are supported. An `osarh-pro` label,
for example, produces `osarh-pro-agent.test` and declared aliases such as
`academy.osarh-pro-agent.test`. This is an example, not a project-specific rule.
Concurrent mode puts each lease under `r<lease-id>.<project>-agent.test`.
Root ownership persists after release, preventing origin reuse by a different
company/project/UID. New project labels can be configured without code changes.

Set `routes_root` to the existing Traefik file-provider directory, and
`tls_entrypoint` to its existing private HTTPS entrypoint. `guard_address` must be
an explicit loopback HTTP port. Choose a backend port range outside other managed
services. Use an existing root-private persistent volume for `state_root` so CA
and origin ownership survive container replacement. Keep that directory outside
candidate workspaces. Root configuration is mode0600; code must be root-owned and
not writable by agents. Keep the principal roots as narrow as the actual jobs need.
Pre-create `state_root` and `routes_root`. Set `state_mount` to the existing
persistent mount that contains `state_root`. Missing/unmounted paths fail closed;
the module never silently creates a replacement CA on an ephemeral filesystem.
`reserved_namespaces` lists existing `.test` roots owned by another integration.

Copy this integration to `/opt/paperclip-ubuntu-runner-integration` on the Ubuntu
host, and the root-owned rendered config to
`/etc/paperclip-ubuntu-runner/config.json`. Put only the existing container name in
the root-owned `/etc/default/paperclip-ubuntu-preview`:

```sh
PAPERCLIP_UBUNTU_CONTAINER=existing-ubuntu-runner
```

Install the included service file in `/etc/systemd/system/`, then enable and start
`paperclip-ubuntu-preview.service`. `supervise.sh` installs only this small module
in the existing container. It neither rebuilds an image nor restarts the container.
On a Docker start-ID change it revokes stale leases before reinstalling the command
and trust files. On an ordinary integration upgrade, drain its leases first.
Restarting the guard revokes the old lease authority; it never restarts the apps.
Acquisition/activation fails while the guard is stopped or starting. A crashed
guard's stale leases are revoked on its next start; no task is automatically retried.

Root installer grants only the fixed Python command to registered UIDs through
sudoers. Python ignores caller environment and user site packages. The command
accepts bounded JSON on stdin and only `acquire`, `activate`, `read`, or `release`.
The root server owns certificate material and route/host records.
The host service follows Docker daemon lifecycle and passively waits for this
container's start event during recreation. It starts no job while waiting.
Fresh install staging prevents retired modules from returning, and a positively
identified orphan guard is retired before ownership resumes. No agent gets
root shell, Docker socket, signing key, public ingress, or production credentials.

## Managed application lifecycle

From the registered non-root workspace, choose one fresh 32-hex lease ID and call:

```sh
printf '%s' '{"id":"0123456789abcdef0123456789abcdef","projectId":"00000000-0000-4000-8000-000000000001","workspace":"/workspace/project","aliases":["academy"]}' |
  paperclip-preview acquire
```

The response gives `port`, `private_hosts`, `expires_at`, `ca_bundle` and
`tls_spki`. Launch the development server as the same non-root user, in that
workspace, bound to `127.0.0.1:<port>`. Read its PID and `/proc/<pid>/stat` start
identity with `preview/processes.py:identity`, then submit:

```json
{"id":"0123456789abcdef0123456789abcdef","process":{"pid":1234,"start_identity":"5678"}}
```

Send that JSON to `paperclip-preview activate`. Activation checks the actual
listening child and its UID, start identity and workspace; a live shell alone
does not grant routing authority. Public URLs become usable only after activation.
All declared tenant/service aliases point to the same application; the app keeps
Host-based tenant routing. Start a separate managed lease for a separate service.
The original TTL is never extended by activation. A shorter configurable starting
deadline releases abandoned reservations. Stable project domains cannot have two
active leases. IDs that reach reservation cannot be replayed after release or setup failure.
Rejections before reservation consume no ID and start no work.

Send `{"id":"..."}` to `paperclip-preview read` or `paperclip-preview release`.
Release, expiry or listener loss revokes proxy access and removes only the lease's
certificate key, routes and DNS records. It never kills application processes or
cancels unrelated work. The ordinary task executor retains app process cleanup.
The local five-second collector only removes expired state. It emits no task wake.

## Trust and scope

The CA permits only `.test` DNS certificates and excludes IPv4 and IPv6 SANs.
Leaves contain exact requested names, with no wildcard or global TLS bypass.
Root key files remain0600, root state0700. Installation adds the public CA to the
Ubuntu trust store and publishes a system-anchor Node bundle through a login
profile. Existing CAs remain trusted. Existing processes keep their environment;
set `NODE_EXTRA_CA_CERTS` to the new `node-ca-bundle.crt` for those commands.
The returned `ca_bundle` can be passed to `curl --cacert`, PHP or Python clients.
Managed Chromium can use only the current leaf's `tls_spki` pin; do not use
`ignoreHTTPSErrors`, `--ignore-certificate-errors`, or `curl -k`.

Resolution and trust are local to this Ubuntu container. Host or laptop browsers
need an explicit secure tunnel, exact DNS mapping and public-CA import. This module
does not publish or expose a preview to the Internet. Other gateway leases, routes,
host records and trust anchors remain in place. It never reads provider history or
changes saved task sessions, routing defaults, connection affinity or review gates.
Loopback is shared by processes in a container: another principal can reach an
app's backend port directly. Use a separate execution container per company; the
registry rejects multiple companies' principals on one container. Preview routing
is not a substitute for the container/network isolation boundary.

The module changes only its own `/etc/hosts` marker lines, locks the existing inode,
writes once without truncating first, and verifies the result. Other operator
writers must coordinate with that inode lock and preserve foreign marker lines.
An uncoordinated Docker or external rewrite is an infrastructure conflict, not
permission to keep retrying a task. The command fails closed on a detected conflict.

## Verification

`python3 -B integrations/ubuntu-runner/tests/contracts.py` exercises new trust and
lifecycle boundaries in temporary state, with no application/provider operation.
The opt-in Linux smoke exercises real prepared Traefik, curl and Chromium using
temporary state and synthetic projects. It retains its evidence, uses one attempt,
and does not run any product test. Relocated code requires its own final whole-diff
Claude ACP review; the stopped Hermas PR is not approval of this integration.
`tests/root-boundary.py` validates the real installer, sudoers, guard stop/crash,
UID-drop listener check, IPv6 rejection and proxy permissions only in a disposable
network-none container from the prepared image. Its marker, mount allowlist, bounded cgroup and loopback-only network assertions
refuse a normal execution container. `tests/supervisor-boundary.py`
tests binding/recreation logic there with a fake Docker CLI. Neither test runs a
product test, changes the actual runner, or establishes live systemd acceptance.
