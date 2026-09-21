import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  commandReceiptSchema,
  commandRequestSchema,
  type CommandKind,
  type CommandReceipt,
  type CommandRequest,
  type Attachment,
  type InputContent,
  type ProtocolEvent,
  type QueueProjection,
  type ReducerState
} from "@pi-remote/protocol";
import type { AuthContext } from "../auth.js";
import {
  assertCommandActorForSession,
  CommandRepository,
  EventStore,
  InteractionRepository,
  loadReducerState,
  stableJsonStringify,
  withTransaction
} from "../storage/index.js";
import {
  WorkerManagerError,
  type WorkerManager
} from "../runtime/manager.js";

type ActiveRun = ReducerState["runs"][string];

const TERMINAL_COMMAND_STATES = new Set(["completed", "failed", "cancelled", "unknown"]);
const SUPPORTED_INPUT_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
// A queued follow-up is a durable tail item, not the Session's current
// generation. Treating it as active would incorrectly steer new prompts and
// would prevent pump() from ever dispatching the queue head.
const ACTIVE_RUN_STATES = new Set(["running", "stopping"]);

/** Commands exposed by the HTTP bridge. This is a capability description, not
 * a safety allow-list for the native SDK or extension runtime. */
export const SUPPORTED_COMMANDS: readonly CommandKind[] = [
  "prompt",
  "extension_command",
  "bash",
  "abort_bash",
  "follow_up",
  "steer",
  "abort",
  "cancel_queued",
  "resume_queue",
  "set_model",
  "set_thinking",
  "compact",
  "respond"
];

export type CommandServiceErrorCode =
  | "NOT_FOUND"
  | "IDEMPOTENCY_CONFLICT"
  | "VERSION_CONFLICT"
  | "STALE_RUN"
  | "QUEUE_FULL"
  | "INTERACTION_CLOSED"
  | "INTERACTION_MISMATCH"
  | "INVALID_REQUEST"
  | "WORKER_NOT_LOADED"
  | "WORKER_DISCONNECTED"
  | "WORKER_CAPACITY"
  | "HISTORY_UNAVAILABLE"
  | "STORAGE_UNAVAILABLE";

export class CommandServiceError extends Error {
  constructor(
    public readonly code: CommandServiceErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "CommandServiceError";
  }
}

export interface CommandMutationResult {
  status: number;
  body: CommandReceipt;
}

interface DispatchAction {
  type: "dispatch";
  sessionId: string;
  commandId: string;
  operationId: string;
  runId?: string;
  kind: "prompt" | "compact" | "bash" | "extension_command";
  commandKind?: "prompt" | "follow_up" | "compact" | "bash" | "extension_command";
  text?: string;
  instructions?: string;
  command?: string;
  excludeFromContext?: boolean;
  content?: InputContent;
};

interface ControlAction {
  type: "control";
  sessionId: string;
  commandId: string;
  control:
    | { kind: "steer"; payload: { commandId: string; operationId: string; runId: string; inputId: string; content: InputContent; text: string } }
    | { kind: "follow_up"; payload: { commandId: string; operationId: string; runId: string; inputId: string; content: InputContent; text: string } }
    | { kind: "abort"; payload: { commandId: string; runId: string } }
    | { kind: "abort_bash"; payload: { commandId: string } }
    | { kind: "respond"; payload: { commandId: string; operationId: string; interactionId: string; response: Record<string, unknown> } }
    | { kind: "set_model"; payload: { commandId: string; operationId: string; provider: string; modelId: string; persist?: boolean } }
    | { kind: "set_thinking"; payload: { commandId: string; operationId: string; level: string; persist?: boolean } };
}

interface DeferredCompactAction {
  type: "compact_after_stop";
  sessionId: string;
  commandId: string;
  instructions?: string;
  actor: AuthContext;
}

type FollowUpDispatchAction = DispatchAction;
type Action = DispatchAction | ControlAction | DeferredCompactAction;

function nowIso(now: number): string {
  return new Date(now).toISOString();
}

function event(
  state: ReducerState,
  seq: number,
  runId: string | null,
  operationId: string | null,
  type: ProtocolEvent["type"],
  payload: unknown,
  now: number
): ProtocolEvent {
  return {
    schemaVersion: 1,
    sessionId: state.sessionId,
    seq,
    runId,
    operationId,
    type,
    timestamp: nowIso(now),
    payload
  } as ProtocolEvent;
}

function activeRun(state: ReducerState): ActiveRun | null {
  if (state.session.activeRunId) {
    const candidate = state.runs[state.session.activeRunId];
    if (candidate && ACTIVE_RUN_STATES.has(candidate.status)) return candidate;
  }
  const active = Object.values(state.runs).find((run) => ACTIVE_RUN_STATES.has(run.status));
  if (active) return active;
  // A direct prompt is briefly queued between the durable command transaction
  // and manager.dispatch(). It is active work for command admission. A
  // follow-up queued by the application is the explicit exception: it is a
  // durable tail item and must remain dispatchable by pump().
  return Object.values(state.runs).find((run) =>
    run.status === "queued" && !state.queue.items.some((item) => item.runId === run.runId)
  ) ?? null;
}

function inputContent(payload: { text: string; attachments?: InputContent["attachments"] }): InputContent {
  return {
    text: payload.text,
    ...(payload.attachments ? { attachments: structuredClone(payload.attachments) } : {})
  };
}

function commandEnvelope(request: CommandRequest): { kind: CommandKind; payload: unknown } {
  return { kind: request.kind, payload: request.payload };
}

