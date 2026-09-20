import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  projectCreateRequestSchema,
  historyImportRequestSchema,
  recoverableHistoriesResponseSchema,
  projectMutationResponseSchema,
  projectPatchRequestSchema,
  projectsResponseSchema,
  sessionCreateRequestSchema,
  sessionMutationResponseSchema,
  sessionPatchRequestSchema,
  sessionsResponseSchema,
  snapshotSchema
} from "@pi-remote/protocol";
import type {
  Project,
  ProjectSummary,
  SessionProjection,
  Snapshot,
  ModelInfo
} from "@pi-remote/protocol";
import type { AuthContext, AuthService } from "../auth.js";
import type { WorkerManager } from "../runtime/manager.js";
import { withTransaction } from "../storage/database.js";
import {
  CommandRepository,
  EventStore,
  ProjectRepository,
  SessionRepository,
  readEvents,
  readHistory,
  readSnapshot,
  stableJsonStringify
} from "../storage/index.js";
import { InvalidCursorError, decodeListCursor, encodeListCursor } from "./cursors.js";
import { InvalidProjectPathError, ProjectPathService } from "./project-path.js";
import { SUPPORTED_COMMANDS } from "./commands.js";
import { discoverNativeHistory } from "./native-history.js";

export interface MutationResult {
  status: number;
  body: unknown;
}

export class ResourceServiceError extends Error {
  constructor(
    public readonly code:
      | "NOT_FOUND"
      | "IDEMPOTENCY_CONFLICT"
      | "VERSION_CONFLICT"
      | "INVALID_CURSOR"
      | "INVALID_PROJECT_PATH"
      | "INVALID_REQUEST"
      | "STORAGE_UNAVAILABLE",
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "ResourceServiceError";
  }
}

const INTERNAL_MUTATION_KINDS = {
  projectCreate: "project_create",
  projectPatch: "project_patch",
  sessionCreate: "session_create",
  sessionPatch: "session_patch",
  deviceRevoke: "device_revoke"
} as const;

function mutationHash(payload: unknown): string {
  return createHash("sha256").update(stableJsonStringify(payload)).digest("hex");
}

function responseStatus(status: number, body: unknown): MutationResult {
  return { status, body: JSON.parse(stableJsonStringify(body)) as unknown };
}

function parseStoredResponse(value: unknown | null): unknown {
  if (value === null) throw new ResourceServiceError("STORAGE_UNAVAILABLE", "stored mutation response is unavailable");
  return value;
}

function timestampMillis(timestamp: string | null): number {
  if (timestamp === null) throw new ResourceServiceError("STORAGE_UNAVAILABLE", "stored activity timestamp is unavailable");
  const result = Date.parse(timestamp);
  if (!Number.isSafeInteger(result)) throw new ResourceServiceError("STORAGE_UNAVAILABLE", "stored activity timestamp is invalid");
  return result;
}

export class ResourceService {
  private readonly projects: ProjectRepository;
  private readonly sessions: SessionRepository;
  private readonly commands: CommandRepository;
  private readonly pathService: ProjectPathService;
  private readonly now: () => number;
  private readonly manager: WorkerManager | undefined;
  private readonly nativeHistoryRoot: string | undefined;

  constructor(
    private readonly database: DatabaseSync,
    private readonly auth: AuthService,
    options: { workspaceRoot: string; cursorSecret: string; now?: () => number; manager?: WorkerManager; nativeHistoryRoot?: string }
  ) {
    this.projects = new ProjectRepository(database);
    this.sessions = new SessionRepository(database);
    this.commands = new CommandRepository(database);
    this.pathService = new ProjectPathService([options.workspaceRoot]);
    this.cursorSecret = options.cursorSecret;
    this.now = options.now ?? (() => Date.now());
    this.manager = options.manager;
    this.nativeHistoryRoot = options.nativeHistoryRoot;
  }

  private readonly cursorSecret: string;

