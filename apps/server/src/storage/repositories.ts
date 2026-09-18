import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  modelRefSchema,
  type ModelRef,
  type Project,
  type ProjectSummary,
  projectSchema,
  projectSummarySchema,
  sessionProjectionSchema,
  type SessionProjection
} from "@pi-remote/protocol";

type Row = Record<string, unknown>;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)])
    );
  }
  if (value === undefined) throw new Error("undefined is not valid JSON");
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("non-finite number is not valid JSON");
  return value;
}

export function stableJsonStringify(value: unknown): string {
  const encoded = JSON.stringify(canonicalize(value));
  if (encoded === undefined) throw new Error("value is not JSON serializable");
  return encoded;
}

function requiredString(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`database row ${key} is not text`);
  return value;
}

function requiredNumber(row: Row, key: string): number {
  const value = row[key];
  const number = typeof value === "bigint" ? Number(value) : Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`database row ${key} is not a safe integer`);
  return number;
}

function nullableString(row: Row, key: string): string | null {
  const value = row[key];
  return value === null || value === undefined ? null : requiredString(row, key);
}

function nullableNumber(row: Row, key: string): number | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  return requiredNumber(row, key);
}

export function timestampFromMillis(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

export function millisFromTimestamp(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) throw new Error(`invalid timestamp ${value}`);
  return millis;
}

function parseModel(value: string | null): ModelRef | null {
  if (value === null) return null;
  return modelRefSchema.parse(JSON.parse(value));
}

function sessionOwnerId(database: DatabaseSync, sessionId: string): string {
  const row = database.prepare(`
    SELECT p.user_id
    FROM sessions s JOIN projects p ON p.id = s.project_id
    WHERE s.id = ?
  `).get(sessionId) as Row | undefined;
  if (!row || typeof row.user_id !== "string") throw new Error(`session ${sessionId} has no owner`);
  return row.user_id;
}

export function assertSessionOwner(database: DatabaseSync, sessionId: string, userId: string): void {
  if (sessionOwnerId(database, sessionId) !== userId) {
    throw new Error(`user ${userId} is not the owner of session ${sessionId}`);
  }
}

/** Validate the identity used to materialize a command for a Session. */
export function assertCommandActorForSession(
  database: DatabaseSync,
  sessionId: string,
  actor: { userId: string; deviceId: string }
): void {
  const ownerId = sessionOwnerId(database, sessionId);
  const device = database.prepare("SELECT user_id, revoked_at FROM devices WHERE id = ?").get(actor.deviceId) as Row | undefined;
  if (!device || typeof device.user_id !== "string") throw new Error(`device ${actor.deviceId} has no owner`);
  if (device.user_id !== actor.userId || actor.userId !== ownerId) {
    throw new Error(`command actor is not the owner of session ${sessionId}`);
  }
  if (device.revoked_at !== null && device.revoked_at !== undefined) {
    throw new Error(`device ${actor.deviceId} is revoked`);
  }
}

/** Causal commands may cross Sessions only when both Sessions have one owner. */
export function assertCommandOwnerForSession(database: DatabaseSync, sessionId: string, commandId: string): void {
  const row = database.prepare(`
    SELECT p.user_id AS session_owner, c.user_id AS command_owner
    FROM sessions s
    JOIN projects p ON p.id = s.project_id
    JOIN commands c ON c.id = ?
    WHERE s.id = ?
  `).get(commandId, sessionId) as Row | undefined;
  if (!row || typeof row.session_owner !== "string" || typeof row.command_owner !== "string") {
    throw new Error(`causal command ${commandId} or session ${sessionId} does not exist`);
  }
  if (row.session_owner !== row.command_owner) {
    throw new Error(`causal command ${commandId} has a different owner from session ${sessionId}`);
  }
}