function payloadHash(value: unknown): string {
  // The repository stores the SHA-256 of the same stable representation.
  // Hashing the canonical form keeps object key order irrelevant on replay.
  return createHash("sha256").update(stableJsonStringify(value)).digest("hex");
}

function storedPayload(record: unknown): { kind: string; payload: Record<string, unknown> } | null {
  if (record === null || typeof record !== "object" || Array.isArray(record)) return null;
  const value = record as Record<string, unknown>;
  if (typeof value.kind !== "string" || value.payload === null || typeof value.payload !== "object" || Array.isArray(value.payload)) return null;
  return { kind: value.kind, payload: value.payload as Record<string, unknown> };
}

function isTerminal(status: string): boolean {
  return TERMINAL_COMMAND_STATES.has(status);
}

class SessionMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, callback: () => Promise<T> | T): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.tails.set(key, current);
    await previous;
    try {
      return await callback();
    } finally {
      release();
      if (this.tails.get(key) === current) this.tails.delete(key);
    }
  }
}

/**
 * Owns the short command transaction and delegates only after its receipt and
 * event have committed. It intentionally never holds the Session mutex while
 * waiting for the SDK or a form response.
 */
export class CommandService {
  private readonly commands: CommandRepository;
  private readonly interactions: InteractionRepository;
  private readonly eventStore: EventStore;
  private readonly mutex = new SessionMutex();
  private readonly pumping = new Set<string>();
  private readonly pendingConfig = new Map<string, number>();
  private readonly unsubscribeSettled: () => void;
  private readonly now: () => number;
  private readonly compactStopTimeoutMs: number;
  private readonly maxQueuedCommands: number | undefined;
  private readonly secretFingerprintKey: string;
  private readonly resolveAttachmentFiles?: (sessionId: string, attachments: readonly Attachment[]) => Array<{ artifactId: string; mimeType: string; filePath: string }>;

  constructor(
    private readonly database: DatabaseSync,
    private readonly manager: WorkerManager,
    options: {
      now?: () => number;
      compactStopTimeoutMs?: number;
      maxQueuedCommands?: number;
      secretFingerprintKey?: string;
      resolveAttachmentFiles?: (sessionId: string, attachments: readonly Attachment[]) => Array<{ artifactId: string; mimeType: string; filePath: string }>;
    } = {}
  ) {
    this.commands = new CommandRepository(database);
    this.interactions = new InteractionRepository(database);
    this.secretFingerprintKey = options.secretFingerprintKey ?? randomBytes(32).toString("hex");
    this.resolveAttachmentFiles = options.resolveAttachmentFiles;
    this.now = options.now ?? (() => Date.now());
    this.compactStopTimeoutMs = options.compactStopTimeoutMs ?? 30_000;
    if (options.maxQueuedCommands !== undefined && (!Number.isSafeInteger(options.maxQueuedCommands) || options.maxQueuedCommands < 0)) {
      throw new Error("maxQueuedCommands must be a non-negative integer");
    }
    this.maxQueuedCommands = options.maxQueuedCommands;
    this.eventStore = new EventStore(database, { now: this.now });
    this.unsubscribeSettled = manager.onCommandSettled((input) => {
      this.onCommandSettled(input.sessionId, input.commandId, input.state);
    });
  }

  dispose(): void {
    this.unsubscribeSettled();
  }

  async submit(
    actor: AuthContext,
    sessionId: string,
    requestBody: unknown,
    idempotencyKey: string
  ): Promise<CommandMutationResult> {
    const request = commandRequestSchema.parse(requestBody);
    const requestAttachments = request.kind === "prompt" || request.kind === "follow_up" || request.kind === "steer"
      ? request.payload.attachments
      : request.kind === "respond" && "attachments" in request.payload.response
        ? request.payload.response.attachments
        : undefined;
    for (const attachment of requestAttachments ?? []) {
      if (!SUPPORTED_INPUT_IMAGE_MIME_TYPES.has(attachment.mimeType)) {
        throw new CommandServiceError("INVALID_REQUEST", "attachment MIME type is not supported for model image input");
      }
    }
    const scope = `POST:/v1/sessions/${sessionId}/commands`;
    const envelope = this.storageEnvelope(sessionId, request);
    const existing = this.replay(actor.userId, scope, idempotencyKey, envelope);
    if (existing) return existing;

    const result = await this.mutex.run(sessionId, async () => {
      const retry = this.replay(actor.userId, scope, idempotencyKey, envelope);
      if (retry) return { result: retry, action: null as Action | null };
      try {
        assertCommandActorForSession(this.database, sessionId, {
          userId: actor.userId,
          deviceId: actor.deviceId
        });
      } catch {
        throw new CommandServiceError("NOT_FOUND", "session was not found");
      }
      const plan = this.plan(request, actor, sessionId);
      try {
        return this.persistAccepted(actor, sessionId, scope, idempotencyKey, envelope, plan);
      } catch (error) {
        this.releasePlanReservation(sessionId, request, plan);
        throw error;
      }
    });

    if (result.action) this.startAction(result.action);
    // Queue mutations commit before this call. Pumping after the short
    // transaction keeps a paused queue paused and lets a newly-created queue
    // head run when no model Run is active.
    if (request.kind === "follow_up" || request.kind === "cancel_queued" || request.kind === "resume_queue") {
      this.pump(sessionId);
    }
    return result.result;
  }

  private replay(userId: string, scope: string, idempotencyKey: string, payload: unknown): CommandMutationResult | null {
    const record = this.commands.getByIdempotency(userId, scope, idempotencyKey);
    if (!record) return null;
    const storedHash = record.payloadHash;
    const candidate = payloadHash(payload);
    if (storedHash !== candidate) {
      throw new CommandServiceError("IDEMPOTENCY_CONFLICT", "idempotency key was used with a different request");
    }
    if (record.responseStatus === null || record.response === null) {
      throw new CommandServiceError("STORAGE_UNAVAILABLE", "stored command receipt is unavailable");
    }
    return { status: record.responseStatus, body: commandReceiptSchema.parse(record.response) };
  }