  private replay(
    actor: AuthContext,
    scope: string,
    idempotencyKey: string,
    payload: unknown
  ): MutationResult | null {
    const record = this.commands.getByIdempotency(actor.userId, scope, idempotencyKey);
    if (!record) return null;
    if (record.payloadHash !== mutationHash(payload)) {
      throw new ResourceServiceError("IDEMPOTENCY_CONFLICT", "idempotency key was used with a different request");
    }
    if (record.responseStatus === null) {
      throw new ResourceServiceError("STORAGE_UNAVAILABLE", "stored mutation response is unavailable");
    }
    return responseStatus(record.responseStatus, parseStoredResponse(record.response));
  }

  private createMutationCommand(
    actor: AuthContext,
    input: {
      scope: string;
      idempotencyKey: string;
      kind: string;
      payload: unknown;
      sessionId?: string | null;
    }
  ): string {
    return this.commands.create({
      userId: actor.userId,
      deviceId: actor.deviceId,
      sessionId: input.sessionId ?? null,
      scope: input.scope,
      clientCommandId: input.idempotencyKey,
      kind: input.kind,
      payload: input.payload,
      state: "completed",
      now: this.now()
    });
  }

  private complete(commandId: string, status: number, body: unknown): void {
    this.commands.completeInitialResponse(commandId, status, body, this.now());
  }

  async createProject(
    actor: AuthContext,
    requestBody: unknown,
    idempotencyKey: string
  ): Promise<MutationResult> {
    const body = projectCreateRequestSchema.parse(requestBody);
    const scope = "POST:/v1/projects";
    const replay = this.replay(actor, scope, idempotencyKey, body);
    if (replay) return replay;
    let location;
    try {
      location = await this.pathService.validate(body.rootPath);
    } catch (error) {
      if (error instanceof InvalidProjectPathError) {
        throw new ResourceServiceError("INVALID_PROJECT_PATH", error.message);
      }
      throw error;
    }
    return withTransaction(this.database, () => {
      const retry = this.replay(actor, scope, idempotencyKey, body);
      if (retry) return retry;
      const existing = this.projects.findByPhysicalIdentity(location.rootPath, location.rootIdentity);
      if (existing) {
        if (this.projects.getOwnerId(existing.id) !== actor.userId) {
          throw new ResourceServiceError("NOT_FOUND", "project was not found");
        }
        const commandId = this.createMutationCommand(actor, {
          scope,
          idempotencyKey,
          kind: INTERNAL_MUTATION_KINDS.projectCreate,
          payload: body
        });
        const response = projectMutationResponseSchema.parse({ project: existing, commandId });
        this.complete(commandId, 200, response);
        return responseStatus(200, response);
      }
      const project = new ProjectRepository(this.database).create({
        userId: actor.userId,
        name: body.name,
        rootPath: location.rootPath,
        workspaceKey: location.workspaceKey,
        rootIdentity: location.rootIdentity,
        gitCommonDir: location.gitCommonDir,
        defaultModel: body.defaultModel,
        defaultThinkingLevel: body.defaultThinkingLevel,
        now: this.now()
      });
      const commandId = this.createMutationCommand(actor, {
        scope,
        idempotencyKey,
        kind: INTERNAL_MUTATION_KINDS.projectCreate,
        payload: body
      });
      const response = projectMutationResponseSchema.parse({ project, commandId });
      this.complete(commandId, 201, response);
      return responseStatus(201, response);
    });
  }