function storedSessionProjection(row: Row): Partial<SessionProjection> {
  const encodedState = row.live_state_json;
  if (typeof encodedState !== "string") return {};
  try {
    const decoded = JSON.parse(encodedState) as unknown;
    if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) return {};
    const candidate = (decoded as Record<string, unknown>).session;
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return {};
    return sessionProjectionSchema.partial().parse(candidate);
  } catch (error) {
    throw new Error(`invalid live_state_json: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

export interface OwnerRecord {
  id: string;
  displayName: string;
  createdAt: number;
}

export class OwnerRepository {
  constructor(private readonly database: DatabaseSync) {}

  ensure(owner: { id?: string; displayName: string; now?: number }): OwnerRecord {
    const id = owner.id ?? randomUUID();
    const createdAt = owner.now ?? Date.now();
    this.database.prepare(
      "INSERT OR IGNORE INTO users(id, display_name, created_at) VALUES (?, ?, ?)"
    ).run(id, owner.displayName, createdAt);
    return this.get(id) ?? (() => { throw new Error(`owner ${id} was not created`); })();
  }

  get(id: string): OwnerRecord | null {
    const row = this.database.prepare("SELECT id, display_name, created_at FROM users WHERE id = ?").get(id) as Row | undefined;
    if (!row) return null;
    return { id: requiredString(row, "id"), displayName: requiredString(row, "display_name"), createdAt: requiredNumber(row, "created_at") };
  }
}

export interface DeviceRecord {
  id: string;
  userId: string;
  name: string;
  tokenHash: string;
  createdAt: number;
  revokedAt: number | null;
}

export class DeviceRepository {
  constructor(private readonly database: DatabaseSync) {}

  create(input: { id?: string; userId: string; name: string; token: string; now?: number }): DeviceRecord {
    const id = input.id ?? randomUUID();
    const createdAt = input.now ?? Date.now();
    const tokenHash = createHash("sha256").update(input.token).digest("hex");
    this.database.prepare(
      "INSERT INTO devices(id, user_id, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run(id, input.userId, input.name, tokenHash, createdAt);
    return this.get(id) ?? (() => { throw new Error(`device ${id} was not created`); })();
  }

  get(id: string): DeviceRecord | null {
    const row = this.database.prepare("SELECT * FROM devices WHERE id = ?").get(id) as Row | undefined;
    if (!row) return null;
    return {
      id: requiredString(row, "id"),
      userId: requiredString(row, "user_id"),
      name: requiredString(row, "name"),
      tokenHash: requiredString(row, "token_hash"),
      createdAt: requiredNumber(row, "created_at"),
      revokedAt: nullableNumber(row, "revoked_at")
    };
  }

  getByToken(token: string): DeviceRecord | null {
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const row = this.database.prepare("SELECT id FROM devices WHERE token_hash = ?").get(tokenHash) as Row | undefined;
    if (!row) return null;
    return this.get(requiredString(row, "id"));
  }

  list(userId: string): DeviceRecord[] {
    const rows = this.database.prepare(
      "SELECT id FROM devices WHERE user_id = ? ORDER BY created_at ASC, id ASC"
    ).all(userId) as Row[];
    return rows
      .map((row) => this.get(requiredString(row, "id")))
      .filter((device): device is DeviceRecord => device !== null);
  }

  touch(id: string, now = Date.now()): void {
    this.database.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(now, id);
  }

  revoke(userId: string, id: string, now = Date.now()): DeviceRecord | null {
    this.database.prepare(
      "UPDATE devices SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ? AND user_id = ?"
    ).run(now, id, userId);
    const device = this.get(id);
    return device?.userId === userId ? device : null;
  }
}

export interface PairingTokenRecord {
  id: string;
  userId: string;
  expiresAt: number;
  consumedAt: number | null;
  createdAt: number;
}

export class PairingTokenRepository {
  constructor(private readonly database: DatabaseSync) {}

  create(input: { id?: string; userId: string; token: string; expiresAt: number; now?: number }): PairingTokenRecord {
    const id = input.id ?? randomUUID();
    const now = input.now ?? Date.now();
    const tokenHash = createHash("sha256").update(input.token).digest("hex");
    this.database.prepare(
      "INSERT INTO pairing_tokens(id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run(id, input.userId, tokenHash, input.expiresAt, now);
    return this.get(id) ?? (() => { throw new Error("pairing token was not created"); })();
  }

  get(id: string): PairingTokenRecord | null {
    const row = this.database.prepare("SELECT * FROM pairing_tokens WHERE id = ?").get(id) as Row | undefined;
    if (!row) return null;
    return {
      id: requiredString(row, "id"),
      userId: requiredString(row, "user_id"),
      expiresAt: requiredNumber(row, "expires_at"),
      consumedAt: nullableNumber(row, "consumed_at"),
      createdAt: requiredNumber(row, "created_at")
    };
  }

  /** Atomically consume a token; null covers unknown, expired, and reused tokens. */
  consume(token: string, now = Date.now()): { id: string; userId: string } | null {
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const result = this.database.prepare(
      "UPDATE pairing_tokens SET consumed_at = ? WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?"
    ).run(now, tokenHash, now);
    if (Number(result.changes) !== 1) return null;
    const row = this.database.prepare("SELECT id, user_id FROM pairing_tokens WHERE token_hash = ?").get(tokenHash) as Row | undefined;
    if (!row) throw new Error("consumed pairing token disappeared");
    return { id: requiredString(row, "id"), userId: requiredString(row, "user_id") };
  }
}

export interface ProjectCreateInput {
  id?: string;
  userId: string;
  name: string;
  rootPath: string;
  workspaceKey: string;
  rootIdentity: string;
  gitCommonDir?: string | null;
  defaultModel?: ModelRef | null;
  defaultThinkingLevel?: string | null;
  now?: number;
}

function projectFromRow(row: Row): Project {
  const summary: ProjectSummary = projectSummarySchema.parse({
    id: requiredString(row, "id"),
    name: requiredString(row, "name"),
    version: requiredNumber(row, "version"),
    lastActivityAt: timestampFromMillis(requiredNumber(row, "last_activity_at")),
    runningCount: 0,
    waitingInputCount: 0,
    ...(nullableString(row, "blocked_reason") !== null ? { blockedReason: nullableString(row, "blocked_reason") } : {})
  });
  return projectSchema.parse({
    ...summary,
    rootPath: requiredString(row, "root_path"),
    workspaceKey: requiredString(row, "workspace_key"),
    rootIdentity: requiredString(row, "root_identity"),
    gitCommonDir: nullableString(row, "git_common_dir"),
    defaultModel: parseModel(nullableString(row, "default_model_json")),
    defaultThinkingLevel: nullableString(row, "default_thinking_level")
  });
}

export class ProjectRepository {
  constructor(private readonly database: DatabaseSync) {}

  create(input: ProjectCreateInput): Project {
    const id = input.id ?? randomUUID();
    const now = input.now ?? Date.now();
    this.database.prepare(`
      INSERT INTO projects(
        id, user_id, name, root_path, workspace_key, root_identity,
        git_common_dir, default_model_json, default_thinking_level, created_at, last_activity_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.userId,
      input.name,
      input.rootPath,
      input.workspaceKey,
      input.rootIdentity,
      input.gitCommonDir ?? null,
      input.defaultModel === undefined || input.defaultModel === null ? null : JSON.stringify(modelRefSchema.parse(input.defaultModel)),
      input.defaultThinkingLevel ?? null,
      now,
      now
    );
    const project = this.get(id);
    if (!project) throw new Error(`project ${id} was not created`);
    return project;
  }

  get(id: string): Project | null {
    const row = this.database.prepare(`
      SELECT p.*,
        (SELECT COUNT(*) FROM sessions s JOIN runs r ON r.session_id = s.id
          WHERE s.project_id = p.id AND r.status IN ('running','waiting_input')) AS running_count,
        (SELECT COUNT(*) FROM sessions s JOIN interactions i ON i.session_id = s.id
          WHERE s.project_id = p.id AND i.status = 'pending') AS waiting_input_count
      FROM projects p WHERE p.id = ?
    `).get(id) as Row | undefined;
    if (!row) return null;
    const project = projectFromRow(row);
    return {
      ...project,
      runningCount: requiredNumber(row, "running_count"),
      waitingInputCount: requiredNumber(row, "waiting_input_count")
    };
  }

  getOwnerId(id: string): string | null {
    const row = this.database.prepare("SELECT user_id FROM projects WHERE id = ?").get(id) as Row | undefined;
    return row ? requiredString(row, "user_id") : null;
  }

  list(userId: string): ProjectSummary[] {
    const rows = this.database.prepare(`
      SELECT p.*,
        (SELECT COUNT(*) FROM sessions s JOIN runs r ON r.session_id = s.id
          WHERE s.project_id = p.id AND r.status IN ('running','waiting_input')) AS running_count,
        (SELECT COUNT(*) FROM sessions s JOIN interactions i ON i.session_id = s.id
          WHERE s.project_id = p.id AND i.status = 'pending') AS waiting_input_count
      FROM projects p WHERE p.user_id = ?
      ORDER BY p.last_activity_at DESC, p.id
    `).all(userId) as Row[];
    return rows.map((row) => projectSummarySchema.parse({
      id: requiredString(row, "id"),
      name: requiredString(row, "name"),
      version: requiredNumber(row, "version"),
      lastActivityAt: timestampFromMillis(requiredNumber(row, "last_activity_at")),
      runningCount: requiredNumber(row, "running_count"),
      waitingInputCount: requiredNumber(row, "waiting_input_count"),
      ...(nullableString(row, "blocked_reason") !== null ? { blockedReason: nullableString(row, "blocked_reason") } : {})
    }));
  }

  findByPhysicalIdentity(rootPath: string, rootIdentity: string): Project | null {
    const row = this.database.prepare(
      "SELECT id FROM projects WHERE root_path = ? OR root_identity = ? ORDER BY id LIMIT 1"
    ).get(rootPath, rootIdentity) as Row | undefined;
    return row ? this.get(requiredString(row, "id")) : null;
  }

  update(input: {
    id: string;
    expectedVersion: number;
    name?: string;
    defaultModel?: ModelRef | null;
    defaultThinkingLevel?: string | null;
    now?: number;
  }): Project | null {
    const current = this.get(input.id);
    if (!current || current.version !== input.expectedVersion) return null;
    const name = input.name ?? current.name;
    const defaultModel = input.defaultModel === undefined ? current.defaultModel : input.defaultModel;
    const defaultThinkingLevel = input.defaultThinkingLevel === undefined
      ? current.defaultThinkingLevel
      : input.defaultThinkingLevel;
    this.database.prepare(`
      UPDATE projects SET name = ?, default_model_json = ?, default_thinking_level = ?,
        version = version + 1, last_activity_at = ?
      WHERE id = ? AND version = ?
    `).run(
      name,
      defaultModel === null ? null : JSON.stringify(modelRefSchema.parse(defaultModel)),
      defaultThinkingLevel,
      input.now ?? Date.now(),
      input.id,
      input.expectedVersion
    );
    return this.get(input.id);
  }

  listPage(
    userId: string,
    before: { lastActivityAt: number; id: string } | null,
    limit: number
  ): ProjectSummary[] {
    const rows = before === null
      ? this.database.prepare(`
          SELECT p.*,
            (SELECT COUNT(*) FROM sessions s JOIN runs r ON r.session_id = s.id
              WHERE s.project_id = p.id AND r.status IN ('running','waiting_input')) AS running_count,
            (SELECT COUNT(*) FROM sessions s JOIN interactions i ON i.session_id = s.id
              WHERE s.project_id = p.id AND i.status = 'pending') AS waiting_input_count
          FROM projects p WHERE p.user_id = ?
          ORDER BY p.last_activity_at DESC, p.id ASC LIMIT ?
        `).all(userId, limit + 1) as Row[]
      : this.database.prepare(`
          SELECT p.*,
            (SELECT COUNT(*) FROM sessions s JOIN runs r ON r.session_id = s.id
              WHERE s.project_id = p.id AND r.status IN ('running','waiting_input')) AS running_count,
            (SELECT COUNT(*) FROM sessions s JOIN interactions i ON i.session_id = s.id
              WHERE s.project_id = p.id AND i.status = 'pending') AS waiting_input_count
          FROM projects p
          WHERE p.user_id = ? AND (p.last_activity_at < ? OR (p.last_activity_at = ? AND p.id > ?))
          ORDER BY p.last_activity_at DESC, p.id ASC LIMIT ?
        `).all(userId, before.lastActivityAt, before.lastActivityAt, before.id, limit + 1) as Row[];
    return rows.map((row) => projectSummarySchema.parse({
      id: requiredString(row, "id"),
      name: requiredString(row, "name"),
      version: requiredNumber(row, "version"),
      lastActivityAt: timestampFromMillis(requiredNumber(row, "last_activity_at")),
      runningCount: requiredNumber(row, "running_count"),
      waitingInputCount: requiredNumber(row, "waiting_input_count"),
      ...(nullableString(row, "blocked_reason") !== null ? { blockedReason: nullableString(row, "blocked_reason") } : {})
    }));
  }
}

