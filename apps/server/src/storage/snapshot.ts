import { createHmac, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  eventEnvelopeSchema,
  historyResponseSchema,
  metadataSyncProjectionSchema,
  snapshotSchema,
  timelineItemSchema,
  type HistoryResponse,
  type ProtocolEvent,
  type ReducerState,
  type Snapshot,
  type TimelineItem,
  createInitialState,
  toSnapshot
} from "@pi-remote/protocol";
import { cursorSchema } from "@pi-remote/protocol";
import { sessionProjectionFromRow } from "./repositories.js";

type Row = Record<string, unknown>;

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`database row ${key} is not text`);
  return value;
}

function integer(row: Row, key: string): number {
  const value = row[key];
  const number = typeof value === "bigint" ? Number(value) : Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`database row ${key} is not a safe integer`);
  return number;
}

function nullableText(row: Row, key: string): string | null {
  return row[key] === null || row[key] === undefined ? null : text(row, key);
}

function timestamp(millis: number): string {
  return new Date(millis).toISOString();
}

function parseJson(row: Row, key: string): unknown {
  try {
    return JSON.parse(text(row, key));
  } catch (error) {
    throw new Error(`invalid stored JSON in ${key}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

function withReadTransaction<T>(database: DatabaseSync, callback: () => T): T {
  database.exec("BEGIN");
  try {
    const result = callback();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the original read error.
    }
    throw error;
  }
}

function readTimelineItems(database: DatabaseSync, sessionId: string): TimelineItem[] {
  const rows = database.prepare(`
    SELECT item_id, operation_id, run_id, kind, completeness, end_reason,
           ordinal_seq, finalized_seq, payload_json
    FROM timeline_items
    WHERE session_id = ?
    ORDER BY ordinal_seq ASC, item_id ASC
  `).all(sessionId) as Row[];
  return rows.map((row) => timelineItemSchema.parse({
    itemId: text(row, "item_id"),
    operationId: text(row, "operation_id"),
    runId: nullableText(row, "run_id"),
    kind: text(row, "kind"),
    completeness: text(row, "completeness"),
    ...(nullableText(row, "end_reason") !== null ? { endReason: nullableText(row, "end_reason") } : {}),
    ordinalSeq: integer(row, "ordinal_seq"),
    finalizedSeq: integer(row, "finalized_seq"),
    data: parseJson(row, "payload_json")
  }));
}

/** Reconstruct durable projections; append callers omit separately paginated immutable history. */
export function loadReducerState(
  database: DatabaseSync, sessionId: string, options: { includeTimeline?: boolean } = {}
): ReducerState {
  const row = database.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as Row | undefined;
  if (!row) throw new Error(`session ${sessionId} does not exist`);
  const session = sessionProjectionFromRow(row);
  const initial = createInitialState(sessionId, {
    projectId: session.projectId,
    title: session.title,
    version: session.version,
    model: session.model,
    thinkingLevel: session.thinkingLevel,
    piPersistenceState: session.piPersistenceState
  });
  let stored: Partial<ReducerState> = {};
  const liveStateJson = text(row, "live_state_json");
  try {
    const decoded = JSON.parse(liveStateJson) as unknown;
    if (decoded !== null && typeof decoded === "object" && !Array.isArray(decoded)) {
      stored = decoded as Partial<ReducerState>;
    }
  } catch (error) {
    throw new Error(`invalid live_state_json: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  const state: ReducerState = {
    ...initial,
    ...stored,
    session: { ...initial.session, ...(stored.session ?? {}) },
    operations: stored.operations ?? {},
    runs: stored.runs ?? {},
    commands: stored.commands ?? {},
    interactions: stored.interactions ?? {},
    inputs: stored.inputs ?? {},
    liveItems: stored.liveItems ?? {},
    timelineItems: options.includeTimeline === false ? [] : readTimelineItems(database, sessionId),
    queue: stored.queue ?? {
      state: session.queueState,
      version: session.queueVersion,
      pause: session.queuePause,
      items: []
    },
    metadataSync: stored.metadataSync === undefined
      ? initial.metadataSync
      : metadataSyncProjectionSchema.parse(stored.metadataSync),
    notices: stored.notices ?? [],
    eventSignatures: {}
  };
  state.session = {
    ...state.session,
    ...(stored.session ?? {}),
    // The mapping/persistence columns are updated by the runtime manager
    // before its first event batch. Keep those durable columns authoritative
    // over an older live-state copy, otherwise the next event write can
    // regress the session to `uninitialized` and violate the mapping CHECK.
    ...session
  };
  state.lastSeq = integer(row, "last_event_seq");
  state.session.queuedCount = state.queue.items.length;
  state.session.queueState = state.queue.state;
  state.session.queueVersion = state.queue.version;
  state.session.queuePause = state.queue.pause;
  return state;
}

function readEventsInRange(database: DatabaseSync, sessionId: string, afterSeq: number, limit: number): ProtocolEvent[] {
  const rows = database.prepare(`
    SELECT session_id, seq, run_id, operation_id, schema_version, type, timestamp, payload_json
    FROM events
    WHERE session_id = ? AND seq > ?
    ORDER BY seq ASC
    LIMIT ?
  `).all(sessionId, afterSeq, limit) as Row[];
  return rows.map((row) => eventEnvelopeSchema.parse({
    schemaVersion: integer(row, "schema_version"),
    sessionId: text(row, "session_id"),
    seq: integer(row, "seq"),
    runId: nullableText(row, "run_id"),
    operationId: nullableText(row, "operation_id"),
    type: text(row, "type"),
    timestamp: timestamp(integer(row, "timestamp")),
    payload: parseJson(row, "payload_json")
  }));
}

/** Read events while the caller owns the SQLite read transaction. */
export function readEventsInTransaction(
  database: DatabaseSync,
  sessionId: string,
  afterSeq: number,
  limit = 500
): { events: ProtocolEvent[]; throughSeq: number; hasMore: boolean } {
  if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new Error("afterSeq must be a non-negative safe integer");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("event limit must be between 1 and 500");
  const row = database.prepare("SELECT last_event_seq FROM sessions WHERE id = ?").get(sessionId) as Row | undefined;
  if (!row) throw new Error(`session ${sessionId} does not exist`);
  const highWater = integer(row, "last_event_seq");
  if (afterSeq > highWater) throw new Error("afterSeq is above the session high-water mark");
  const events = readEventsInRange(database, sessionId, afterSeq, limit + 1);
  return {
    events: events.slice(0, limit),
    throughSeq: events.length > 0 ? events[Math.min(events.length, limit) - 1]!.seq : afterSeq,
    hasMore: events.length > limit
  };
}

export function readEvents(
  database: DatabaseSync,
  sessionId: string,
  afterSeq: number,
  limit = 500
): { events: ProtocolEvent[]; throughSeq: number; hasMore: boolean } {
  return withReadTransaction(database, () => readEventsInTransaction(database, sessionId, afterSeq, limit));
}

interface HistoryCursorPayload {
  sessionId: string;
  atSeq: number;
  beforeOrdinalSeq: number;
  beforeItemId: string;
}

function cursorSignature(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function encodeHistoryCursor(payload: HistoryCursorPayload, secret: string): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encoded}.${cursorSignature(encoded, secret)}`;
}

export function decodeHistoryCursor(cursor: string, secret: string): HistoryCursorPayload {
  cursorSchema.parse(cursor);
  const separator = cursor.lastIndexOf(".");
  if (separator <= 0) throw new Error("invalid history cursor");
  const encoded = cursor.slice(0, separator);
  const supplied = cursor.slice(separator + 1);
  const expected = cursorSignature(encoded, secret);
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  if (suppliedBytes.length !== expectedBytes.length || !timingSafeEqual(suppliedBytes, expectedBytes)) {
    throw new Error("invalid history cursor signature");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new Error("invalid history cursor payload");
  }
  if (
    payload === null || typeof payload !== "object" || Array.isArray(payload) ||
    typeof (payload as Record<string, unknown>).sessionId !== "string" ||
    typeof (payload as Record<string, unknown>).atSeq !== "number" ||
    typeof (payload as Record<string, unknown>).beforeOrdinalSeq !== "number" ||
    typeof (payload as Record<string, unknown>).beforeItemId !== "string"
  ) throw new Error("invalid history cursor payload");
  const result = payload as HistoryCursorPayload;
  if (!Number.isSafeInteger(result.atSeq) || !Number.isSafeInteger(result.beforeOrdinalSeq)) {
    throw new Error("invalid history cursor sequence");
  }
  return result;
}

function readHistoryItems(
  database: DatabaseSync,
  sessionId: string,
  atSeq: number,
  before: { ordinalSeq: number; itemId: string } | null,
  limit: number
): TimelineItem[] {
  const rows = before === null
    ? database.prepare(`
        SELECT item_id, operation_id, run_id, kind, completeness, end_reason,
               ordinal_seq, finalized_seq, payload_json
        FROM timeline_items WHERE session_id = ? AND finalized_seq <= ?
        ORDER BY ordinal_seq DESC, item_id DESC LIMIT ?
      `).all(sessionId, atSeq, limit + 1) as Row[]
    : database.prepare(`
        SELECT item_id, operation_id, run_id, kind, completeness, end_reason,
               ordinal_seq, finalized_seq, payload_json
        FROM timeline_items
        WHERE session_id = ? AND finalized_seq <= ?
          AND (ordinal_seq < ? OR (ordinal_seq = ? AND item_id < ?))
        ORDER BY ordinal_seq DESC, item_id DESC LIMIT ?
      `).all(sessionId, atSeq, before.ordinalSeq, before.ordinalSeq, before.itemId, limit + 1) as Row[];
  return rows.map((row) => timelineItemSchema.parse({
    itemId: text(row, "item_id"),
    operationId: text(row, "operation_id"),
    runId: nullableText(row, "run_id"),
    kind: text(row, "kind"),
    completeness: text(row, "completeness"),
    ...(nullableText(row, "end_reason") !== null ? { endReason: nullableText(row, "end_reason") } : {}),
    ordinalSeq: integer(row, "ordinal_seq"),
    finalizedSeq: integer(row, "finalized_seq"),
    data: parseJson(row, "payload_json")
  }));
}

export function readHistory(
  database: DatabaseSync,
  sessionId: string,
  cursor: string | null,
  limit = 50,
  secret = "development-only-history-cursor-secret"
): HistoryResponse {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error("history limit must be between 1 and 200");
  return withReadTransaction(database, () => {
    const sessionRow = database.prepare("SELECT last_event_seq FROM sessions WHERE id = ?").get(sessionId) as Row | undefined;
    if (!sessionRow) throw new Error(`session ${sessionId} does not exist`);
    let atSeq = integer(sessionRow, "last_event_seq");
    let before: { ordinalSeq: number; itemId: string } | null = null;
    if (cursor !== null) {
      const decoded = decodeHistoryCursor(cursor, secret);
      if (decoded.sessionId !== sessionId) throw new Error("history cursor belongs to another session");
      if (decoded.atSeq > atSeq) throw new Error("history cursor is ahead of the session");
      atSeq = decoded.atSeq;
      before = { ordinalSeq: decoded.beforeOrdinalSeq, itemId: decoded.beforeItemId };
    }
    const rows = readHistoryItems(database, sessionId, atSeq, before, limit);
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    const nextCursor = hasMore && last
      ? encodeHistoryCursor({ sessionId, atSeq, beforeOrdinalSeq: last.ordinalSeq, beforeItemId: last.itemId }, secret)
      : null;
    return historyResponseSchema.parse({ items, nextCursor, atSeq });
  });
}

export function readSnapshot(
  database: DatabaseSync,
  sessionId: string,
  options: Pick<Snapshot, "historyCursor" | "availableThinkingLevels" | "allowedCommands"> = {
    historyCursor: null,
    availableThinkingLevels: [],
    allowedCommands: ["prompt", "follow_up"]
  }
): Snapshot {
  return withReadTransaction(database, () => {
    const state = loadReducerState(database, sessionId, { includeTimeline: false });
    // Match toSnapshot's last 50 items without decoding the entire history.
    state.timelineItems = readHistoryItems(database, sessionId, state.lastSeq, null, 50).slice(0, 50).reverse();
    return snapshotSchema.parse(toSnapshot(state, options));
  });
}