  private storageEnvelope(sessionId: string, request: CommandRequest): ReturnType<typeof commandEnvelope> {
    if (request.kind !== "respond" || this.interactions.get(sessionId, request.payload.interactionId)?.payload.sensitive !== true) return commandEnvelope(request);
    const fingerprint = createHmac("sha256", this.secretFingerprintKey)
      .update("pi-remote-secret-response-v1\0").update(sessionId).update(stableJsonStringify(request)).digest("hex");
    return { kind: "respond", payload: { operationId: request.payload.operationId, interactionId: request.payload.interactionId,
      response: { redacted: true, fingerprint } } };
  }

  private plan(request: CommandRequest, actor: AuthContext, sessionId: string): {
    commandId: string;
    commandState: "queued" | "dispatching" | "completed";
    runId?: string;
    operationId?: string;
    action?: Action;
    immediateResult?: Record<string, unknown>;
    targetRunId?: string;
    reservedConfigVersion?: number;
    events: ProtocolEvent[];
  } {
    const state = loadReducerState(this.database, sessionId);
    const now = this.now();
    const active = activeRun(state);
    const seqStart = state.lastSeq + 1;
    const events: ProtocolEvent[] = [];
    const commandId = randomUUID();
    void actor;

    if (request.kind === "cancel_queued") {
      const target = state.commands[request.payload.targetCommandId];
      const queueItem = state.queue.items.find((item) => item.commandId === request.payload.targetCommandId);
      if (!target || !queueItem || target.state !== "queued") {
        throw new CommandServiceError("STALE_RUN", "target command is not queued");
      }
      const targetRun = state.runs[queueItem.runId];
      if (!targetRun || targetRun.status !== "queued") {
        throw new CommandServiceError("STALE_RUN", "target queued Run is no longer available");
      }
      const targetOperation = state.operations[targetRun.operationId];
      if (!targetOperation) throw new CommandServiceError("STORAGE_UNAVAILABLE", "queued Run operation is missing");
      const nextItems = state.queue.items
        .filter((item) => item.commandId !== request.payload.targetCommandId)
        .map((item, index) => ({ ...item, position: index }));
      const nextQueue = nextQueueProjection(state.queue, nextItems, state.queue.state === "paused" && nextItems.length > 0
        ? state.queue.pause
        : null);
      events.push(event(state, seqStart, targetRun.runId, targetOperation.operationId, "run.updated", {
        kind: targetRun.kind,
        status: "cancelled",
        phase: null,
        source: targetRun.source,
        ...(targetRun.commandId ? { commandId: targetRun.commandId } : {}),
        error: { code: "CANCELLED", message: "queued Run was cancelled" }
      }, now));
      events.push(event(state, seqStart + 1, targetRun.runId, targetOperation.operationId, "operation.updated", {
        operationId: targetOperation.operationId,
        kind: "run",
        status: "cancelled",
        runId: targetRun.runId,
        ...(targetRun.commandId ? { commandId: targetRun.commandId } : {}),
        error: { code: "CANCELLED", message: "queued Run was cancelled" }
      }, now));
      events.push(event(state, seqStart + 2, targetRun.runId, targetOperation.operationId, "command.updated", {
        commandId: target.commandId,
        kind: target.kind,
        state: "cancelled",
        targetRunId: targetRun.runId,
        runs: target.runs,
        error: { code: "CANCELLED", message: "queued Run was cancelled" }
      }, now));
      events.push(event(state, seqStart + 3, null, null, "queue.updated", nextQueue, now));
      events.push(event(state, seqStart + 4, null, null, "command.updated", {
        commandId,
        kind: "cancel_queued",
        state: "completed",
        targetRunId: targetRun.runId,
        runs: [],
        result: { queue: nextQueue }
      }, now));
      return {
        commandId,
        commandState: "completed",
        immediateResult: { queue: nextQueue },
        events,
        targetRunId: targetRun.runId
      };
    }

    if (request.kind === "resume_queue") {
      if (state.queue.state !== "paused") throw new CommandServiceError("STALE_RUN", "queue is not paused");
      if (request.payload.expectedQueueVersion !== state.queue.version) {
        throw new CommandServiceError("VERSION_CONFLICT", "queue version is stale", { currentQueueVersion: state.queue.version });
      }
      if (state.queue.pause?.runId !== request.payload.afterRunId) {
        throw new CommandServiceError("STALE_RUN", "queue pause belongs to another Run");
      }
      const nextQueue = nextQueueProjection(state.queue, state.queue.items, null);
      events.push(event(state, seqStart, null, null, "queue.updated", nextQueue, now));
      events.push(event(state, seqStart + 1, null, null, "command.updated", {
        commandId,
        kind: "resume_queue",
        state: "completed",
        runs: [],
        result: { queue: nextQueue }
      }, now));
      return { commandId, commandState: "completed", immediateResult: { queue: nextQueue }, events };
    }

    const control = this.planControl(request, actor, sessionId, state, active, now, seqStart, commandId);
    if (control) return control;

    // The queue limit is an operator opt-in. Control paths above intentionally
    // bypass it so abort, steer, configuration and form responses remain
    // usable while ordinary work is at capacity.
    if (this.maxQueuedCommands !== undefined && this.maxQueuedCommands > 0) {
      const row = this.database.prepare("SELECT COUNT(*) AS count FROM commands WHERE state = 'queued'").get() as { count?: unknown } | undefined;
      const queued = Number(row?.count ?? 0);
      if (queued >= this.maxQueuedCommands) {
        throw new CommandServiceError("QUEUE_FULL", "configured queued-command capacity has been reached", {
          maxQueuedCommands: this.maxQueuedCommands
        });
      }
    }

    if (request.kind === "compact" && request.payload.expectedVersion !== state.session.version) {
      throw new CommandServiceError("VERSION_CONFLICT", "session version is stale", { currentVersion: state.session.version });
    }

    if (request.kind === "compact" && active) {
      const action: DeferredCompactAction = {
        type: "compact_after_stop",
        sessionId,
        commandId,
        instructions: request.payload.instructions,
        actor
      };
      return {
        commandId,
        commandState: "queued",
        action,
        events: [
          event(state, seqStart, active.runId, active.operationId, "run.updated", {
            kind: active.kind,
            status: "stopping",
            phase: "stopping",
            source: active.source,
            ...(active.commandId ? { commandId: active.commandId } : {})
          }, now),
          event(state, seqStart + 1, null, null, "command.updated", {
            commandId,
            kind: "compact",
            state: "queued",
            runs: []
          }, now)
        ]
      };
    }

    const operationId = randomUUID();
    const isRun = request.kind === "prompt" || request.kind === "follow_up" || request.kind === "compact";
    const runId = isRun ? randomUUID() : undefined;
    const kind = request.kind === "follow_up" ? "follow_up" : request.kind;
    const dispatchKind = (request.kind === "follow_up" ? "prompt" : request.kind) as DispatchAction["kind"];
    const content = request.kind === "prompt" || request.kind === "follow_up"
      ? inputContent(request.payload)
      : undefined;
    const action: DispatchAction = {
      type: "dispatch",
      sessionId,
      commandId,
      operationId,
      ...(runId ? { runId } : {}),
      kind: dispatchKind,
      commandKind: kind as DispatchAction["commandKind"],
      ...(request.kind === "prompt" || request.kind === "follow_up" ? { text: request.payload.text } : {}),
      ...(request.kind === "compact" ? { instructions: request.payload.instructions } : {}),
      ...(request.kind === "bash" ? { command: request.payload.command, excludeFromContext: request.payload.excludeFromContext } : {}),
      ...(request.kind === "extension_command" ? { text: request.payload.text } : {}),
      ...(content ? { content } : {})
    };
    const shouldQueue = request.kind === "follow_up";
    if (shouldQueue) {
      if (!runId) throw new CommandServiceError("INVALID_REQUEST", "follow_up needs a Run id");
      const item = { commandId, runId, kind: "follow_up" as const, position: state.queue.items.length };
      const nextItems = [...state.queue.items, item];
      const nextQueue = nextQueueProjection(state.queue, nextItems, state.queue.state === "paused" ? state.queue.pause : null);
      events.push(event(state, seqStart, runId, operationId, "operation.updated", {
        operationId,
        kind: "run",
        status: "running",
        runId,
        commandId
      }, now));
      events.push(event(state, seqStart + 1, runId, operationId, "run.updated", {
        kind: "prompt",
        status: "queued",
        phase: "queued",
        source: "command",
        commandId
      }, now));
      events.push(event(state, seqStart + 2, null, null, "command.updated", {
        commandId,
        kind: "follow_up",
        state: "queued",
        targetRunId: runId,
        runs: [{ runId, sessionId }]
      }, now));
      events.push(event(state, seqStart + 3, null, null, "queue.updated", nextQueue, now));
    } else if (isRun) {
      if (!runId) throw new CommandServiceError("INVALID_REQUEST", "model command needs a Run id");
      events.push(event(state, seqStart, runId, operationId, "operation.updated", {
        operationId,
        kind: "run",
        status: "running",
        runId,
        commandId
      }, now));
      events.push(event(state, seqStart + 1, runId, operationId, "run.updated", {
        kind: request.kind === "compact" ? "compact" : "prompt",
        status: "queued",
        phase: "queued",
        source: "command",
        commandId
      }, now));
      events.push(event(state, seqStart + 2, null, null, "command.updated", {
        commandId,
        kind: request.kind,
        state: "queued",
        targetRunId: runId,
        runs: [{ runId, sessionId }]
      }, now));
    } else {
      const operationKind = request.kind === "bash" ? "bash" : "extension";
      events.push(event(state, seqStart, null, operationId, "operation.updated", {
        operationId,
        kind: operationKind,
        status: "running",
        commandId
      }, now));
      events.push(event(state, seqStart + 1, null, null, "command.updated", {
        commandId,
        kind: request.kind,
        state: "queued",
        runs: []
      }, now));
    }
    // Explicit follow-up is always represented by the durable application
    // queue. It is dispatched by pump() only after the current Run settles.
    return {
      commandId,
      commandState: "queued",
      ...(runId ? { runId } : {}),
      operationId,
      action: shouldQueue ? undefined : action,
      events
    };
  }