export interface SessionCreateInput {
  id?: string;
  projectId: string;
  title: string;
  model?: ModelRef | null;
  thinkingLevel?: string | null;
  piSessionId?: string | null;
  piSessionFile?: string | null;
  piPersistenceState?: "uninitialized" | "unflushed" | "persisted";
  now?: number;
}

export function sessionProjectionFromRow(row: Row): SessionProjection {
  const stored = storedSessionProjection(row);
  return sessionProjectionSchema.parse({
    id: requiredString(row, "id"),
    projectId: requiredString(row, "project_id"),
    title: requiredString(row, "title"),
    version: requiredNumber(row, "version"),
    status: stored.status ?? "idle",
    phase: stored.phase ?? null,
    activeRunId: stored.activeRunId ?? null,
    queuedCount: stored.queuedCount ?? 0,
    queueState: requiredString(row, "queue_state"),
    queueVersion: requiredNumber(row, "queue_version"),
    queuePause: nullableString(row, "queue_pause_run_id") === null
      ? null
      : { runId: requiredString(row, "queue_pause_run_id"), reason: requiredString(row, "queue_pause_reason") },
    piPersistenceState: requiredString(row, "pi_persistence_state"),
    model: parseModel(nullableString(row, "model_json")),
    thinkingLevel: nullableString(row, "thinking_level"),
    historyErrorCode: nullableString(row, "history_error_code"),
    lastActivityAt: timestampFromMillis(requiredNumber(row, "last_activity_at")),
    lastMessagePreview: stored.lastMessagePreview ?? null,
    archivedAt: timestampFromMillis(nullableNumber(row, "archived_at")),
    ...(stored.actualConfig !== undefined ? { actualConfig: stored.actualConfig } : {})
  });
}

