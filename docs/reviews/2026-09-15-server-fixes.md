# Server review fixes — 2026-09-15

Scope: R04, R06, R08, R11, R12 plus the coordinated server transport portions of R03/R07/R09/R10/R14. No commits were made. Worker, native session implementation, and public protocol changes belong to their respective parallel agents.

## Behavior and internal interfaces

- Recovery distinguishes the queued Run owned by an undispatched command from an obsolete control target. A queued follow-up retains its Command, Run, Operation and payload. An uncertain dispatched command is not resent; a surviving tail is paused after an interrupted Run. New explicit prompts remain usable. Multi-Session startup recovery assigns a distinct storage batch namespace per Session.
- `initialize` carries the expected pi `sessionId`, `sessionFile`, `persistenceState` and database `title` and `hasPendingTitle`. Repository mapping changes allow a new file path only for an unflushed Session with the same pi ID. Persisted mappings remain immutable. The agent-pi file opener validates persisted history before SDK open.
- Initialization owns a durable Operation. Reaching a persisted initialization interaction exempts that startup from the ready deadline; process heartbeats continue to detect loss of liveness. Answers and editor updates do not wait for ready. A response Command is inserted before claiming the interaction response foreign key, inside the same transaction.
- `get_models {requestId,refresh?}` / `models {requestId,items,availableThinkingLevels}` expose the actual worker registry. Runtime-state updates refresh the manager's current-model capabilities. `GET /v1/models?sessionId=…&refresh=true` queries that Session; without a Session it reads the SDK model runtime through the agent-pi boundary without allocating history. Unloaded Session snapshots derive thinking levels from the configured catalog.
- A mobile rename writes its pending title intent in the same database transaction as its versioned event. `rename {name,intentId?}` / `rename_ack {name,intentId}` clear only the matching intent. Pending titles are replayed on ready; later native title changes supersede older intents. Native effective title/config changes receive their version at EventStore persistence; no-op echoes do not increment it.
- `POST /v1/sessions/:id/editor-state {text}` authenticates ownership and returns 204 only after `editor_state {text,requestId}` receives `editor_state_ack {requestId}`. This setter works before initialization completes. Repeating the same setter is safe.
- Compact alone sends `abort {runId,preserveQueue:true}`. Bash dispatch takes no model Run lease and can coexist with a model Run.

## Native session replacement

The outer IPC owner/epoch stays fixed for the process. Editor setters load their exact app Session; delayed form responses keep the old runtime epoch. Opt-in idle reaping considers all owned Sessions’ pending forms, active durable operations, and native heartbeat activity. Each event keeps its actual owning app Session ID, including delayed source callbacks.

1. Worker sends `session_replace_intent {requestId,kind,sourceOperationId?,piSessionId,piSessionFile,targetFile?}` before native replacement. Kind is `new`, `switch` or `fork`.
2. Manager persists a `runtime.notice` with replacement-intent details in the source event stream and replies `session_replace_ack {requestId,phase:"intent",appSessionId}`.
3. Worker sends `session_replaced {requestId,piSessionId,piSessionFile,persistenceState}` after the SDK has selected the destination, before binding destination hooks/continuations.
4. Manager creates or claims the destination app Session under the project matching its native cwd, commits its mapping and a source binding notice, then replies with phase `bound` and the destination `appSessionId`. It never overwrites the source history mapping. For switch, the manager validates the target JSONL before the intent ACK, records its actual header cwd/identity, and reuses or creates a project owned by the same user for that directory. This native path does not apply an extra workspace-root sandbox or require directory write permission. The worker workspace mapping follows the destination project; new/fork retain the source project. A target already in use by a different worker must be transferred without concurrent history writers.
5. Mixed event batches are grouped by owning Session and committed in one transaction before ACK. Destination batch keys use a separate storage namespace; Run/interaction runtime identity retains the actual process epoch. Command results resolve their durable source Session. Targeted controls find the original runtime epoch. Process exit drains stdout before recovery.

A Command awaiting ready when startup itself replaces the native Session follows the resulting destination. Its original queued source Run/Operation is cancelled before IPC and a destination Run/Operation is allocated; its payload and original idempotency scope are retained. Source command events retain the destination association and receive mirrored outcomes. This does not replay a command that has already crossed IPC.

Input text validation uses the established 64 KiB byte limit separately from identity-string validation. Prompts, Bash commands, compact instructions and steer/follow-up text are not capped at 512 characters; diagnostics use the larger outbound frame budget.

Intent records are audit/recovery evidence, not instructions to automatically retry native replacement after a crash. Cancellation before binding leaves the intent without a bound record.

## Large output integration

Each worker receives a dedicated trusted spool directory via `PI_REMOTE_WORKER_SPOOL_DIR`. IPC hydration occurs in stream order before decoding. Output archival finishes before event persistence, and batch ACK follows the transaction. Artifact helper tests belong to the output agent; transport integration is in manager/ipc.

## Evidence and limits

Node 24.19.0, pnpm 10.28.0, WSL Linux. The focused run of `tests/commands/commands.test.ts`, `tests/runtime/runtime.test.ts`, and `tests/api/api.test.ts` passed 31 tests after these fixes. It covers the production CommandService follow-up path, recovery/continued new work, model/Bash lease coexistence, mapping state, rename ACK ordering, destination routing, pre-ready editor ACK, catalog refresh, and an actual SDK `session_start` extension form held open for 15.2 seconds.

The form test uses the production PiWorker and real SDK/extensions with an in-process pipe transport. It does not claim a real OS process crash or mobile network test. Importing the built worker alone on this mounted checkout measured 36.398 seconds, before worker heartbeat startup; this environment-specific cold-import issue is distinct from the form-wait regression. The startup timeout was not globally raised to hide it.

Real provider, full native TUI comparison, device, and deployment acceptance were not run here. Parallel agents own strict history-file tests, EventStore stamping tests, native runtime factory tests, and complete-output HTTP/WSS tests. These focused results do not replace that combined acceptance.