  private planControl(
    request: CommandRequest,
    _actor: AuthContext,
    sessionId: string,
    state: ReducerState,
    active: ActiveRun | null,
    now: number,
    seqStart: number,
    commandId: string
  ): { commandId: string; commandState: "dispatching"; operationId?: string; targetRunId?: string; reservedConfigVersion?: number; action: ControlAction; events: ProtocolEvent[] } | null {
    const events: ProtocolEvent[] = [];
    const activeTarget = (targetRunId: string): ActiveRun => {
      if (!active || active.runId !== targetRunId || !ACTIVE_RUN_STATES.has(active.status)) {
        throw new CommandServiceError("STALE_RUN", "target Run is not active");
      }
      return active;
    };
    if (request.kind === "prompt" && active) {
      const target = active;
      const content = inputContent(request.payload);
      const inputId = randomUUID();
      const controlKind = request.payload.streamingBehavior === "followUp" ? "follow_up" : "steer";
      const action: ControlAction = controlKind === "follow_up"
        ? { type: "control", sessionId, commandId, control: { kind: "follow_up", payload: { commandId, operationId: target.operationId, runId: target.runId, inputId, content, text: request.payload.text } } }
        : { type: "control", sessionId, commandId, control: { kind: "steer", payload: { commandId, operationId: target.operationId, runId: target.runId, inputId, content, text: request.payload.text } } };
      events.push(event(state, seqStart, target.runId, target.operationId, "command.updated", {
        commandId,
        kind: "prompt",
        state: "dispatching",
        targetRunId: target.runId,
        runs: [{ runId: target.runId, sessionId }]
      }, now));
      return { commandId, commandState: "dispatching", targetRunId: target.runId, action, events };
    }
    if (request.kind === "steer") {
      const target = activeTarget(request.payload.targetRunId);
      const content = inputContent(request.payload);
      const inputId = randomUUID();
      const action: ControlAction = {
        type: "control",
        sessionId,
        commandId,
        control: {
          kind: "steer",
          payload: { commandId, operationId: target.operationId, runId: target.runId, inputId, content, text: request.payload.text }
        }
      };
      events.push(event(state, seqStart, target.runId, target.operationId, "command.updated", {
        commandId,
        kind: request.kind,
        state: "dispatching",
        targetRunId: target.runId,
        runs: [{ runId: target.runId, sessionId }]
      }, now));
      return { commandId, commandState: "dispatching", targetRunId: target.runId, action, events };
    }
    if (request.kind === "abort") {
      const target = activeTarget(request.payload.targetRunId);
      const action: ControlAction = { type: "control", sessionId, commandId, control: { kind: "abort", payload: { commandId, runId: target.runId } } };
      events.push(event(state, seqStart, target.runId, target.operationId, "command.updated", {
        commandId,
        kind: "abort",
        state: "dispatching",
        targetRunId: target.runId,
        runs: [{ runId: target.runId, sessionId }]
      }, now));
      return { commandId, commandState: "dispatching", targetRunId: target.runId, action, events };
    }
    if (request.kind === "abort_bash") {
      const action: ControlAction = { type: "control", sessionId, commandId, control: { kind: "abort_bash", payload: { commandId } } };
      events.push(event(state, seqStart, null, null, "command.updated", { commandId, kind: "abort_bash", state: "dispatching", runs: [] }, now));
      return { commandId, commandState: "dispatching", action, events };
    }
    if (request.kind === "respond") {
      const epoch = this.manager.beginLoad(sessionId);
      if (!epoch) throw new CommandServiceError("WORKER_NOT_LOADED", "worker is still starting");
      const action: ControlAction = {
        type: "control",
        sessionId,
        commandId,
        control: {
          kind: "respond",
          payload: {
            commandId,
            operationId: request.payload.operationId,
            interactionId: request.payload.interactionId,
            response: request.payload.response
          }
        }
      };
      // Planning is read-only. The response FK may only be claimed after
      // persistAccepted has inserted the response Command in its transaction.
      const interaction = this.interactions.get(sessionId, request.payload.interactionId);
      if (!interaction) throw new CommandServiceError("NOT_FOUND", "interaction was not found");
      if (interaction.status !== "pending" || interaction.responseCommandId !== null) throw new CommandServiceError("INTERACTION_CLOSED", "interaction is no longer pending");
      if (interaction.expiresAt !== null && interaction.expiresAt <= now) throw new CommandServiceError("INTERACTION_CLOSED", "interaction has expired");
      if (interaction.operationId !== request.payload.operationId || interaction.workerEpoch !== epoch) throw new CommandServiceError("INTERACTION_MISMATCH", "interaction operation or worker epoch does not match");
      events.push(event(state, seqStart, interaction.runId, interaction.operationId, "command.updated", {
        commandId,
        kind: "respond",
        state: "dispatching",
        ...(interaction.runId ? { targetRunId: interaction.runId } : {}),
        runs: interaction.runId ? [{ runId: interaction.runId, sessionId }] : []
      }, now));
      return { commandId, commandState: "dispatching", action, events };
    }
    if (request.kind === "set_model" || request.kind === "set_thinking") {
      const reserved = this.pendingConfig.get(sessionId);
      if (reserved !== undefined && request.payload.expectedVersion < reserved) {
        throw new CommandServiceError("VERSION_CONFLICT", "a newer configuration operation is pending", { currentVersion: reserved });
      }
      if (request.payload.expectedVersion !== state.session.version) {
        throw new CommandServiceError("VERSION_CONFLICT", "session version is stale", { currentVersion: state.session.version });
      }
      const operationId = randomUUID();
      this.pendingConfig.set(sessionId, state.session.version + 1);
      const action: ControlAction = request.kind === "set_model"
        ? { type: "control", sessionId, commandId, control: { kind: "set_model", payload: { commandId, operationId, provider: request.payload.model.provider, modelId: request.payload.model.id, ...(request.payload.persist !== undefined ? { persist: request.payload.persist } : {}) } } }
        : { type: "control", sessionId, commandId, control: { kind: "set_thinking", payload: { commandId, operationId, level: request.payload.level, ...(request.payload.persist !== undefined ? { persist: request.payload.persist } : {}) } } };
      events.push(event(state, seqStart, null, operationId, "operation.updated", {
        operationId,
        kind: "configure",
        status: "running",
        commandId
      }, now));
      events.push(event(state, seqStart + 1, null, null, "command.updated", {
        commandId,
        kind: request.kind,
        state: "dispatching",
        runs: []
      }, now));
      return { commandId, commandState: "dispatching", operationId, reservedConfigVersion: state.session.version + 1, action, events };
    }
    return null;
  }