export class SessionRepository {
  constructor(private readonly database: DatabaseSync) {}

  create(input: SessionCreateInput): SessionProjection {
    const id = input.id ?? randomUUID();
    const now = input.now ?? Date.now();
    const persistenceState = input.piPersistenceState ?? "uninitialized";
    if ((input.piSessionId === null || input.piSessionFile === null) && persistenceState !== "uninitialized") {
      throw new Error("unflushed or persisted sessions need a pi mapping");
    }
    this.database.prepare(`
      INSERT INTO sessions(
        id, project_id, title, pi_session_id, pi_session_file, pi_persistence_state,
        model_json, thinking_level, created_at, last_activity_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.projectId,
      input.title,
      input.piSessionId ?? null,
      input.piSessionFile ?? null,
      persistenceState,
      input.model === undefined || input.model === null ? null : JSON.stringify(modelRefSchema.parse(input.model)),
      input.thinkingLevel ?? null,
      now,
      now
    );
    const session = this.get(id);
    if (!session) throw new Error(`session ${id} was not created`);
    return session;
  }

  get(id: string): SessionProjection | null {
    const row = this.database.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as Row | undefined;
    return row ? sessionProjectionFromRow(row) : null;
  }

  getRow(id: string): Row | null {
    return (this.database.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as Row | undefined) ?? null;
  }

  /**
   * Persist the SDK mapping before the worker is allowed to execute commands.
   * An unflushed same-ID session may reallocate its missing file path.
   * A persisted mapping is immutable; a native replacement must
   * create/claim a different application Session instead of rebinding the
   * existing history in place.
   */
  setPiMapping(input: {
    id: string;
    piSessionId: string;
    piSessionFile: string;
    persistenceState: "unflushed" | "persisted";
    now?: number;
  }): SessionProjection | null {
    if (!input.piSessionId || !input.piSessionFile) throw new Error("a pi mapping needs an id and file");
    const row = this.getRow(input.id);
    if (!row) return null;
    const existingId = nullableString(row, "pi_session_id");
    const existingFile = nullableString(row, "pi_session_file");
    const existingState = requiredString(row, "pi_persistence_state");
    if (
      (existingId !== null && existingId !== input.piSessionId) ||
      (existingFile !== null && existingFile !== input.piSessionFile &&
        !(existingState === "unflushed" && existingId === input.piSessionId))
    ) {
      throw new Error(`session ${input.id} already has a different pi mapping`);
    }
    if (existingState === "persisted" && input.persistenceState === "unflushed") {
      // A later worker may only confirm a state that is at least as durable
      // as the state already recorded by the parent process.
      return this.get(input.id);
    }
    this.database.prepare(`
      UPDATE sessions
      SET pi_session_id = ?, pi_session_file = ?, pi_persistence_state = ?,
          history_error_code = NULL, last_activity_at = ?
      WHERE id = ?
    `).run(
      input.piSessionId,
      input.piSessionFile,
      input.persistenceState,
      input.now ?? Date.now(),
      input.id
    );
    return this.get(input.id);
  }

  /** Persist the latest app-to-pi rename intent in the same transaction as its event. */
  setPendingTitle(id: string, intent: {
    intentId: string; value: string; version: number; source: "mobile" | "server"; requestedSeq: number;
  }): void {
    const row = this.getRow(id);
    if (!row) throw new Error(`session ${id} does not exist`);
    const live = JSON.parse(requiredString(row, "live_state_json")) as Record<string, unknown>;
    const metadata = live.metadataSync ?? {
      title: { value: requiredString(row, "title"), version: Number(row.version), source: "unknown", eventSeq: Number(row.last_event_seq) },
      pendingTitle: null, lastEchoSeq: null
    };
    this.database.prepare(`
      UPDATE sessions SET live_state_json = json_set(live_state_json, '$.metadataSync', json(?))
      WHERE id = ?
    `).run(JSON.stringify({ ...metadata as Record<string, unknown>, pendingTitle: intent }), id);
  }

  acknowledgeTitle(id: string, intentId: string): void {
    this.database.prepare(`
      UPDATE sessions SET live_state_json = json_set(live_state_json, '$.metadataSync.pendingTitle', json('null'))
      WHERE id = ? AND json_extract(live_state_json, '$.metadataSync.pendingTitle.intentId') = ?
    `).run(id, intentId);
  }

  /** Mark an already mapped Session persisted after the SDK confirms a flush. */
  markPiPersisted(id: string, now = Date.now()): SessionProjection | null {
    const row = this.getRow(id);
    if (!row) return null;
    if (nullableString(row, "pi_session_id") === null || nullableString(row, "pi_session_file") === null) {
      throw new Error(`session ${id} cannot become persisted before its pi mapping is recorded`);
    }
    this.database.prepare(`
      UPDATE sessions SET pi_persistence_state = 'persisted', history_error_code = NULL,
        last_activity_at = ? WHERE id = ?
    `).run(now, id);
    return this.get(id);
  }

  /** Preserve a validated history failure without replacing the original file. */
  setHistoryError(id: string, code: string | null, now = Date.now()): SessionProjection | null {
    if (code !== null && (!code || code.length > 120)) throw new Error("history error code is invalid");
    this.database.prepare(
      "UPDATE sessions SET history_error_code = ?, last_activity_at = ? WHERE id = ?"
    ).run(code, now, id);
    return this.get(id);
  }

  list(projectId: string): SessionProjection[] {
    return (this.database.prepare("SELECT * FROM sessions WHERE project_id = ? ORDER BY last_activity_at DESC, id").all(projectId) as Row[])
      .map(sessionProjectionFromRow);
  }

  listPage(
    projectId: string,
    archived: "exclude" | "only" | "all",
    before: { lastActivityAt: number; id: string } | null,
    limit: number
  ): SessionProjection[] {
    const archivedClause = archived === "exclude"
      ? " AND archived_at IS NULL"
      : archived === "only"
        ? " AND archived_at IS NOT NULL"
        : "";
    const cursorClause = before === null
      ? ""
      : " AND (last_activity_at < ? OR (last_activity_at = ? AND id > ?))";
    const sql = `
      SELECT * FROM sessions
      WHERE project_id = ?${archivedClause}${cursorClause}
      ORDER BY last_activity_at DESC, id ASC LIMIT ?
    `;
    const rows = before === null
      ? this.database.prepare(sql).all(projectId, limit + 1) as Row[]
      : this.database.prepare(sql).all(projectId, before.lastActivityAt, before.lastActivityAt, before.id, limit + 1) as Row[];
    return rows.map(sessionProjectionFromRow);
  }
}

export interface CommandCreateInput {
  id?: string;
  userId: string;
  deviceId: string;
  sessionId?: string | null;
  scope: string;
  clientCommandId: string;
  kind: string;
  payload: unknown;
  state?: "queued" | "dispatching" | "accepted" | "completed" | "failed" | "cancelled" | "unknown";
  targetRunId?: string | null;
  now?: number;
}

export class CommandRepository {
  constructor(private readonly database: DatabaseSync) {}

  create(input: CommandCreateInput): string {
    const id = input.id ?? randomUUID();
    const now = input.now ?? Date.now();
    const payloadJson = stableJsonStringify(input.payload);
    const payloadHash = createHash("sha256").update(payloadJson).digest("hex");
    const device = this.database.prepare("SELECT user_id, revoked_at FROM devices WHERE id = ?").get(input.deviceId) as Row | undefined;
    if (
      !device ||
      device.user_id !== input.userId ||
      (device.revoked_at !== null && device.revoked_at !== undefined)
    ) throw new Error("command device is not active for command owner");
    if (input.sessionId !== undefined && input.sessionId !== null) {
      assertSessionOwner(this.database, input.sessionId, input.userId);
    }
    const state = input.state ?? "queued";
    this.database.prepare(`
      INSERT INTO commands(
        id, user_id, device_id, session_id, scope, client_command_id, kind,
        payload_hash, payload_json, state, target_run_id, created_at, finished_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.userId,
      input.deviceId,
      input.sessionId ?? null,
      input.scope,
      input.clientCommandId,
      input.kind,
      payloadHash,
      payloadJson,
      state,
      input.targetRunId ?? null,
      now,
      ["completed", "failed", "cancelled", "unknown"].includes(state) ? now : null
    );
    return id;
  }

  getByIdempotency(userId: string, scope: string, clientCommandId: string): StoredCommandRecord | null {
    const row = this.database.prepare(
      "SELECT * FROM commands WHERE user_id = ? AND scope = ? AND client_command_id = ?"
    ).get(userId, scope, clientCommandId) as Row | undefined;
    return row ? commandRecordFromRow(this.database, row) : null;
  }

  get(id: string): StoredCommandRecord | null {
    const row = this.database.prepare("SELECT * FROM commands WHERE id = ?").get(id) as Row | undefined;
    return row ? commandRecordFromRow(this.database, row) : null;
  }

  completeInitialResponse(id: string, status: number, response: unknown, now = Date.now()): void {
    this.recordInitialResponse(id, status, response, now, true);
  }

  /** Save the original HTTP receipt without moving an async command to a terminal state. */
  recordInitialResponse(id: string, status: number, response: unknown, now = Date.now(), terminal = false): void {
    this.database.prepare(`
      UPDATE commands SET
        state = CASE WHEN ? THEN 'completed' ELSE state END,
        response_status = ?, response_json = ?,
        finished_at = CASE WHEN ? THEN COALESCE(finished_at, ?) ELSE finished_at END
      WHERE id = ? AND response_status IS NULL
    `).run(terminal ? 1 : 0, status, stableJsonStringify(response), terminal ? 1 : 0, now, id);
  }

  /** Store dispatch metadata separately from the event-sourced command state. */
  markDispatched(id: string, workerEpoch: string, now = Date.now()): void {
    this.database.prepare(`
      UPDATE commands SET worker_epoch = ?, dispatched_at = COALESCE(dispatched_at, ?)
      WHERE id = ?
    `).run(workerEpoch, now, id);
  }

  markAccepted(id: string, workerEpoch: string, now = Date.now()): void {
    this.database.prepare(`
      UPDATE commands SET worker_epoch = COALESCE(worker_epoch, ?),
        accepted_at = COALESCE(accepted_at, ?)
      WHERE id = ?
    `).run(workerEpoch, now, id);
  }

  markFinished(id: string, now = Date.now()): void {
    this.database.prepare(
      "UPDATE commands SET finished_at = COALESCE(finished_at, ?) WHERE id = ?"
    ).run(now, id);
  }
}

export interface StoredInteractionRecord {
  interactionId: string;
  sessionId: string;
  operationId: string;
  origin: string;
  runId: string | null;
  commandId: string | null;
  workerEpoch: string;
  kind: "select" | "confirm" | "input" | "editor";
  payload: Record<string, unknown>;
  status: "pending" | "resolved" | "cancelled" | "expired";
  response: Record<string, unknown> | null;
  responseCommandId: string | null;
  expiresAt: number | null;
}

function interactionRecordFromRow(row: Row): StoredInteractionRecord {
  const payload = parseStoredJson(nullableString(row, "payload_json"));
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("stored interaction payload is not an object");
  }
  const response = parseStoredJson(nullableString(row, "response_json"));
  if (response !== null && (typeof response !== "object" || Array.isArray(response))) {
    throw new Error("stored interaction response is not an object");
  }
  const kind = requiredString(row, "kind");
  if (kind !== "select" && kind !== "confirm" && kind !== "input" && kind !== "editor") {
    throw new Error(`stored interaction kind ${kind} is invalid`);
  }
  const status = requiredString(row, "status");
  if (status !== "pending" && status !== "resolved" && status !== "cancelled" && status !== "expired") {
    throw new Error(`stored interaction status ${status} is invalid`);
  }
  return {
    interactionId: requiredString(row, "id"),
    sessionId: requiredString(row, "session_id"),
    operationId: requiredString(row, "operation_id"),
    origin: requiredString(row, "origin"),
    runId: nullableString(row, "run_id"),
    commandId: nullableString(row, "command_id"),
    workerEpoch: requiredString(row, "worker_epoch"),
    kind,
    payload: payload as Record<string, unknown>,
    status,
    response: response as Record<string, unknown> | null,
    responseCommandId: nullableString(row, "response_command_id"),
    expiresAt: nullableNumber(row, "expires_at")
  };
}

