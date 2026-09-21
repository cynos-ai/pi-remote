import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  parseProtocolEvent,
  reduceEvents,
  type ProtocolEvent,
  type ReducerState
} from "@pi-remote/protocol";
import type { CommandProjection } from "@pi-remote/protocol";
import { loadReducerState, readEventsInTransaction } from "./snapshot.js";
import { withTransaction } from "./database.js";
import { assertCommandActorForSession, assertCommandOwnerForSession } from "./repositories.js";

type Row = Record<string, unknown>;

export interface EventStoreOptions {
  commandActor?: { userId: string; deviceId: string };
  now?: () => number;
  executionScopeKey?: (sessionId: string, runId: string) => string;
}

export interface AppendEventBatchInput {
  sessionId: string;
  workerEpoch: string;
  batchNo: number;
  events: readonly unknown[];
}

export interface AppendEventBatchResult {
  duplicate: boolean;
  firstSeq: number;
  lastSeq: number;
  events: ProtocolEvent[];
}

export const MAX_EVENT_BATCH_SIZE = 500;

export class IpcBatchConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IpcBatchConflictError";
  }
}

function rowText(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`database row ${key} is not text`);
  return value;
}

function rowNumber(row: Row, key: string): number {
  const value = row[key];
  const number = typeof value === "bigint" ? Number(value) : Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`database row ${key} is not a safe integer`);
  return number;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)])
    );
  }
  return value;
}

function batchHash(events: readonly ProtocolEvent[]): string {
  const withoutTransportSeq = events.map((event) =>
    Object.fromEntries(Object.entries(event).filter(([key]) => key !== "seq"))
  );
  return createHash("sha256").update(JSON.stringify(canonicalize(withoutTransportSeq))).digest("hex");
}

function parseStoredBatchEvents(
  database: DatabaseSync,
  sessionId: string,
  firstSeq: number,
  lastSeq: number
): ProtocolEvent[] {
  const result = readEventsInTransaction(database, sessionId, firstSeq - 1, lastSeq - firstSeq + 1);
  const events = result.events.filter((event) => event.seq >= firstSeq && event.seq <= lastSeq);
  if (events.length !== lastSeq - firstSeq + 1) {
    throw new Error(`IPC batch ${firstSeq}-${lastSeq} has incomplete committed events`);
  }
  return events;
}

function runtimeState(state: ReducerState): Record<string, unknown> {
  return {
    schemaVersion: state.schemaVersion,
    sessionId: state.sessionId,
    session: state.session,
    operations: state.operations,
    runs: state.runs,
    commands: state.commands,
    interactions: state.interactions,
    inputs: state.inputs,
    liveItems: state.liveItems,
    queue: state.queue,
    metadataSync: state.metadataSync,
    notices: state.notices
  };
}

function terminalCommand(state: CommandProjection["state"]): boolean {
  return state === "completed" || state === "failed" || state === "cancelled" || state === "unknown";
}

function terminalRun(state: ReducerState["runs"][string]["status"]): boolean {
  return state === "completed" || state === "failed" || state === "aborted" || state === "interrupted" || state === "cancelled";
}

function sqlRunStatus(status: ReducerState["runs"][string]["status"]): string {
  return status === "stopping" ? "running" : status;
}

function actorForSession(database: DatabaseSync, sessionId: string, options: EventStoreOptions): { userId: string; deviceId: string } {
  if (options.commandActor) {
    assertCommandActorForSession(database, sessionId, options.commandActor);
    return options.commandActor;
  }
  const row = database.prepare(`
    SELECT p.user_id,
      (SELECT d.id FROM devices d WHERE d.user_id = p.user_id AND d.revoked_at IS NULL ORDER BY d.created_at, d.id LIMIT 1) AS device_id
    FROM sessions s JOIN projects p ON p.id = s.project_id WHERE s.id = ?
  `).get(sessionId) as Row | undefined;
  if (!row || typeof row.user_id !== "string" || typeof row.device_id !== "string") {
    throw new Error("an active device is required to materialize a command event");
  }
  return { userId: row.user_id, deviceId: row.device_id };
}