  private persistAccepted(
    actor: AuthContext,
    sessionId: string,
    scope: string,
    idempotencyKey: string,
    envelope: { kind: CommandKind; payload: unknown },
    plan: ReturnType<CommandService["plan"]>
  ): { result: CommandMutationResult; action: Action | null } {
    const commandId = plan.commandId;
    const payload = { kind: envelope.kind, payload: envelope.payload };
    const now = this.now();
    const receipt = commandReceiptSchema.parse({
      commandId,
      state: plan.commandState === "completed" ? "completed" : "queued",
      ...(plan.runId ? { runId: plan.runId } : {}),
      ...(plan.immediateResult ? { result: plan.immediateResult } : {})
    });
    const events = plan.events;
    withTransaction(this.database, () => {
      this.commands.create({
        id: commandId,
        userId: actor.userId,
        deviceId: actor.deviceId,
        sessionId,
        scope,
        clientCommandId: idempotencyKey,
        kind: envelope.kind,
        payload,
        state: plan.commandState,
        targetRunId: plan.targetRunId,
        now
      });
      if (plan.action?.type === "control" && plan.action.control.kind === "respond") {
        const response = plan.action.control.payload;
        const epoch = this.manager.workerEpoch(sessionId);
        if (!epoch) throw new CommandServiceError("WORKER_NOT_LOADED", "interaction worker is unavailable");
        const claimed = this.interactions.claimResponse({ sessionId, interactionId: response.interactionId, operationId: response.operationId, workerEpoch: epoch, responseCommandId: commandId, now });
        if (claimed.status !== "claimed") {
          throw new CommandServiceError(claimed.status === "mismatch" ? "INTERACTION_MISMATCH" : "INTERACTION_CLOSED", "interaction response could not be claimed");
        }
      }
      if (events.length > 0) {
        this.eventStore.appendBatchWithinTransaction({
          sessionId,
          workerEpoch: `command-${randomUUID()}`,
          batchNo: 1,
          events
        });
      }
      this.commands.recordInitialResponse(commandId, plan.commandState === "completed" ? 200 : 202, receipt, now, plan.commandState === "completed");
    });
    return {
      result: { status: plan.commandState === "completed" ? 200 : 202, body: receipt },
      action: plan.action ?? null
    };
  }