  patchProject(
    actor: AuthContext,
    projectId: string,
    requestBody: unknown,
    idempotencyKey: string
  ): MutationResult {
    const body = projectPatchRequestSchema.parse(requestBody);
    const scope = "PATCH:/v1/projects/" + projectId;
    const replay = this.replay(actor, scope, idempotencyKey, body);
    if (replay) return replay;
    this.requireProject(actor.userId, projectId);
    const result = withTransaction(this.database, () => {
      const retry = this.replay(actor, scope, idempotencyKey, body);
      if (retry) return retry;
      const project = this.requireProject(actor.userId, projectId);
      if (project.version !== body.expectedVersion) {
        throw new ResourceServiceError("VERSION_CONFLICT", "project version is stale", {
          currentVersion: project.version
        });
      }
      const updated = this.projects.update({
        id: projectId,
        expectedVersion: body.expectedVersion,
        name: body.name,
        defaultModel: body.defaultModel,
        defaultThinkingLevel: body.defaultThinkingLevel,
        now: this.now()
      });
      if (!updated) {
        const current = this.requireProject(actor.userId, projectId);
        throw new ResourceServiceError("VERSION_CONFLICT", "project version is stale", {
          currentVersion: current.version
        });
      }
      const commandId = this.createMutationCommand(actor, {
        scope,
        idempotencyKey,
        kind: INTERNAL_MUTATION_KINDS.projectPatch,
        payload: body
      });
      const response = projectMutationResponseSchema.parse({ project: updated, commandId });
      this.complete(commandId, 200, response);
      return responseStatus(200, response);
    });
    return result;
  }

  async createSession(
    actor: AuthContext,
    projectId: string,
    requestBody: unknown,
    idempotencyKey: string
  ): Promise<MutationResult> {
    const body = sessionCreateRequestSchema.parse(requestBody);
    const scope = "POST:/v1/projects/" + projectId + "/sessions";
    const replay = this.replay(actor, scope, idempotencyKey, body);
    if (replay) return replay;
    this.requireProject(actor.userId, projectId);
    return withTransaction(this.database, () => {
      const retry = this.replay(actor, scope, idempotencyKey, body);
      if (retry) return retry;
      const project = this.requireProject(actor.userId, projectId);
      const session = this.sessions.create({
        projectId,
        title: body.title ?? "新会话",
        model: body.model === undefined ? project.defaultModel : body.model,
        thinkingLevel: body.thinkingLevel === undefined ? project.defaultThinkingLevel : body.thinkingLevel,
        now: this.now()
      });
      this.database.prepare(
        "UPDATE projects SET last_activity_at = CASE WHEN last_activity_at < ? THEN ? ELSE last_activity_at END WHERE id = ?"
      ).run(this.now(), this.now(), projectId);
      const commandId = this.createMutationCommand(actor, {
        scope,
        idempotencyKey,
        kind: INTERNAL_MUTATION_KINDS.sessionCreate,
        payload: body,
        sessionId: session.id
      });
      const response = sessionMutationResponseSchema.parse({ session, commandId });
      this.complete(commandId, 201, response);
      return responseStatus(201, response);
    });
  }

  async listRecoverableHistory(actor: AuthContext, projectId: string) {
    const project = this.requireProject(actor.userId, projectId);
    if (!this.nativeHistoryRoot) return { items: [] };
    const candidates = await discoverNativeHistory(this.nativeHistoryRoot, project.rootPath, projectId, this.cursorSecret);
    this.requireProject(actor.userId, projectId);
    return recoverableHistoriesResponseSchema.parse({ items: candidates.filter(candidate =>
      !this.database.prepare("SELECT id FROM sessions WHERE pi_session_id = ? OR pi_session_file = ?").get(candidate.nativeId, candidate.path))
      .map(({ candidateId, filename, title, modifiedAt, entryCount }) => ({ candidateId, filename, title, modifiedAt, entryCount })) });
  }

