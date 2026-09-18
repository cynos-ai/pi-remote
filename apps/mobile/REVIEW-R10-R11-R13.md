# Mobile review repair handoff — 2026-09-15

Scope: `apps/mobile/**`, `tests/mobile/**`. No commits; no protocol or backend edits.

## Implemented

- R13: SQLite stores a validated original command payload, submission key, session, editor context and prepared/unknown phase before sending. Reconciliation reloads those bytes and key after restart. Unknown reconciliation does not sync the editor or require a live worker. A separate explicit-new choice permits intentional identical submissions. Receipt acknowledgment is kept separate from subsequent snapshot-refresh errors. SQLite writes are serialized so draft and snapshot writes cannot overlap pending-command transactions.
- R10 mobile: consumes `runtime.notice`, kind `extension_ui`, details `{method,args}`. Renders keyed status, text widgets and working messages; supports removals, editor replacement and selection-aware paste. Sequence deduplication prevents repeated paste on replay. Persists the local UI projection, consumes snapshot notices when supplied, and retains notices in locally generated snapshots. Unsupported terminal rendering is visible. Session changes remount the screen to isolate editor/UI state.
- R11 mobile: queries `/v1/models?sessionId=...`; explicit refresh adds `refresh=true`. Refreshes discovery after configuration events, uses the actual session model's advertised thinking levels, and avoids showing a previous model's levels after an undiscovered switch.

## Parent / Jason integration requirements

1. Mobile now calls authenticated `POST /v1/sessions/:id/editor-state` with `{text}` and an idempotency key. Accept a successful JSON response or HTTP 204. Forward inbound `editor_state {text}` to the worker; acknowledge only after applying it in IPC order, before a subsequently submitted command may invoke extensions. Mobile serializes updates and awaits this acknowledgment before the first send. A missing route prevents new command dispatch and leaves its prepared submission recoverable. The route was not yet present when this handoff was written.
2. `ReducerState.notices` exists, but the current strict snapshot schema and server snapshot serialization omit it. Add typed persisted notices to the snapshot contract and serializer. Local mobile persistence preserves already-seen UI; it cannot recover events omitted by the server while offline, or bootstrap another device. `stateFromSnapshot` is ready to consume the field.
3. Emit `setStatus(key,text|null)`, `setWidget(key,string[]|null)`, `setWorkingMessage(text|null)`, `setEditorText(text)` and `pasteToEditor(text)` using an args array. `getEditorText()` must return worker memory updated by the editor-state route. Terminal function widgets/custom UI need explicit text or standard-dialog fallback.
4. Update the root progress/review documentation after integrating the backend/protocol changes. This task retained its mobile-only ownership. No callable agent tool or separately listed task identified Jason, so direct agent messaging was unavailable; the proposed contract was reported in task commentary.

## Verification

- `pnpm exec vitest run tests/mobile`: 8 files, 28 tests passed. Includes closing/reopening a real SQLite cache after two lost responses, an accepting-server fixture with a real shell marker, one original command/effect, and a separate intentional repeated command/effect. This is client durability coverage, not a production-server crash test.
- `pnpm run typecheck:mobile` and `pnpm exec eslint apps/mobile tests/mobile`: passed.
- `pnpm verify:S10`: contract checks, Android/iOS JS exports, repository lint/typecheck and docs checks passed. Overall stage is blocked (exit 1) solely for unavailable Android/iOS devices in WSL. Evidence: `test-results/s10/report.json`.
- Actual provider, native-extension-to-device editor round trip, physical devices and production server restart were not exercised by this task. End-to-end R10 still requires the two integration changes above.