  private releasePlanReservation(
    sessionId: string,
    request: CommandRequest,
    plan: ReturnType<CommandService["plan"]>
  ): void {
    if (plan.reservedConfigVersion !== undefined && this.pendingConfig.get(sessionId) === plan.reservedConfigVersion) {
      this.pendingConfig.delete(sessionId);
    }
    if (request.kind === "respond") {
      this.interactions.clearResponseClaim(sessionId, request.payload.interactionId, plan.commandId);
    }
  }

  private startAction(action: Action): void {
    if (action.type === "control") {
      void this.sendControl(action).catch((error: unknown) => this.failPendingCommand(action.sessionId, action.commandId, error));
      return;
    }
    if (action.type === "compact_after_stop") {
      void this.stopThenCompact(action).catch((error: unknown) => this.failPendingCommand(action.sessionId, action.commandId, error));
      return;
    }
    void this.dispatch(action).catch((error: unknown) => this.failPendingCommand(action.sessionId, action.commandId, error));
  }

  private async dispatch(action: DispatchAction): Promise<void> {
    const attachments = action.content?.attachments;
    const imageFiles = attachments?.length ? this.resolveImages(action.sessionId, attachments) : undefined;
    await this.manager.dispatch({ ...action, ...(imageFiles?.length ? { imageFiles } : {}) });
  }

  private resolveImages(sessionId: string, attachments: readonly Attachment[]): Array<{ artifactId: string; mimeType: string; filePath: string }> {
    if (!this.resolveAttachmentFiles) throw new CommandServiceError("STORAGE_UNAVAILABLE", "attachment resolver is unavailable");
    for (const attachment of attachments) {
      if (!SUPPORTED_INPUT_IMAGE_MIME_TYPES.has(attachment.mimeType)) throw new CommandServiceError("INVALID_REQUEST", "attachment MIME type is not supported for model image input");
    }
    return this.resolveAttachmentFiles(sessionId, attachments);
  }

  private async sendControl(action: ControlAction): Promise<void> {
    const control = action.control;
    switch (control.kind) {
      case "steer":
        await this.manager.sendControl(action.sessionId, "steer", {
          ...control.payload,
          ...(control.payload.content.attachments?.length ? { imageFiles: this.resolveImages(action.sessionId, control.payload.content.attachments) } : {})
        });
        return;
      case "follow_up":
        await this.manager.sendControl(action.sessionId, "follow_up", {
          ...control.payload,
          ...(control.payload.content.attachments?.length ? { imageFiles: this.resolveImages(action.sessionId, control.payload.content.attachments) } : {})
        });
        return;
      case "abort":
        await this.manager.sendControl(action.sessionId, "abort", control.payload);
        return;
      case "abort_bash":
        await this.manager.sendControl(action.sessionId, "abort_bash", control.payload);
        return;
      case "respond":
        {
          const responseAttachments = Array.isArray(control.payload.response.attachments)
            ? control.payload.response.attachments as Attachment[]
            : undefined;
          await this.manager.sendControl(action.sessionId, "respond", {
            ...control.payload,
            ...(responseAttachments?.length ? { imageFiles: this.resolveImages(action.sessionId, responseAttachments) } : {})
          }, { waitForReady: false });
        }
        return;
      case "set_model":
        await this.manager.sendControl(action.sessionId, "set_model", control.payload);
        return;
      case "set_thinking":
        await this.manager.sendControl(action.sessionId, "set_thinking", control.payload);
        return;
    }
  }