  async importHistory(actor: AuthContext, projectId: string, requestBody: unknown, idempotencyKey: string): Promise<MutationResult> {
    const project = this.requireProject(actor.userId, projectId);
    const body = historyImportRequestSchema.parse(requestBody);
    const scope = `POST:/v1/projects/${projectId}/history-imports`;
    const replay = this.replay(actor, scope, idempotencyKey, body);
    if (replay) return replay;
    if (!this.nativeHistoryRoot) throw new ResourceServiceError("NOT_FOUND", "history discovery is unavailable");
    const candidates = await discoverNativeHistory(this.nativeHistoryRoot, project.rootPath, projectId, this.cursorSecret);
    const candidate = candidates.find(item => item.candidateId === body.candidateId);
    if (!candidate) throw new ResourceServiceError("NOT_FOUND", "history is missing, changed, invalid or belongs to another project; refresh the list");
    return withTransaction(this.database, () => {
      this.requireProject(actor.userId, projectId);
      const retry = this.replay(actor, scope, idempotencyKey, body);
      if (retry) return retry;
      if (this.manager?.hasPendingNativeReplacement(projectId)) throw new ResourceServiceError("VERSION_CONFLICT", "native session replacement is still in progress; retry after it finishes");
      const existing = this.database.prepare("SELECT id, project_id, pi_session_id, pi_session_file FROM sessions WHERE pi_session_id = ? OR pi_session_file = ?").all(candidate.nativeId, candidate.path);
      if (existing.length && (existing.length !== 1 || existing[0]!.project_id !== projectId || existing[0]!.pi_session_id !== candidate.nativeId || existing[0]!.pi_session_file !== candidate.path)) {
        throw new ResourceServiceError("VERSION_CONFLICT", "history already has another mapping");
      }
      const session = existing.length ? this.sessions.get(String(existing[0]!.id))! : this.sessions.create({
        projectId, title: candidate.title, piSessionId: candidate.nativeId, piSessionFile: candidate.path,
        piPersistenceState: "persisted", now: this.now()
      });
      const commandId = this.createMutationCommand(actor, { scope, idempotencyKey, kind: "history_import", payload: body, sessionId: session.id });
      this.database.prepare("UPDATE projects SET last_activity_at = MAX(last_activity_at, ?) WHERE id = ?").run(this.now(), projectId);
      const response = sessionMutationResponseSchema.parse({ session, commandId });
      const status = existing.length ? 200 : 201;
      this.complete(commandId, status, response);
      return responseStatus(status, response);
    });
  }

  patchSession(
    actor: AuthContext,
    sessionId: string,
    requestBody: unknown,
    idempotencyKey: string
  ): MutationResult {
    const body = sessionPatchRequestSchema.parse(requestBody);
    const scope = "PATCH:/v1/sessions/" + sessionId;
    const replay = this.replay(actor, scope, idempotencyKey, body);
    if (replay) return replay;
    this.requireSession(actor.userId, sessionId);
    const result = withTransaction(this.database, () => {
      const retry = this.replay(actor, scope, idempotencyKey, body);
      if (retry) return retry;
      const current = this.requireSession(actor.userId, sessionId);
      if (current.version !== body.expectedVersion) {
        throw new ResourceServiceError("VERSION_CONFLICT", "session version is stale", {
          currentVersion: current.version
        });
      }
      const now = this.now();
      const changes: {
        title?: string;
        version: number;
        archived?: boolean;
        archivedAt?: string | null;
      } = { version: current.version + 1 };
      if (body.title !== undefined) changes.title = body.title;
      if (body.archived !== undefined) {
        changes.archived = body.archived;
        changes.archivedAt = body.archived ? new Date(now).toISOString() : null;
      }
      const commandId = this.createMutationCommand(actor, {
        scope,
        idempotencyKey,
        kind: INTERNAL_MUTATION_KINDS.sessionPatch,
        payload: body,
        sessionId
      });
      const eventStore = new EventStore(this.database, {
        commandActor: { userId: actor.userId, deviceId: actor.deviceId },
        now: () => now
      });
      eventStore.appendBatchWithinTransaction({
        sessionId,
        workerEpoch: "server-" + randomUUID(),
        batchNo: 1,
        events: [{
          schemaVersion: 1,
          sessionId,
          seq: 1,
          runId: null,
          operationId: null,
          type: "session.updated",
          timestamp: new Date(now).toISOString(),
          payload: { changes }
        }]
      });
      const session = this.requireSession(actor.userId, sessionId);
      if (body.title !== undefined) {
        this.sessions.setPendingTitle(sessionId, {
          intentId: commandId, value: body.title, version: session.version,
          source: "mobile", requestedSeq: Number(this.sessions.getRow(sessionId)?.last_event_seq ?? 0)
        });
      }
      const response = sessionMutationResponseSchema.parse({ session, commandId });
      this.complete(commandId, 200, response);
      return responseStatus(200, response);
    });
    if (body.title !== undefined) this.manager?.notifyRename(sessionId, body.title);
    return result;
  }