export type InteractionClaimResult =
  | { status: "claimed"; interaction: StoredInteractionRecord }
  | { status: "not_found" }
  | { status: "closed"; interaction: StoredInteractionRecord }
  | { status: "mismatch"; interaction: StoredInteractionRecord }
  | { status: "expired"; interaction: StoredInteractionRecord };

export class InteractionRepository {
  constructor(private readonly database: DatabaseSync) {}

  get(sessionId: string, interactionId: string): StoredInteractionRecord | null {
    const row = this.database.prepare(
      "SELECT * FROM interactions WHERE session_id = ? AND id = ?"
    ).get(sessionId, interactionId) as Row | undefined;
    return row ? interactionRecordFromRow(row) : null;
  }

  /**
   * Claim the one response delivery slot. The worker epoch is part of the
   * compare-and-set so a response for an old worker cannot reach a new one.
   */
  claimResponse(input: {
    sessionId: string;
    interactionId: string;
    operationId: string;
    workerEpoch: string;
    responseCommandId: string;
    now?: number;
  }): InteractionClaimResult {
    const current = this.get(input.sessionId, input.interactionId);
    if (!current) return { status: "not_found" };
    if (current.status !== "pending" || current.responseCommandId !== null) {
      return { status: "closed", interaction: current };
    }
    if (current.expiresAt !== null && current.expiresAt <= (input.now ?? Date.now())) {
      return { status: "expired", interaction: current };
    }
    if (current.operationId !== input.operationId || current.workerEpoch !== input.workerEpoch) {
      return { status: "mismatch", interaction: current };
    }
    const result = this.database.prepare(`
      UPDATE interactions SET response_command_id = ?
      WHERE id = ? AND session_id = ? AND status = 'pending'
        AND response_command_id IS NULL AND operation_id = ? AND worker_epoch = ?
        AND (expires_at IS NULL OR expires_at > ?)
    `).run(
      input.responseCommandId,
      input.interactionId,
      input.sessionId,
      input.operationId,
      input.workerEpoch,
      input.now ?? Date.now()
    );
    if (Number(result.changes) !== 1) {
      const after = this.get(input.sessionId, input.interactionId);
      return after ? { status: "closed", interaction: after } : { status: "not_found" };
    }
    const claimed = this.get(input.sessionId, input.interactionId);
    if (!claimed) return { status: "not_found" };
    return { status: "claimed", interaction: claimed };
  }