  private async stopThenCompact(action: DeferredCompactAction): Promise<void> {
    const initial = loadReducerState(this.database, action.sessionId);
    const current = activeRun(initial);
    if (!current) {
      await this.attachAndDispatchCompact(action);
      return;
    }
    await this.manager.sendControl(action.sessionId, "abort", { runId: current.runId, preserveQueue: true }, { waitForReady: false });
    const deadline = Date.now() + Math.max(0, this.compactStopTimeoutMs);
    for (;;) {
      const state = loadReducerState(this.database, action.sessionId);
      if (!activeRun(state)) break;
      if (Date.now() >= deadline) {
        throw new CommandServiceError("WORKER_DISCONNECTED", "timed out waiting for the active Run to stop before compact");
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    await this.attachAndDispatchCompact(action);
  }

  private async attachAndDispatchCompact(action: DeferredCompactAction): Promise<void> {
    const dispatch = await this.mutex.run(action.sessionId, () => {
      const state = loadReducerState(this.database, action.sessionId);
      if (activeRun(state)) throw new CommandServiceError("STALE_RUN", "session still has an active Run");
      const row = this.commands.get(action.commandId);
      if (!row || row.state !== "queued") return null;
      const operationId = randomUUID();
      const runId = randomUUID();
      const now = this.now();
      const events = [
        event(state, state.lastSeq + 1, runId, operationId, "operation.updated", {
          operationId,
          kind: "run",
          status: "running",
          runId,
          commandId: action.commandId
        }, now),
        event(state, state.lastSeq + 2, runId, operationId, "run.updated", {
          kind: "compact",
          status: "queued",
          phase: "queued",
          source: "command",
          commandId: action.commandId
        }, now),
        event(state, state.lastSeq + 3, null, null, "command.updated", {
          commandId: action.commandId,
          kind: "compact",
          state: "queued",
          targetRunId: runId,
          runs: [{ runId, sessionId: action.sessionId }]
        }, now)
      ];
      withTransaction(this.database, () => {
        this.eventStore.appendBatchWithinTransaction({
          sessionId: action.sessionId,
          workerEpoch: `command-${randomUUID()}`,
          batchNo: 1,
          events
        });
      });
      return {
        type: "dispatch",
        sessionId: action.sessionId,
        commandId: action.commandId,
        operationId,
        runId,
        kind: "compact",
        commandKind: "compact",
        instructions: action.instructions
      } satisfies DispatchAction;
    });
    if (dispatch) await this.dispatch(dispatch);
  }

  private async failPendingCommand(sessionId: string, commandId: string, error: unknown): Promise<void> {
    let settled = false;
    await this.mutex.run(sessionId, () => {
      const state = loadReducerState(this.database, sessionId);
      const record = this.commands.get(commandId);
      if (!record || isTerminal(record.state)) return;
      const projection = state.commands[commandId];
      const targetRun = projection?.targetRunId ? state.runs[projection.targetRunId] : undefined;
      const ownsTargetRun = targetRun?.commandId === commandId;
      const operation = ownsTargetRun
        ? targetRun ? state.operations[targetRun.operationId] : undefined
        : Object.values(state.operations).find((candidate) => candidate.commandId === commandId);
      const message = error instanceof Error ? error.message : String(error);
      const detail = { code: error instanceof WorkerManagerError ? error.code : "DISPATCH_FAILED", message: message.slice(0, 1000) };
      const events: ProtocolEvent[] = [];
      let seq = state.lastSeq + 1;
      if (targetRun && ownsTargetRun && ACTIVE_RUN_STATES.has(targetRun.status)) {
        if (!targetRun.contentSealed) events.push(event(state, seq++, targetRun.runId, targetRun.operationId, "run.content_sealed", { reason: "failed" }, this.now()));
        events.push(event(state, seq++, targetRun.runId, targetRun.operationId, "run.updated", {
          kind: targetRun.kind,
          status: "failed",
          phase: null,
          source: targetRun.source,
          ...(targetRun.commandId ? { commandId: targetRun.commandId } : {}),
          error: detail
        }, this.now()));
        events.push(event(state, seq++, targetRun.runId, targetRun.operationId, "operation.updated", {
          operationId: targetRun.operationId,
          kind: "run",
          status: "failed",
          runId: targetRun.runId,
          error: detail
        }, this.now()));
      } else if (operation && !isTerminal(operation.status)) {
        events.push(event(state, seq++, null, operation.operationId, "operation.updated", {
          operationId: operation.operationId,
          kind: operation.kind,
          status: "failed",
          ...(operation.commandId ? { commandId: operation.commandId } : {}),
          error: detail
        }, this.now()));
      }
      events.push(event(state, seq, ownsTargetRun ? targetRun?.runId ?? null : null, operation?.operationId ?? null, "command.updated", {
        commandId,
        kind: projection?.kind ?? record.kind,
        state: "failed",
        ...(targetRun ? { targetRunId: targetRun.runId, runs: [{ runId: targetRun.runId, sessionId }] } : { runs: [] }),
        error: detail
      }, this.now()));
      withTransaction(this.database, () => {
        this.eventStore.appendBatchWithinTransaction({
          sessionId,
          workerEpoch: `command-${randomUUID()}`,
          batchNo: 1,
          events
        });
        this.commands.markFinished(commandId, this.now());
      });
      this.clearResponseClaimIfFailed(record, sessionId, commandId);
      this.pendingConfig.delete(sessionId);
      settled = true;
    });
    if (settled) this.onCommandSettled(sessionId, commandId, "failed");
  }

  private onCommandSettled(sessionId: string, commandId: string, status: "completed" | "failed" | "cancelled"): void {
    const record = this.commands.get(commandId);
    if (record?.kind === "set_model" || record?.kind === "set_thinking") this.pendingConfig.delete(sessionId);
    if (record && status !== "completed") this.clearResponseClaimIfFailed(record, sessionId, commandId);
    void this.mutex.run(sessionId, () => this.reconcileQueue(sessionId, commandId, status))
      .then(() => this.pump(sessionId))
      .catch(() => undefined);
  }

  private clearResponseClaimIfFailed(record: { kind: string; payload: unknown }, sessionId: string, commandId: string): void {
    if (record.kind !== "respond") return;
    const payload = storedPayload(record.payload)?.payload;
    if (typeof payload?.interactionId === "string") {
      this.interactions.clearResponseClaim(sessionId, payload.interactionId, commandId);
    }
  }

  private async reconcileQueue(sessionId: string, commandId: string, status: "completed" | "failed" | "cancelled"): Promise<void> {
    let shouldPump = false;
    withTransaction(this.database, () => {
      const current = loadReducerState(this.database, sessionId);
      const item = current.queue.items.find((candidate) => candidate.commandId === commandId);
      if (!item) {
        // A directly submitted Run is not itself a tail item. Its abnormal
        // completion must still pause existing tails before any pump can run.
        // Failed input/control commands do not own that Run and cannot pause it.
        const stoppedRun = Object.values(current.runs).find((run) =>
          run.commandId === commandId && ["failed", "aborted", "interrupted"].includes(run.status)
        );
        if (stoppedRun && current.queue.state === "ready" && current.queue.items.length > 0) {
          const reason = stoppedRun.status as "failed" | "aborted" | "interrupted";
          this.eventStore.appendBatchWithinTransaction({
            sessionId,
            workerEpoch: `queue-${randomUUID()}`,
            batchNo: 1,
            events: [event(current, current.lastSeq + 1, null, null, "queue.updated",
              nextQueueProjection(current.queue, current.queue.items, { runId: stoppedRun.runId, reason }), this.now())]
          });
          return;
        }
        shouldPump = current.queue.state === "ready" && current.queue.items.length > 0 && !activeRun(current);
        return;
      }
      const remaining = current.queue.items
        .filter((candidate) => candidate.commandId !== commandId)
        .map((candidate, index) => ({ ...candidate, position: index }));
      const shouldPause = status !== "completed" && remaining.length > 0;
      const pause = shouldPause
        ? { runId: item.runId, reason: status === "cancelled" ? "aborted" as const : "failed" as const }
        : null;
      const nextQueue = nextQueueProjection(current.queue, remaining, pause);
      shouldPump = !shouldPause;
      this.eventStore.appendBatchWithinTransaction({
        sessionId,
        workerEpoch: `queue-${randomUUID()}`,
        batchNo: 1,
        events: [event(current, current.lastSeq + 1, null, null, "queue.updated", nextQueue, this.now())]
      });
    });
    if (shouldPump) this.pump(sessionId);
  }

  private pump(sessionId: string): void {
    if (this.pumping.has(sessionId)) return;
    this.pumping.add(sessionId);
    void (async () => {
      let queuedCommandId: string | undefined;
      try {
        const state = loadReducerState(this.database, sessionId);
        if (activeRun(state) || state.queue.state === "paused") return;
        const item = state.queue.items[0];
        if (!item) return;
        queuedCommandId = item.commandId;
        const command = state.commands[item.commandId];
        const record = this.commands.get(item.commandId);
        if (!command || !record || command.state !== "queued") return;
        const stored = storedPayload(record.payload);
        if (!stored) throw new CommandServiceError("STORAGE_UNAVAILABLE", "queued command payload is invalid");
        const operation = state.operations[state.runs[item.runId]?.operationId ?? ""];
        if (!operation) throw new CommandServiceError("STORAGE_UNAVAILABLE", "queued command operation is missing");
        const payload = stored.payload;
        const action: FollowUpDispatchAction = stored.kind === "follow_up"
          ? { type: "dispatch", sessionId, commandId: item.commandId, operationId: operation.operationId, runId: item.runId, kind: "prompt", commandKind: "follow_up", text: String(payload.text), content: inputContent(payload as { text: string; attachments?: InputContent["attachments"] }) }
          : { type: "dispatch", sessionId, commandId: item.commandId, operationId: operation.operationId, runId: item.runId, kind: "compact", commandKind: "compact", instructions: typeof payload.instructions === "string" ? payload.instructions : undefined };
        await this.dispatch(action);
      } catch (error) {
        // The command remains durable and visible; turn a local dispatch
        // failure into the same terminal event path used by direct commands.
        if (queuedCommandId) await this.failPendingCommand(sessionId, queuedCommandId, error);
      } finally {
        this.pumping.delete(sessionId);
      }
    })();
  }
}

function nextQueueProjection(
  current: QueueProjection,
  items: QueueProjection["items"],
  pause: QueueProjection["pause"]
): QueueProjection {
  return {
    state: pause ? "paused" : "ready",
    version: current.version + 1,
    pause,
    items
  };
}