function syncCommandRows(database: DatabaseSync, state: ReducerState, sessionId: string, now: number, options: EventStoreOptions, ids: ReadonlySet<string>): void {
  let actor: { userId: string; deviceId: string } | undefined;
  for (const id of ids) {
    const command = state.commands[id]!;
    const existing = database.prepare("SELECT id, session_id FROM commands WHERE id = ?").get(command.commandId) as Row | undefined;
    if (!existing) {
      actor ??= actorForSession(database, sessionId, options);
      const payloadJson = JSON.stringify({ kind: command.kind });
      const payloadHash = createHash("sha256").update(payloadJson).digest("hex");
      database.prepare(`
        INSERT INTO commands(
          id, user_id, device_id, session_id, scope, client_command_id, kind,
          payload_hash, payload_json, state, target_run_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
      `).run(command.commandId, actor.userId, actor.deviceId, sessionId, `EVENT:${sessionId}`, command.commandId, command.kind, payloadHash, payloadJson, command.state, now);
    } else {
      assertCommandOwnerForSession(database, sessionId, command.commandId);
    }
    const finishedAt = terminalCommand(command.state) ? now : null;
    database.prepare(`
      UPDATE commands SET kind = ?, state = ?, error_code = ?,
        result_json = ?, finished_at = COALESCE(finished_at, ?)
      WHERE id = ?
    `).run(
      command.kind,
      command.state,
      command.error?.code ?? null,
      command.result ? JSON.stringify(command.result) : null,
      finishedAt,
      command.commandId
    );
  }
}