  listProjects(actor: AuthContext, cursor: string | null, limit: number): { items: ProjectSummary[]; nextCursor: string | null } {
    let before: { lastActivityAt: number; id: string } | null = null;
    if (cursor !== null) {
      const decoded = this.decodeCursor(cursor);
      if (decoded.kind !== "projects" || decoded.ownerId !== actor.userId || decoded.scope !== "projects") {
        throw new ResourceServiceError("INVALID_CURSOR", "invalid project cursor");
      }
      before = { lastActivityAt: decoded.lastActivityAt, id: decoded.id };
    }
    const rows = this.projects.listPage(actor.userId, before, limit);
    const items = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    const last = items.at(-1);
    const nextCursor = hasMore && last
      ? encodeListCursor({
          kind: "projects",
          ownerId: actor.userId,
          scope: "projects",
          lastActivityAt: timestampMillis(last.lastActivityAt),
          id: last.id
        }, this.cursorSecret)
      : null;
    return projectsResponseSchema.parse({ items, nextCursor });
  }

  listSessions(
    actor: AuthContext,
    projectId: string,
    archived: "exclude" | "only" | "all",
    cursor: string | null,
    limit: number
  ): { items: SessionProjection[]; nextCursor: string | null } {
    this.requireProject(actor.userId, projectId);
    const scope = projectId + "|" + archived;
    let before: { lastActivityAt: number; id: string } | null = null;
    if (cursor !== null) {
      const decoded = this.decodeCursor(cursor);
      if (decoded.kind !== "sessions" || decoded.ownerId !== actor.userId || decoded.scope !== scope) {
        throw new ResourceServiceError("INVALID_CURSOR", "invalid session cursor");
      }
      before = { lastActivityAt: decoded.lastActivityAt, id: decoded.id };
    }
    const rows = this.sessions.listPage(projectId, archived, before, limit);
    const items = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    const last = items.at(-1);
    const nextCursor = hasMore && last
      ? encodeListCursor({
          kind: "sessions",
          ownerId: actor.userId,
          scope,
          lastActivityAt: timestampMillis(last.lastActivityAt),
          id: last.id
        }, this.cursorSecret)
      : null;
    return sessionsResponseSchema.parse({ items, nextCursor });
  }

  getProject(actor: AuthContext, projectId: string): Project {
    return this.requireProject(actor.userId, projectId);
  }

  getSession(actor: AuthContext, sessionId: string): SessionProjection {
    return this.requireSession(actor.userId, sessionId);
  }

  async setEditorState(actor: AuthContext, sessionId: string, text: string): Promise<void> {
    this.requireSession(actor.userId, sessionId);
    if (!this.manager) throw new ResourceServiceError("STORAGE_UNAVAILABLE", "editor runtime is unavailable");
    await this.manager.setEditorState(sessionId, text);
  }

  async getModels(actor: AuthContext, sessionId?: string, refresh = false): Promise<{ items: ModelInfo[] }> {
    if (sessionId) this.requireSession(actor.userId, sessionId);
    if (!this.manager) throw new ResourceServiceError("STORAGE_UNAVAILABLE", "model runtime is unavailable");
    if (sessionId) return { items: (await this.manager.getModels(sessionId, refresh)).items };
    return { items: await this.manager.modelCatalog() };
  }