  clearResponseClaim(sessionId: string, interactionId: string, responseCommandId: string): void {
    this.database.prepare(`
      UPDATE interactions SET response_command_id = NULL
      WHERE session_id = ? AND id = ? AND response_command_id = ? AND status = 'pending'
    `).run(sessionId, interactionId, responseCommandId);
  }
}

export interface RunRuntimeMetadata {
  runId: string;
  workerEpoch: string;
  workerPid?: number | null;
  workerStartTicks?: string | null;
  processGroupId?: number | null;
  executionScopeKey?: string | null;
  startedAt?: number | null;
}

/** Persist process identity diagnostics used by crash recovery and operator tooling. */
export function updateRunRuntimeMetadata(database: DatabaseSync, input: RunRuntimeMetadata): void {
  if (!input.workerEpoch) throw new Error("run runtime metadata needs a worker epoch");
  if (input.workerPid !== undefined && input.workerPid !== null && !Number.isSafeInteger(input.workerPid)) {
    throw new Error("worker pid must be a safe integer");
  }
  if (input.processGroupId !== undefined && input.processGroupId !== null && !Number.isSafeInteger(input.processGroupId)) {
    throw new Error("process group id must be a safe integer");
  }
  database.prepare(`
    UPDATE runs SET worker_epoch = ?, worker_pid = ?, worker_start_ticks = ?,
      process_group_id = ?, execution_scope_key = COALESCE(?, execution_scope_key),
      started_at = COALESCE(started_at, ?)
    WHERE id = ?
  `).run(
    input.workerEpoch,
    input.workerPid ?? null,
    input.workerStartTicks ?? null,
    input.processGroupId ?? null,
    input.executionScopeKey ?? null,
    input.startedAt ?? null,
    input.runId
  );
}