function syncRunRows(database: DatabaseSync, state: ReducerState, sessionId: string, workerEpoch: string, now: number, options: EventStoreOptions, ids: ReadonlySet<string>): void {
  for (const id of ids) {
    const run = state.runs[id]!;
    if (run.source === "command" && run.commandId === null) throw new Error(`command-sourced run ${run.runId} has no command`);
    if (run.commandId !== null) {
      const command = database.prepare("SELECT id FROM commands WHERE id = ?").get(run.commandId) as Row | undefined;
      if (!command) throw new Error(`run ${run.runId} references missing command ${run.commandId}`);
      assertCommandOwnerForSession(database, sessionId, run.commandId);
    }
    const existing = database.prepare("SELECT id, session_id FROM runs WHERE id = ?").get(run.runId) as Row | undefined;
    if (existing && rowText(existing, "session_id") !== sessionId) {
      throw new Error(`run ${run.runId} belongs to another session`);
    }
    const executionScopeKey = options.executionScopeKey?.(sessionId, run.runId) ?? `session:${sessionId}:run:${run.runId}`;
    const sqlStatus = sqlRunStatus(run.status);
    if (!existing) {
      database.prepare(`
        INSERT INTO runs(
          id, session_id, operation_id, source, command_id, kind, status, phase,
          worker_epoch, execution_scope_key, error_code, created_at, started_at, finished_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        run.runId,
        sessionId,
        run.operationId,
        run.source,
        run.commandId,
        run.kind,
        sqlStatus,
        run.phase,
        workerEpoch,
        executionScopeKey,
        run.error?.code ?? null,
        now,
        run.status === "queued" ? null : now,
        terminalRun(run.status) ? now : null
      );
    } else {
      database.prepare(`
        UPDATE runs SET operation_id = ?, source = ?, command_id = ?, kind = ?, status = ?, phase = ?,
          worker_epoch = COALESCE(worker_epoch, ?), execution_scope_key = COALESCE(execution_scope_key, ?),
          error_code = ?, started_at = COALESCE(started_at, ?), finished_at = COALESCE(finished_at, ?)
        WHERE id = ? AND session_id = ?
      `).run(
        run.operationId,
        run.source,
        run.commandId,
        run.kind,
        sqlStatus,
        run.phase,
        workerEpoch,
        executionScopeKey,
        run.error?.code ?? null,
        run.status === "queued" ? null : now,
        terminalRun(run.status) ? now : null,
        run.runId,
        sessionId
      );
    }
  }
}

function syncInteractionRows(database: DatabaseSync, state: ReducerState, sessionId: string, workerEpoch: string, now: number, ids: ReadonlySet<string>): void {
  for (const id of ids) {
    const interaction = state.interactions[id]!;
    if (interaction.commandId !== null) assertCommandOwnerForSession(database, sessionId, interaction.commandId);
    const payload = {
      interactionId: interaction.interactionId,
      operationId: interaction.operationId,
      origin: interaction.origin,
      kind: interaction.kind,
      title: interaction.title,
      ...(interaction.options ? { options: interaction.options } : {}),
      ...(interaction.message !== undefined ? { message: interaction.message } : {}),
      ...(interaction.placeholder !== undefined ? { placeholder: interaction.placeholder } : {}),
      ...(interaction.prefill !== undefined ? { prefill: interaction.prefill } : {}),
      ...(interaction.sensitive ? { sensitive: true } : {}),
      ...(interaction.expiresAt !== undefined ? { expiresAt: interaction.expiresAt } : {})
    };
    const existing = database.prepare("SELECT id, session_id FROM interactions WHERE id = ?").get(interaction.interactionId) as Row | undefined;
    if (existing && rowText(existing, "session_id") !== sessionId) {
      throw new Error(`interaction ${interaction.interactionId} belongs to another session`);
    }
    if (!existing) {
      database.prepare(`
        INSERT INTO interactions(
          id, session_id, operation_id, origin, run_id, command_id, worker_epoch,
          kind, payload_json, status, response_json, created_at, expires_at, resolved_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        interaction.interactionId,
        sessionId,
        interaction.operationId,
        interaction.origin,
        interaction.runId,
        interaction.commandId,
        workerEpoch,
        interaction.kind,
        JSON.stringify(payload),
        interaction.status,
        interaction.response ? JSON.stringify(interaction.response) : null,
        now,
        interaction.expiresAt ? Date.parse(interaction.expiresAt) : null,
        interaction.status === "pending" ? null : now
      );
    } else {
      database.prepare(`
        UPDATE interactions SET status = ?, response_json = ?, resolved_at = CASE WHEN ? = 'pending' THEN NULL ELSE COALESCE(resolved_at, ?) END
        WHERE id = ? AND session_id = ?
      `).run(
        interaction.status,
        interaction.response ? JSON.stringify(interaction.response) : null,
        interaction.status,
        now,
        interaction.interactionId,
        sessionId
      );
    }
  }
}

function syncTimelineRows(database: DatabaseSync, state: ReducerState): void {
  for (const item of state.timelineItems) {
    database.prepare(`
      INSERT INTO timeline_items(
        session_id, item_id, operation_id, run_id, kind, completeness, end_reason,
        ordinal_seq, finalized_seq, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      state.sessionId,
      item.itemId,
      item.operationId,
      item.runId,
      item.kind,
      item.completeness,
      item.endReason ?? null,
      item.ordinalSeq,
      item.finalizedSeq,
      JSON.stringify(item.data)
    );
  }
}

function syncCommandTargets(database: DatabaseSync, state: ReducerState, ids: ReadonlySet<string>): void {
  for (const id of ids) {
    const command = state.commands[id]!;
    // Causal command projections may also appear in a replacement Session.
    // Only its current owning Session can change the session-local control target.
    database.prepare("UPDATE commands SET target_run_id = ? WHERE id = ? AND session_id = ?")
      .run(command.targetRunId, command.commandId, state.sessionId);
  }
}

function syncSessionRow(database: DatabaseSync, state: ReducerState, timestampMillis: number): void {
  const modelJson = state.session.model ? JSON.stringify(state.session.model) : null;
  const archivedAt = state.session.archivedAt ? Date.parse(state.session.archivedAt) : null;
  database.prepare(`
    UPDATE sessions SET title = ?, version = ?, pi_persistence_state = ?, history_error_code = ?,
      model_json = ?, thinking_level = ?, queue_state = ?, queue_version = ?,
      queue_pause_run_id = ?, queue_pause_reason = ?, last_event_seq = ?, live_state_json = ?,
      last_activity_at = ?, archived_at = ?
    WHERE id = ?
  `).run(
    state.session.title,
    state.session.version,
    state.session.piPersistenceState,
    state.session.historyErrorCode,
    modelJson,
    state.session.thinkingLevel,
    state.queue.state,
    state.queue.version,
    state.queue.pause?.runId ?? null,
    state.queue.pause?.reason ?? null,
    state.lastSeq,
    JSON.stringify(runtimeState(state)),
    timestampMillis,
    archivedAt,
    state.sessionId
  );
  database.prepare(`
    UPDATE projects
    SET last_activity_at = CASE WHEN last_activity_at < ? THEN ? ELSE last_activity_at END
    WHERE id = (SELECT project_id FROM sessions WHERE id = ?)
  `).run(timestampMillis, timestampMillis, state.sessionId);
}

function insertEvents(database: DatabaseSync, events: readonly ProtocolEvent[]): void {
  const statement = database.prepare(`
    INSERT INTO events(session_id, seq, run_id, operation_id, schema_version, type, timestamp, payload_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const event of events) {
    statement.run(
      event.sessionId,
      event.seq,
      event.runId,
      event.operationId,
      event.schemaVersion,
      event.type,
      Date.parse(event.timestamp),
      JSON.stringify(event.payload)
    );
  }
}

export class EventStore {
  constructor(private readonly database: DatabaseSync, private readonly options: EventStoreOptions = {}) {}

  appendBatch(input: AppendEventBatchInput, inTransaction = false): AppendEventBatchResult {
    if (!input.workerEpoch || !Number.isSafeInteger(input.batchNo) || input.batchNo < 1) {
      throw new Error("workerEpoch and positive batchNo are required");
    }
    if (input.events.length === 0) throw new Error("an event batch cannot be empty");
    if (input.events.length > MAX_EVENT_BATCH_SIZE) throw new Error(`an event batch cannot exceed ${MAX_EVENT_BATCH_SIZE} events`);
    const parsed = input.events.map(parseProtocolEvent);
    if (parsed.some((event) => event.sessionId !== input.sessionId)) {
      throw new Error("all events in a batch must belong to the target session");
    }
    const hash = batchHash(parsed);
    const append = (): AppendEventBatchResult => {
      const existing = this.database.prepare(`
        SELECT session_id, first_seq, last_seq, payload_hash
        FROM ipc_batches WHERE worker_epoch = ? AND batch_no = ?
      `).get(input.workerEpoch, input.batchNo) as Row | undefined;
      if (existing) {
        if (rowText(existing, "session_id") !== input.sessionId || rowText(existing, "payload_hash") !== hash) {
          throw new IpcBatchConflictError(`IPC batch ${input.workerEpoch}/${input.batchNo} conflicts with its committed payload`);
        }
        const firstSeq = rowNumber(existing, "first_seq");
        const lastSeq = rowNumber(existing, "last_seq");
        return { duplicate: true, firstSeq, lastSeq, events: parseStoredBatchEvents(this.database, input.sessionId, firstSeq, lastSeq) };
      }

      const session = this.database.prepare("SELECT last_event_seq FROM sessions WHERE id = ?").get(input.sessionId) as Row | undefined;
      if (!session) throw new Error(`session ${input.sessionId} does not exist`);
      const currentSeq = rowNumber(session, "last_event_seq");
      const state = loadReducerState(this.database, input.sessionId, { includeTimeline: false });
      if (state.lastSeq !== currentSeq) throw new Error(`session ${input.sessionId} live state is out of sync with event seq`);
      // History remains in timeline_items. Check only newly introduced identities,
      // including starts that do not finalize until a later batch.
      const historicalItem = this.database.prepare("SELECT 1 FROM timeline_items WHERE session_id = ? AND item_id = ?");
      let version = state.session.version;
      const config = { ...state.session };
      const persistedEvents = parsed.map((event, index) => {
        if (event.type === "message.started" || event.type === "tool.started") {
          const itemId = event.type === "message.started" ? event.payload.messageId : event.payload.toolCallId;
          if (historicalItem.get(input.sessionId, itemId)) throw new Error(`timeline item ${itemId} already exists`);
        }
        let assigned = event;
        if (event.type === "session.updated") {
          const changes = event.payload.changes;
          const effectiveChange = (Object.keys(changes) as Array<keyof typeof changes>).some((key) => {
            if (key === "version") return false;
            if (key === "archived") return changes.archived !== (config.archivedAt !== null);
            return JSON.stringify(canonicalize(changes[key])) !== JSON.stringify(canonicalize(config[key]));
          });
          if (changes.version !== undefined || effectiveChange) {
            version = changes.version ?? version + 1;
            assigned = { ...event, payload: { changes: { ...changes, version } } };
          }
          Object.assign(config, changes);
          if (changes.archived !== undefined) config.archivedAt = changes.archived ? changes.archivedAt ?? event.timestamp : null;
        }
        return parseProtocolEvent({ ...assigned, seq: currentSeq + index + 1 });
      });
      const nextState = reduceEvents(state, persistedEvents);
      const commandIds = new Set<string>();
      const runIds = new Set<string>();
      const interactionIds = new Set<string>();
      for (const event of persistedEvents) {
        if (event.type === "command.updated") commandIds.add(event.payload.commandId);
        if (event.type === "run.updated") runIds.add(event.runId!);
        if (event.type === "interaction.requested" || event.type === "interaction.resolved") {
          interactionIds.add(event.payload.interactionId);
        }
        // Operation completion can implicitly cancel pending interactions.
        if (event.type === "operation.updated") {
          for (const interaction of Object.values(nextState.interactions)) {
            if (interaction.updatedSeq === event.seq) interactionIds.add(interaction.interactionId);
          }
        }
      }
      const now = this.options.now?.() ?? Date.now();
      syncCommandRows(this.database, nextState, input.sessionId, now, this.options, commandIds);
      syncRunRows(this.database, nextState, input.sessionId, input.workerEpoch, now, this.options, runIds);
      syncCommandTargets(this.database, nextState, commandIds);
      syncInteractionRows(this.database, nextState, input.sessionId, input.workerEpoch, now, interactionIds);
      insertEvents(this.database, persistedEvents);
      syncTimelineRows(this.database, nextState);
      syncSessionRow(this.database, nextState, Date.parse(persistedEvents.at(-1)!.timestamp));
      const firstSeq = persistedEvents[0]!.seq;
      const lastSeq = persistedEvents.at(-1)!.seq;
      this.database.prepare(`
        INSERT INTO ipc_batches(worker_epoch, batch_no, session_id, first_seq, last_seq, payload_hash)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(input.workerEpoch, input.batchNo, input.sessionId, firstSeq, lastSeq, hash);
      return { duplicate: false, firstSeq, lastSeq, events: persistedEvents };
    };
    return inTransaction ? append() : withTransaction(this.database, append);
  }

  /** Append while the caller owns the surrounding short write transaction. */
  appendBatchWithinTransaction(input: AppendEventBatchInput): AppendEventBatchResult {
    return this.appendBatch(input, true);
  }
}
