# F2 operator tooling handoff (apply only after independent review)

This folder contains workspace copies and an exact offline patch for external
operator code. Nothing under /app, a release checkout or the operator's checkout
was edited. No Docker job, build, suite, deployment or activation is authorized
by these files. Accepted source 64e4fa75 and its receipts stay unchanged.

## Exact inputs and outputs

`inputs.json` names the two saved task-document sources, exact baseline hashes,
patched hashes and patch hash. `operator-tooling.patch` SHA-256 is
`f3aaaa4e74e3b19d02098c2d7d15964a94ad6008a692d1bb8ba817a86aa4339d`. Baselines must match before an operator applies it; stop
on mismatch rather than resolving it in place. Preserve all earlier code/receipts.

- Controller output SHA-256: `1f35caf2a1361e59b575c277bc5774e66cebd4b07a713807ce1a93d884299d3e`.
- Lifecycle helper output SHA-256: `e14a20396101b40bb53f5dc20bb4d57c732916594a07f50991b12b467f87ccd5`.

The operator first verifies the reviewed artifact hashes and baseline files in
its separately authorized checkout, checks the patch without mutation, then
applies that exact reviewed patch. It must verify both output hashes afterwards.
No automatic retry, job submission or deployment is included. Source/tooling
independent review and CTO acceptance precede reuse for post-deploy conditions
2/4/5, A3 or re-qualification.

The controller now requires `PAPERCLIP_OPERATOR_CONTROLLER_SHA256` set to the
literal reviewed controller output hash above before starting any phase. Never
compute that expected value from the file about to run: use the independent
handoff hash. It refuses before reading inputs or running Docker if binding is
missing/mismatched. Apply without changing the script's approved sibling layout;
its existing relative state directory and candidate/reader bindings are retained.
Running Python with optimization is unsupported: existing controller checks use
assertions, and the operator must retain normal Python assertion semantics.

## Protections and proof limits

All host file reads in the controller use directory-descriptor walks with
O_NOFOLLOW, regular-file checks and nonblocking opens. Copied artifact/helper/
reaper trees reject links and special entries before publication. Container
checks include exact no-new-privileges, no added capabilities/devices/device
requests/cgroup device rules, PidsLimit 256 and existing UID/network/mount/resource
constraints. No check relaxes isolation, ownership or lifetime boundaries.

The observer resolves commands against the child's actual cwd, refuses relative
probe paths and non-absolute PATH entries, pins the parent/worker clean env
catalogues (so LD_PRELOAD/LD_LIBRARY_PATH additions cannot qualify), and retains
only the exact canonical getconf GNU_LIBC_VERSION allowance. Native descendant,
DNS/addon/internal API observation gaps remain; private-container confinement
still supplies the independent boundary. No full lifecycle run is claimed here.

Focused validation uses pure security functions from the actual patched Python
controller, temporary symlink/FIFO fixtures, and a disposable Node guard process
with dummy executable files. It starts no Docker or actual getconf/business
command. The initial generated spacing error and synthetic inspect-response
shape error remain in the task's evidence packet; corrected affected checks are
separately recorded. No unchanged application/qualification suites were replayed.

Further operator export/audit use still requires the CTO's standing verified
read-only credential and explicit field allowlist; comment bodies stay excluded
unless a task specifically requires them. This patch does not authorize or alter
that tooling's production reads.