  async getSnapshot(actor: AuthContext, sessionId: string): Promise<Snapshot> {
    const session = this.requireSession(actor.userId, sessionId);
    let levels = this.manager?.availableThinkingLevels(sessionId) ?? [];
    if (levels.length === 0 && session.model && this.manager) {
      const models = await this.manager.modelCatalog();
      levels = models.find((item) => item.model.provider === session.model!.provider && item.model.id === session.model!.id)?.thinkingLevels ?? [];
    }
    return snapshotSchema.parse(readSnapshot(this.database, sessionId, {
      historyCursor: null,
      availableThinkingLevels: levels,
      allowedCommands: [...SUPPORTED_COMMANDS]
    }));
  }

  getHistory(actor: AuthContext, sessionId: string, cursor: string | null, limit: number): unknown {
    this.requireSession(actor.userId, sessionId);
    try {
      return readHistory(this.database, sessionId, cursor, limit, this.cursorSecret);
    } catch (error) {
      if (cursor !== null) throw new ResourceServiceError("INVALID_CURSOR", "invalid history cursor");
      throw error;
    }
  }

  getEvents(actor: AuthContext, sessionId: string, afterSeq: number, limit: number): unknown {
    this.requireSession(actor.userId, sessionId);
    try {
      return readEvents(this.database, sessionId, afterSeq, limit);
    } catch (error) {
      if (error instanceof Error && error.message.includes("above the session high-water")) {
        throw new ResourceServiceError("INVALID_REQUEST", "afterSeq is above the session high-water mark");
      }
      throw error;
    }
  }

  getCommand(actor: AuthContext, commandId: string): Record<string, unknown> {
    const record = this.commands.get(commandId);
    if (!record || record.userId !== actor.userId) {
      throw new ResourceServiceError("NOT_FOUND", "command was not found");
    }
    const result: Record<string, unknown> = {
      commandId: record.commandId,
      kind: record.kind,
      state: record.state,
      runs: record.runs
    };
    if (record.targetRunId !== null) result.targetRunId = record.targetRunId;
    if (record.errorCode !== null) result.error = { code: record.errorCode };
    if (record.result !== null) result.result = record.result;
    return result;
  }

  revokeDevice(actor: AuthContext, deviceId: string, idempotencyKey: string): MutationResult {
    const payload = { deviceId };
    const scope = "DELETE:/v1/devices/" + deviceId;
    const replay = this.replay(actor, scope, idempotencyKey, payload);
    if (replay) return replay;
    return withTransaction(this.database, () => {
      const retry = this.replay(actor, scope, idempotencyKey, payload);
      if (retry) return retry;
      const revoked = this.auth.revokeDevice(actor.userId, deviceId);
      if (!revoked) throw new ResourceServiceError("NOT_FOUND", "device was not found");
      const commandId = this.createMutationCommand(actor, {
        scope,
        idempotencyKey,
        kind: INTERNAL_MUTATION_KINDS.deviceRevoke,
        payload
      });
      this.complete(commandId, 200, revoked);
      return responseStatus(200, revoked);
    });
  }

  private decodeCursor(cursor: string): ReturnType<typeof decodeListCursor> {
    try {
      return decodeListCursor(cursor, this.cursorSecret);
    } catch (error) {
      if (error instanceof InvalidCursorError) {
        throw new ResourceServiceError("INVALID_CURSOR", "invalid list cursor");
      }
      throw error;
    }
  }

  private requireProject(userId: string, projectId: string): Project {
    const project = this.projects.get(projectId);
    if (!project || this.projects.getOwnerId(projectId) !== userId) {
      throw new ResourceServiceError("NOT_FOUND", "project was not found");
    }
    return project;
  }

  private requireSession(userId: string, sessionId: string): SessionProjection {
    const session = this.sessions.get(sessionId);
    if (!session) throw new ResourceServiceError("NOT_FOUND", "session was not found");
    const ownerId = this.projects.getOwnerId(session.projectId);
    if (ownerId !== userId) throw new ResourceServiceError("NOT_FOUND", "session was not found");
    return session;
  }
}
