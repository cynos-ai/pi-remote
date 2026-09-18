# Real process integration

Run `pnpm test:e2e` with Node 24.19.0, installed workspace dependencies and
OpenSSL on Linux. The runner builds the actual server and worker. To reuse a
settled build while another owner handles product changes:

```sh
node scripts/test-real-process-e2e.mjs --no-build
```

On WSL Windows mounts, the runner automatically copies the installed production
dependency graph to a temporary Linux directory, offline. `--stage-linux`
requests this elsewhere; `--no-stage` runs in place. Production file hashes are
checked against the copied artifacts; concurrent build changes fail staging.
Nothing patches the worker or substitutes a runtime. Temporary packages,
databases, certificates, shell processes and model endpoint are cleaned up.

The only synthetic service is the deterministic loopback OpenAI-compatible
model endpoint, configured through the real SDK's models.json. Its placeholder
key is not a paid credential. Child environments exclude provider credentials
and owner home resources. Native tools, Bash subprocesses, SDK message parsing,
JSONL, SQLite, worker stdout/ACK, HTTP and WSS use production implementations.

The nine tests cover streaming/tool round trips, provider errors, external
SIGKILL during Bash and before result persistence, completed-work restart,
idempotency and side-effect counts, returned stop drafts, queued follow-up
recovery, a startup form held beyond 60 seconds with reconnect, and native
new/switch withSession routing and restart. Fault barriers observe real files,
database state and `/proc`; no kill endpoint or seeded execution events exist.
The Bash result-uncertainty test stops the main process before releasing the
shell, proves the shell reached its completion marker, then kills the main
before it can persist a result. This tests that boundary, not every possible
instruction-level crash window or an exactly-once guarantee for arbitrary Bash.

Each test has a 300-second outer deadline, startup waits 90 seconds, and the
production manager's mapping deadline is configured to 60 seconds. The startup
form's 61.5-second wait starts after `interaction.requested`, excluding imports.
Assertion failures are not skipped or marked expected when a product defect
blocks a later assertion.

The runner writes synthetic diagnostic evidence under
`test-results/code-review/r16-details/` and a staged production hash manifest.
For log capture, redirect stdout/stderr to a file in `test-results/code-review`.
See the R16 follow-up in `docs/reviews/2026-09-15-code-review.md` for actual results
and outstanding integration blockers.

The `.test.ts` files in this directory remain Vitest contracts. In particular,
`s11-recovery.test.ts` tests a manually seeded recovery projection; it does not
claim real-process coverage. The `.test.mjs` suite runs separately through
Node's test runner. Neither suite substitutes for paid-provider, native TUI,
Docker or device acceptance.