export interface StoredCommandRecord {
  commandId: string;
  userId: string;
  deviceId: string;
  sessionId: string | null;
  scope: string;
  clientCommandId: string;
  kind: string;
  payloadHash: string;
  payload: unknown;
  state: string;
  targetRunId: string | null;
  responseStatus: number | null;
  response: unknown | null;
  result: Record<string, unknown> | null;
  errorCode: string | null;
  runs: Array<{ runId: string; sessionId: string }>;
}

function parseStoredJson(value: string | null): unknown | null {
  if (value === null) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(`invalid stored command JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

function commandRecordFromRow(database: DatabaseSync, row: Row): StoredCommandRecord {
  const result = parseStoredJson(nullableString(row, "result_json"));
  if (result !== null && (typeof result !== "object" || Array.isArray(result))) {
    throw new Error("stored command result is not an object");
  }
  const runs = (database.prepare(
    "SELECT id, session_id FROM runs WHERE command_id = ? ORDER BY created_at ASC, id ASC"
  ).all(requiredString(row, "id")) as Row[]).map((run) => ({
    runId: requiredString(run, "id"),
    sessionId: requiredString(run, "session_id")
  }));
  return {
    commandId: requiredString(row, "id"),
    userId: requiredString(row, "user_id"),
    deviceId: requiredString(row, "device_id"),
    sessionId: nullableString(row, "session_id"),
    scope: requiredString(row, "scope"),
    clientCommandId: requiredString(row, "client_command_id"),
    kind: requiredString(row, "kind"),
    payloadHash: requiredString(row, "payload_hash"),
    payload: parseStoredJson(requiredString(row, "payload_json")),
    state: requiredString(row, "state"),
    targetRunId: nullableString(row, "target_run_id"),
    responseStatus: nullableNumber(row, "response_status"),
    response: parseStoredJson(nullableString(row, "response_json")),
    result: result as Record<string, unknown> | null,
    errorCode: nullableString(row, "error_code"),
    runs
  };
}

export function validateArtifactRelativePath(relativePath: string): string {
  if (!relativePath || relativePath.includes("\\") || relativePath.includes("\0") || relativePath.startsWith("/") || /^[A-Za-z]:/.test(relativePath)) {
    throw new Error("artifact path must be a relative POSIX path");
  }
  const parts = relativePath.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new Error("artifact path contains an unsafe segment");
  }
  return parts.join("/");
}

export class ArtifactRepository {
  constructor(private readonly database: DatabaseSync) {}

  private fromRow(row: Row): ArtifactRecord {
    return {
      id: requiredString(row, "id"),
      sessionId: requiredString(row, "session_id"),
      runId: nullableString(row, "run_id"),
      relativePath: validateArtifactRelativePath(requiredString(row, "relative_path")),
      mimeType: requiredString(row, "mime_type"),
      sizeBytes: requiredNumber(row, "size_bytes"),
      sha256: requiredString(row, "sha256"),
      createdAt: requiredNumber(row, "created_at")
    };
  }

  create(input: {
    id?: string;
    sessionId: string;
    runId?: string | null;
    relativePath: string;
    mimeType: string;
    sizeBytes: number;
    sha256: string;
    now?: number;
  }): string {
    const id = input.id ?? randomUUID();
    const relativePath = validateArtifactRelativePath(input.relativePath);
    if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0) {
      throw new Error("artifact size must be a non-negative safe integer");
    }
    if (!/^[a-f0-9]{64}$/.test(input.sha256)) throw new Error("artifact sha256 must be lowercase hex");
    this.database.prepare(`
      INSERT INTO artifacts(id, session_id, run_id, relative_path, mime_type, size_bytes, sha256, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, input.sessionId, input.runId ?? null, relativePath, input.mimeType, input.sizeBytes, input.sha256, input.now ?? Date.now());
    return id;
  }

  get(id: string): ArtifactRecord | null {
    const row = this.database.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as Row | undefined;
    return row ? this.fromRow(row) : null;
  }

  findByHash(sessionId: string, sha256: string): ArtifactRecord | null {
    const row = this.database.prepare(
      "SELECT * FROM artifacts WHERE session_id = ? AND sha256 = ? ORDER BY created_at ASC, id ASC LIMIT 1"
    ).get(sessionId, sha256) as Row | undefined;
    return row ? this.fromRow(row) : null;
  }

  totalBytes(sessionId: string): number {
    const row = this.database.prepare(
      "SELECT COALESCE(SUM(size_bytes), 0) AS total_bytes FROM artifacts WHERE session_id = ?"
    ).get(sessionId) as Row | undefined;
    return row ? requiredNumber(row, "total_bytes") : 0;
  }
}

export interface ArtifactRecord {
  id: string;
  sessionId: string;
  runId: string | null;
  relativePath: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  createdAt: number;
}
