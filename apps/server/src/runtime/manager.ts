import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import type { Readable, Writable } from "node:stream";
import {
  type WorkerInboundMessage,
  type WorkerOutboundMessage,
  type WorkerExecutePayload
} from "@pi-remote/agent-pi/worker";
import {
  type ProtocolEvent,
  type ReducerState,
  type ModelInfo,
  parseProtocolEvent
} from "@pi-remote/protocol";
import {
  CommandRepository,
  ProjectRepository,
  EventStore,
  loadReducerState,
  SessionRepository,
  updateRunRuntimeMetadata,
  withTransaction,
  type AppendEventBatchResult
} from "../storage/index.js";
import {
  WorkerIpcChannel,
  makeIpcEnvelope
} from "./ipc.js";
import {
  RecoveryManager,
  type RecoveryOptions,
  type RecoveryReport
} from "./recovery.js";
import {
  Scheduler,
  SchedulerBusyError,
  type ScheduleLease,
  type SchedulerOptions
} from "./scheduler.js";
import { instanceLockDatabasePath } from "../maintenance.js";

import { inspectPiSessionFile, readPiModelCatalog } from "@pi-remote/agent-pi";
import { ArtifactStore } from "../realtime/artifacts.js";
import { hydrateSpooledOutbound, outboundSpoolFileName } from "./outbound-hydration.js";
import { archiveEventOutputs } from "./output-archive.js";

type Row = Record<string, unknown>;

function unrefTimer(timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval> | undefined): void {
  if (timer === undefined) return;
  (timer as unknown as { unref?: () => void }).unref?.();
}

const MANAGER_BATCH_BASE = 1_000_000_000;

export class InstanceLockError extends Error {
  constructor(public readonly path: string) {
    super(`another server instance owns ${path}`);
    this.name = "InstanceLockError";
  }
}

export class WorkerManagerError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "WorkerManagerError";
  }
}

export class DispatchRejectedError extends WorkerManagerError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "DispatchRejectedError";
  }
}

export interface DispatchRequest {
  sessionId: string;
  commandId: string;
  operationId: string;
  runId?: string;
  kind: "prompt" | "compact" | "bash" | "extension_command";
  /** The public command kind may differ from the SDK entry point (follow_up). */
  commandKind?: WorkerExecutePayload["commandKind"];
  text?: string;
  instructions?: string;
  command?: string;
  excludeFromContext?: boolean;
  streamingBehavior?: "steer" | "followUp";
  inputId?: string;
  content?: WorkerExecutePayload["content"];
}

export interface DispatchResult {
  commandId: string;
  operationId: string;
  runId: string | null;
  workerEpoch: string;
  state: "dispatching";
}

export interface WorkerProcessLike {
  readonly pid: number;
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  kill(signal?: NodeJS.Signals | number): boolean;
  once(event: "exit" | "error", listener: (...args: unknown[]) => void): this;
}

export interface SpawnWorkerInput {
  nodeExecutable: string;
  workerScript: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface WorkerManagerOptions {
  stateDir?: string;
  outputDir?: string;
  piDir?: string;
  agentDir?: string;
  sessionDir?: string;
  workerScript?: string;
  nodeExecutable?: string;
  workerHeartbeatMs?: number;
  heartbeatTimeoutMs?: number;
  mappingTimeoutMs?: number;
  workerIdleMs?: number;
  shutdownTimeoutMs?: number;
  scheduler?: Scheduler;
  schedulerOptions?: SchedulerOptions;
  eventStore?: EventStore;
  recovery?: RecoveryManager;
  recoveryOptions?: RecoveryOptions;
  now?: () => number;
  spawnWorker?: (input: SpawnWorkerInput) => ChildProcessWithoutNullStreams;
  environment?: NodeJS.ProcessEnv;
  autoRecover?: boolean;
  instanceLockPath?: string;
  onCommandSettled?: (input: {
    sessionId: string;
    commandId: string;
    state: "completed" | "failed" | "cancelled";
  }) => void;
}

interface SessionRuntimeRow {
  sessionId: string;
  cwd: string;
  workspaceKey: string;
  piSessionFile: string | null;
  piSessionId: string | null;
  persistenceState: "uninitialized" | "unflushed" | "persisted";
  title: string;
  model: { provider: string; id: string } | null;
  thinkingLevel: string | null;
}

interface ManagedWorker {
  envelopeSessionId: string;
  ownedSessionIds: Set<string>;
  replacementIntents: Map<string, { sourceSessionId: string; sourceOperationId?: string; kind: "new" | "switch" | "fork" | "import"; targetFile?: string; targetPiSessionId?: string; targetCwd?: string; projectId: string; destinationSessionId?: string }>;
  workerId: string;
  sessionId: string;
  workspaceKey: string;
  epoch: string;
  process: ChildProcessWithoutNullStreams;
  spoolDir: string;
  channel: WorkerIpcChannel;
  phase: "starting" | "ready" | "stopping" | "exited";
  initializationOperationId: string;
  initializationFinished: boolean;
  initializationInteractionSeen: boolean;
  editorRequests: Map<string, { resolve: () => void; reject: (error: Error) => void }>;
  models: { items: ModelInfo[]; availableThinkingLevels: string[] } | null;
  modelRequests: Map<string, { resolve: (value: { items: ModelInfo[]; availableThinkingLevels: string[] }) => void; reject: (error: Error) => void }>;
  gracefulStop: boolean;
  exitHandled: boolean;
  lastHeartbeat: number;
  heartbeatActive: boolean;
  lastActivity: number;
  mappingAcked: boolean;
  managerBatchNo: number;
  ready: Promise<void>;
  resolveReady: () => void;
  rejectReady: (error: Error) => void;
  messageChain: Promise<void>;
  leases: Map<string, ScheduleLease>;
}

function text(row: Row, key: string): string | null {
  const value = row[key];
  return value === null || value === undefined ? null : typeof value === "string" ? value : null;
}

function requiredText(row: Row, key: string): string {
  const value = text(row, key);
  if (value === null) throw new WorkerManagerError("STORAGE_UNAVAILABLE", `database row ${key} is missing`);
  return value;
}

function nullableText(row: Row, key: string): string | null {
  return text(row, key);
}

function parseModel(row: Row): { provider: string; id: string } | null {
  const value = nullableText(row, "model_json");
  if (value === null) return null;
  const parsed = JSON.parse(value) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new WorkerManagerError("STORAGE_UNAVAILABLE", "session model configuration is invalid");
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.provider !== "string" || typeof record.id !== "string") {
    throw new WorkerManagerError("STORAGE_UNAVAILABLE", "session model configuration is invalid");
  }
  return { provider: record.provider, id: record.id };
}

function nowIso(now: number): string {
  return new Date(now).toISOString();
}

function runtimeError(code: string, message: string): { code: string; message: string } {
  return { code, message };
}

function terminalCommandState(status: WorkerOutboundMessage & { type: "command_result" }): "completed" | "failed" | "cancelled" {
  return status.payload.status;
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
  return parseProtocolEvent({
    schemaVersion: 1,
    sessionId: state.sessionId,
    seq,
    runId,
    operationId,
    type,
    timestamp: nowIso(now),
    payload
  });
}

function processId(process: ChildProcessWithoutNullStreams): number {
  const pid = process.pid;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid < 1) {
    throw new WorkerManagerError("WORKER_SPAWN_FAILED", "worker did not expose a valid process id");
  }
  return pid;
}

function defaultWorkerScript(): string {
  return fileURLToPath(import.meta.resolve("@pi-remote/agent-pi/worker"));
}

function processStartTicks(pid: number | undefined): string | null {
  if (process.platform !== "linux" || pid === undefined) return null;
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    const closing = raw.lastIndexOf(")");
    return raw.slice(closing + 2).trim().split(/\s+/)[19] ?? null;
  } catch {
    return null;
  }
}

const WORKER_SPOOL_TEMP_MAX_AGE_MS = 60_000;
const workerSpoolTempName = /\.tmp$/;

/** Remove only abandoned atomic-write temporary files from prior processes. */
export function cleanupExpiredWorkerSpoolTemps(
  stateDir: string,
  now = Date.now(),
  maxAgeMs = WORKER_SPOOL_TEMP_MAX_AGE_MS
): number {
  if (!Number.isFinite(now) || !Number.isFinite(maxAgeMs) || maxAgeMs < 0) return 0;
  const root = resolve(join(stateDir, "worker-spool"));
  let epochs;
  try { epochs = readdirSync(root, { withFileTypes: true }); } catch { return 0; }
  let removed = 0;
  for (const epoch of epochs) {
    if (!epoch.isDirectory()) continue;
    const directories = [join(root, epoch.name), join(root, epoch.name, "backlog")];
    for (const directory of directories) {
      let entries;
      try { entries = readdirSync(directory, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (!entry.isFile() || !workerSpoolTempName.test(entry.name)) continue;
        const path = join(directory, entry.name);
        try {
          const info = lstatSync(path);
          if (!info.isFile() || now - info.mtimeMs < maxAgeMs) continue;
          unlinkSync(path);
          removed += 1;
        } catch {
          // A concurrent cleanup or worker exit is harmless; retained JSON
          // output is never touched by this maintenance pass.
        }
      }
    }
  }
  return removed;
}

/** Delete only validated regular files in this worker's private spool root. */
function removeOutboundSpoolFiles(spoolDir: string, fileNames: readonly string[]): void {
  let root: string;
  try { root = realpathSync(spoolDir); } catch { return; }
  for (const fileName of fileNames) {
    if (outboundSpoolFileName({ type: "transport_spool", payload: { fileName } }) === null) continue;
    const path = join(root, fileName);
    try {
      if (!lstatSync(path).isFile()) continue;
      if (realpathSync(path) !== path) continue;
      unlinkSync(path);
    } catch {
      // Missing files are already clean; anything unexpected remains for
      // operator inspection and possible replay after a process restart.
    }
  }
}

/**
 * The JSON marker is retained for operator diagnostics and legacy lock
 * recovery. The SQLite sidecar below is the authoritative cross-container
 * mutex because PIDs are scoped to a container namespace.
 */
function staleLock(path: string): boolean {
  let record: { pid?: unknown; startTicks?: unknown };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    record = parsed as { pid?: unknown; startTicks?: unknown };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
  if (!Number.isSafeInteger(record.pid) || (record.pid as number) < 1) return false;
  const pid = record.pid as number;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    return false;
  }
  if (typeof record.startTicks === "string" && record.startTicks.length > 0) {
    const currentTicks = processStartTicks(pid);
    if (currentTicks !== null && currentTicks !== record.startTicks) return true;
  }
  return false;
}

class InstanceLock {
  private database: DatabaseSync | null = null;

  constructor(private readonly path: string) {}

  acquire(): void {
    if (this.database !== null) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const databasePath = instanceLockDatabasePath(this.path);
    let database: DatabaseSync | null = null;
    try {
      database = new DatabaseSync(databasePath);
      // DELETE journaling keeps this tiny sidecar's lock semantics explicit;
      // busy_timeout=0 makes a competing server fail immediately instead of
      // waiting during startup.
      database.exec("PRAGMA journal_mode = DELETE");
      database.exec("PRAGMA synchronous = FULL");
      database.exec("PRAGMA busy_timeout = 0");
      database.exec("BEGIN EXCLUSIVE");
    } catch (error) {
      if (database !== null) {
        try { database.close(); } catch { /* preserve the acquisition error */ }
      }
      const candidate = error as { code?: unknown; message?: unknown };
      if (candidate.code === "SQLITE_BUSY" || (typeof candidate.message === "string" && /database is locked|database table is locked/i.test(candidate.message))) {
        throw new InstanceLockError(this.path);
      }
      throw error;
    }

    let descriptor: number | null = null;
    try {
      for (;;) {
        try {
          descriptor = openSync(this.path, "wx");
          const body = JSON.stringify({
            pid: process.pid ?? null,
            startedAt: new Date().toISOString(),
            startTicks: processStartTicks(process.pid)
          });
          writeSync(descriptor, body, 0, "utf8");
          closeSync(descriptor);
          descriptor = null;
          this.database = database;
          return;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          if (!staleLock(this.path)) throw new InstanceLockError(this.path);
          try {
            unlinkSync(this.path);
          } catch (unlinkError) {
            if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
          }
        }
      }
    } catch (error) {
      if (descriptor !== null) {
        try { closeSync(descriptor); } catch { /* preserve the acquisition error */ }
        try { unlinkSync(this.path); } catch { /* preserve the acquisition error */ }
      }
      try { database.exec("ROLLBACK"); } catch { /* preserve the acquisition error */ }
      try { database.close(); } catch { /* preserve the acquisition error */ }
      throw error;
    }
  }

  release(): void {
    const database = this.database;
    if (database === null) return;
    this.database = null;
    let markerError: unknown;
    try {
      unlinkSync(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") markerError = error;
    }
    try {
      database.exec("ROLLBACK");
    } catch {
      // SQLite rolls back an open transaction when the connection closes.
    }
    try {
      database.close();
    } catch (error) {
      if (markerError === undefined) markerError = error;
    }
    if (markerError !== undefined) throw markerError;
  }
}

/** Owns SQLite and worker processes; workers never receive the database handle. */
export class WorkerManager {
  private readonly now: () => number;
  private readonly options: WorkerManagerOptions;
  private readonly sessions: SessionRepository;
  private readonly commands: CommandRepository;
  private readonly eventStore: EventStore;
  private artifacts: ArtifactStore | undefined;
  private readonly scheduler: Scheduler;
  private readonly recovery: RecoveryManager;
  private readonly workers = new Map<string, ManagedWorker>();
  private readonly loading = new Map<string, Promise<void>>();
  private readonly commandSettledListeners = new Set<NonNullable<WorkerManagerOptions["onCommandSettled"]>>();
  private readonly settledCommandNotifications = new Set<string>();
  private readonly commandOrigins = new Map<string, string>();
  private readonly lock: InstanceLock;
  private started = false;
  private stopping = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly database: DatabaseSync, options: WorkerManagerOptions = {}) {
    this.options = options;
    this.now = options.now ?? (() => Date.now());
    this.sessions = new SessionRepository(database);
    this.commands = new CommandRepository(database);
    this.eventStore = options.eventStore ?? new EventStore(database, { now: this.now });
    this.scheduler = options.scheduler ?? new Scheduler(options.schedulerOptions);
    this.recovery = options.recovery ?? new RecoveryManager(database, {
      ...(options.recoveryOptions ?? {}),
      eventStore: this.eventStore,
      now: this.now
    });
    const stateDir = options.stateDir ?? "/state";
    this.lock = new InstanceLock(options.instanceLockPath ?? join(stateDir, "instance.lock"));
    if (options.onCommandSettled) this.commandSettledListeners.add(options.onCommandSettled);
  }

  get activeWorkerCount(): number {
    return this.workers.size;
  }

  hasPendingNativeReplacement(projectId: string): boolean {
    return [...this.workers.values()].some(worker => [...worker.replacementIntents.values()]
      .some(intent => {
        if (intent.projectId !== projectId || intent.destinationSessionId !== undefined) return false;
        if (!intent.sourceOperationId) return true;
        const operation = loadReducerState(this.database, intent.sourceSessionId, { includeTimeline: false }).operations[intent.sourceOperationId];
        return !operation || ["queued", "running", "waiting_input"].includes(operation.status);
      }));
  }

  get activeRunCount(): number {
    return this.scheduler.activeRunCount;
  }

  get schedulerState(): Scheduler {
    return this.scheduler;
  }

  /** Acquire the process lock and classify work left by a previous process. */
  start(): RecoveryReport[] {
    if (this.started) return [];
    this.lock.acquire();
    cleanupExpiredWorkerSpoolTemps(this.options.stateDir ?? "/state", this.now());
    this.started = true;
    this.stopping = false;
    this.heartbeatTimer = setInterval(() => this.checkHeartbeats(), Math.min(1000, this.options.heartbeatTimeoutMs ?? 15_000));
    unrefTimer(this.heartbeatTimer);
    try {
      return this.options.autoRecover === false ? [] : this.recovery.recoverAll();
    } catch (error) {
      if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
      this.started = false;
      this.lock.release();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.started || this.stopping) return;
    this.stopping = true;
    const workers = [...this.workers.values()];
    for (const worker of workers) {
      worker.gracefulStop = true;
      worker.phase = "stopping";
      this.send(worker, "shutdown", { reason: "server_shutdown" });
    }
    const timeout = this.options.shutdownTimeoutMs ?? 15_000;
    await Promise.race([
      Promise.all(workers.map((worker) => this.waitForExit(worker))),
      new Promise<void>((resolve) => setTimeout(resolve, timeout))
    ]);
    for (const worker of [...this.workers.values()]) {
      worker.gracefulStop = true;
      worker.process.kill("SIGTERM");
    }
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    this.lock.release();
    this.started = false;
    this.stopping = false;
  }

  async load(sessionId: string): Promise<void> {
    this.ensureStarted();
    const existing = this.workers.get(sessionId);
    if (existing) return existing.ready;
    const pending = this.loading.get(sessionId);
    if (pending) return pending;

    const start = this.startWorker(sessionId);
    this.loading.set(sessionId, start);
    try {
      await start;
    } finally {
      if (this.loading.get(sessionId) === start) this.loading.delete(sessionId);
    }
  }

  /**
   * Start a worker without waiting for SDK initialization to finish. This is
   * used by respond and other short control paths: initialization extensions
   * may be waiting for a form answer before the worker can announce ready.
   */
  beginLoad(sessionId: string): string | null {
    this.ensureStarted();
    const originalEpoch = this.workerEpoch(sessionId);
    if (originalEpoch) return originalEpoch;
    if (!this.loading.has(sessionId)) {
      const pending = this.startWorker(sessionId);
      this.loading.set(sessionId, pending);
      void pending.catch(() => undefined).finally(() => {
        if (this.loading.get(sessionId) === pending) this.loading.delete(sessionId);
      });
    }
    return this.workers.get(sessionId)?.epoch ?? null;
  }

  workerEpoch(sessionId: string): string | null {
    const pending = this.database.prepare("SELECT worker_epoch FROM interactions WHERE session_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1").get(sessionId) as Row | undefined;
    const original = pending ? [...this.workers.values()].find((worker) => worker.epoch === pending.worker_epoch && worker.ownedSessionIds.has(sessionId)) : undefined;
    return original?.epoch ?? this.workers.get(sessionId)?.epoch ?? null;
  }

  onCommandSettled(listener: NonNullable<WorkerManagerOptions["onCommandSettled"]>): () => void {
    this.commandSettledListeners.add(listener);
    return () => this.commandSettledListeners.delete(listener);
  }

  async setEditorState(sessionId: string, text: string): Promise<void> {
    // Editor input belongs to this exact Session. Unlike respond, it must not
    // attach to an old callback on a worker now bound to another Session.
    void this.load(sessionId).catch(() => undefined);
    const worker = this.workers.get(sessionId);
    if (!worker) throw new WorkerManagerError("WORKER_NOT_LOADED", "editor Session is not loaded");
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        worker.editorRequests.delete(requestId);
        reject(new WorkerManagerError("WORKER_QUERY_TIMEOUT", "worker did not acknowledge editor state"));
      }, this.options.mappingTimeoutMs ?? 15_000);
      worker.editorRequests.set(requestId, {
        resolve: () => { clearTimeout(timer); resolve(); },
        reject: (error) => { clearTimeout(timer); reject(error); }
      });
      if (!this.send(worker, "editor_state", { text, requestId })) {
        worker.editorRequests.get(requestId)!.reject(new WorkerManagerError("WORKER_DISCONNECTED", "editor state could not be sent"));
        worker.editorRequests.delete(requestId);
      }
    });
  }

  async modelCatalog(): Promise<ModelInfo[]> {
    return readPiModelCatalog({ agentDir: this.options.agentDir ?? this.options.piDir ?? "/state/pi", refresh: true });
  }

  async getModels(sessionId: string, refresh = false): Promise<{ items: ModelInfo[]; availableThinkingLevels: string[] }> {
    const worker = await this.workerFor(sessionId);
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        worker.modelRequests.delete(requestId);
        reject(new WorkerManagerError("WORKER_QUERY_TIMEOUT", "worker model query timed out"));
      }, this.options.mappingTimeoutMs ?? 15_000);
      worker.modelRequests.set(requestId, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); }
      });
      if (!this.send(worker, "get_models", { requestId, refresh })) {
        clearTimeout(timer);
        worker.modelRequests.delete(requestId);
        reject(new WorkerManagerError("WORKER_DISCONNECTED", "worker model query could not be sent"));
      }
    });
  }

  availableThinkingLevels(sessionId: string): string[] {
    return this.workers.get(sessionId)?.models?.availableThinkingLevels ?? [];
  }

  /** Notify an already loaded native session about a durable metadata intent. */
  notifyRename(sessionId: string, name: string): void {
    const worker = this.workers.get(sessionId);
    if (!worker || worker.phase !== "ready") return;
    const pending = loadReducerState(this.database, sessionId).metadataSync.pendingTitle;
    this.send(worker, "rename", { name: pending?.value ?? name, ...(pending ? { intentId: pending.intentId } : {}) });
  }

  private async startWorker(sessionId: string): Promise<void> {
    this.ensureStarted();
    const existing = this.workers.get(sessionId);
    if (existing) {
      await existing.ready;
      return;
    }
    const row = this.readSessionRuntime(sessionId);
    if (!this.scheduler.workerDecision().allowed) {
      throw new DispatchRejectedError("WORKER_CAPACITY", "configured worker capacity has been reached");
    }
    const workerId = `${sessionId}:${cryptoRandomUuid()}`;
    const registration = this.scheduler.registerWorker({ workerId, sessionId, workspaceKey: row.workspaceKey }, this.now());
    if (!registration.allowed) {
      throw new DispatchRejectedError(registration.code ?? "WORKER_CAPACITY", registration.message ?? "worker capacity is full");
    }
    const epoch = cryptoRandomUuid();
    const initializationOperationId = cryptoRandomUuid();
    try {
      this.appendInitializationEvent(sessionId, epoch, MANAGER_BATCH_BASE, initializationOperationId, "running");
    } catch (error) {
      this.scheduler.unregisterWorker(workerId);
      throw error;
    }
    const spoolDir = join(this.options.stateDir ?? "/state", "worker-spool", epoch);
    mkdirSync(spoolDir, { recursive: true, mode: 0o700 });
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawnWorker({
        nodeExecutable: this.options.nodeExecutable ?? process.execPath,
        workerScript: this.options.workerScript ?? defaultWorkerScript(),
        cwd: row.cwd,
        env: {
          ...process.env,
          ...(this.options.environment ?? {}),
          PI_REMOTE_WORKER_SPOOL_DIR: spoolDir,
          PI_REMOTE_WORKER_SESSION_ID: sessionId,
          PI_REMOTE_WORKER_EPOCH: epoch,
          PI_REMOTE_WORKER_HEARTBEAT_MS: String(this.options.workerHeartbeatMs ?? 5_000)
        }
      });
    } catch (error) {
      try {
        this.appendInitializationEvent(
          sessionId,
          epoch,
          MANAGER_BATCH_BASE + 1,
          initializationOperationId,
          "failed",
          error instanceof Error ? error.message : String(error)
        );
      } catch {
        // Preserve the spawn error; the next startup can classify the
        // initialization operation through normal recovery.
      }
      this.scheduler.unregisterWorker(workerId);
      throw error;
    }
    const readyParts = deferred<void>();
    const worker: ManagedWorker = {
      envelopeSessionId: sessionId,
      ownedSessionIds: new Set([sessionId]),
      replacementIntents: new Map(),
      workerId,
      sessionId,
      workspaceKey: row.workspaceKey,
      epoch,
      process: child,
      spoolDir,
      channel: undefined as unknown as WorkerIpcChannel,
      phase: "starting",
      initializationOperationId,
      initializationFinished: false,
      initializationInteractionSeen: false,
      models: null,
      editorRequests: new Map(),
      modelRequests: new Map(),
      gracefulStop: false,
      exitHandled: false,
      lastHeartbeat: this.now(),
      heartbeatActive: false,
      lastActivity: this.now(),
      mappingAcked: false,
      // Keep manager-generated batches after the initialization-start event.
      // Reusing the same (epoch, batchNo) would make the initialization
      // completion and the first dispatched command look like a conflicting
      // payload to the idempotent event store.
      managerBatchNo: MANAGER_BATCH_BASE + 1,
      ready: readyParts.promise,
      resolveReady: () => readyParts.resolve(undefined),
      rejectReady: (error) => readyParts.reject(error),
      messageChain: Promise.resolve(),
      leases: new Map()
    };
    this.workers.set(sessionId, worker);
    worker.channel = new WorkerIpcChannel({
      input: child.stdout,
      hydrateOutbound: (value) => hydrateSpooledOutbound(value, { spoolDir, sessionId, workerEpoch: epoch }),
      getOutboundSpoolFiles: (value) => {
        const fileName = outboundSpoolFileName(value);
        return fileName === null ? [] : [fileName];
      },
      output: child.stdin,
      onMessage: (message, context) => {
        worker.messageChain = worker.messageChain.then(() => this.handleMessage(worker, message, context.outboundSpoolFiles));
        return worker.messageChain;
      },
      onError: (error) => this.handleWorkerFailure(worker, error)
    });
    child.once("error", (error) => this.handleWorkerFailure(worker, error));
    child.once("exit", () => {
      // Real ChildProcess exit can precede the last stdout data. Drain only
      // after EOF; transport test doubles have no spawned OS process.
      if (typeof child.spawnfile === "string" && !child.stdout.readableEnded) {
        child.stdout.once("end", () => this.handleWorkerExit(worker));
      } else this.handleWorkerExit(worker);
    });
    // stderr is diagnostic only. It is intentionally not copied into the
    // protocol or persisted, so model prompts and secrets cannot leak there.
    child.stderr.on("data", () => {
      worker.lastActivity = this.now();
    });
    this.send(worker, "initialize", {
      cwd: row.cwd,
      agentDir: this.options.agentDir ?? this.options.piDir ?? "/state/pi",
      sessionDir: this.options.sessionDir ?? join(this.options.piDir ?? "/state/pi", "sessions"),
      ...(row.piSessionFile ? { sessionFile: row.piSessionFile } : {}),
      ...(row.piSessionId ? { sessionId: row.piSessionId } : {}),
      persistenceState: row.persistenceState,
      title: row.title,
      hasPendingTitle: loadReducerState(this.database, sessionId, { includeTimeline: false }).metadataSync.pendingTitle !== null,
      operationId: initializationOperationId,
      ...(row.model ? { model: row.model } : {}),
      ...(row.thinkingLevel ? { thinkingLevel: row.thinkingLevel } : {})
    });
    const timeoutMs = this.options.mappingTimeoutMs ?? 15_000;
    try {
      await this.waitForInitialization(worker, timeoutMs);
    } catch (error) {
      this.handleWorkerFailure(worker, error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  private waitForInitialization(worker: ManagedWorker, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      // A durable initialization interaction is progress, not a hung startup.
      // Once the hook has reached UI, its remaining lifetime is governed by
      // process heartbeats (including after the user answers the form).
      const timer = setTimeout(() => {
        if (worker.initializationInteractionSeen || this.hasPendingInteraction(worker.sessionId, worker.initializationOperationId)) return;
        reject(new WorkerManagerError("WORKER_START_TIMEOUT", "worker did not become ready"));
      }, timeoutMs);
      unrefTimer(timer);
      void worker.ready.then(resolve, reject).finally(() => clearTimeout(timer));
    });
  }

  async dispatch(request: DispatchRequest): Promise<DispatchResult> {
    this.ensureStarted();
    this.ensureCommandCanDispatch(request);
    const worker = await this.workerFor(request.sessionId);
    if (worker.sessionId !== request.sessionId) request = this.rehomeUndispatchedCommand(worker, request);
    const row = this.readSessionRuntime(request.sessionId);
    const isRun = request.kind === "prompt" || request.kind === "compact";
    let lease: ScheduleLease | undefined;
    const runId = isRun ? request.runId ?? cryptoRandomUuid() : null;
    if (isRun) {
      try {
        lease = this.scheduler.acquireRun({ sessionId: request.sessionId, workspaceKey: row.workspaceKey, runId: runId ?? undefined }, this.now());
      } catch (error) {
        if (error instanceof SchedulerBusyError) {
          throw new DispatchRejectedError(error.code, error.message);
        }
        throw error;
      }
      worker.leases.set(request.commandId, lease);
      this.scheduler.updateWorkerActivity(worker.workerId, { activeCall: true }, this.now());
    }
    let durable = false;
    try {
      this.ensureCommandCanDispatch(request);
      const preDispatch = this.persistPreDispatch(worker, request, runId);
      durable = true;
      const execute = this.executePayload(request, runId);
      const sent = this.send(worker, "execute", execute);
      if (!sent) throw new WorkerManagerError("WORKER_DISCONNECTED", "worker IPC is not writable");
      // This marker is deliberately written after the IPC write. Recovery can
      // therefore distinguish a durable dispatch intent from a command that
      // crossed the process boundary but never produced an ACK.
      this.commands.markDispatched(request.commandId, worker.epoch, this.now());
      return preDispatch;
    } catch (error) {
      if (durable) {
        try {
          this.recovery.recoverSession(request.sessionId, `recovery-${worker.epoch}`);
        } catch {
          // Startup recovery retries a classification that could not be
          // committed while returning the original dispatch error.
        }
      }
      if (lease) {
        worker.leases.delete(request.commandId);
        this.scheduler.releaseRun(lease);
        this.scheduler.updateWorkerActivity(worker.workerId, { activeCall: false }, this.now());
      }
      throw error;
    }
  }

  async sendControl<TType extends WorkerInboundMessage["type"]>(
    sessionId: string,
    type: TType,
    payload: Extract<WorkerInboundMessage, { type: TType }>["payload"],
    options: { waitForReady?: boolean } = {}
  ): Promise<void> {
    this.ensureStarted();
    const waitForReady = options.waitForReady !== false;
    const control = payload as Record<string, unknown>;
    const operationId = typeof control.operationId === "string" ? control.operationId : null;
    const runId = typeof control.runId === "string" ? control.runId : null;
    const runtime = operationId
      ? this.database.prepare("SELECT worker_epoch FROM interactions WHERE session_id = ? AND operation_id = ? AND status = 'pending' LIMIT 1").get(sessionId, operationId) as Row | undefined
      : runId ? this.database.prepare("SELECT worker_epoch FROM runs WHERE session_id = ? AND id = ?").get(sessionId, runId) as Row | undefined : undefined;
    const original = runtime ? [...this.workers.values()].find((candidate) => candidate.epoch === runtime.worker_epoch && candidate.ownedSessionIds.has(sessionId)) : undefined;
    if (!original) this.beginLoad(sessionId);
    const worker = original ?? this.workers.get(sessionId);
    if (!worker) throw new WorkerManagerError("WORKER_NOT_LOADED", `session ${sessionId} has no loaded worker`);
    if (waitForReady) await worker.ready;
    const sent = this.send(worker, type, payload);
    if (!sent) throw new WorkerManagerError("WORKER_DISCONNECTED", "worker IPC is not writable");
  }

  async reapIdleWorkers(now = this.now()): Promise<string[]> {
    const idleMs = this.options.workerIdleMs ?? 0;
    if (idleMs <= 0) return [];
    const reaped: string[] = [];
    for (const worker of [...this.workers.values()]) {
      if (worker.phase !== "ready") continue;
      const pendingInteractions = [...worker.ownedSessionIds].reduce((total, sessionId) => total + this.pendingInteractionCount(sessionId), 0);
      const durableActivity = this.hasDurableActivity(worker);
      this.scheduler.updateWorkerActivity(worker.workerId, {
        activeCall: worker.leases.size > 0 || worker.heartbeatActive || durableActivity,
        pendingInteractions,
        lastActivityAt: worker.lastActivity
      }, now);
      if (!this.scheduler.canReapWorker(worker.workerId, now, idleMs)) continue;
      worker.gracefulStop = true;
      worker.phase = "stopping";
      this.send(worker, "shutdown", { reason: "idle_reap" });
      reaped.push(worker.sessionId);
    }
    return reaped;
  }

  private hasDurableActivity(worker: ManagedWorker): boolean {
    return [...worker.ownedSessionIds].some((sessionId) => {
      const state = loadReducerState(this.database, sessionId, { includeTimeline: false });
      return Object.values(state.runs).some((run) => run.status === "running" || run.status === "stopping") ||
        Object.values(state.operations).some((operation) => operation.status === "running" || operation.status === "waiting_input");
    });
  }

  /** Test and operator hook: ignore frames from a previous worker epoch. */
  acceptsEpoch(sessionId: string, epoch: string): boolean {
    return this.workers.get(sessionId)?.epoch === epoch;
  }

  private ensureStarted(): void {
    if (!this.started) this.start();
    if (this.stopping) throw new WorkerManagerError("SERVER_STOPPING", "server is stopping");
  }

  private readSessionRuntime(sessionId: string): SessionRuntimeRow {
    const row = this.database.prepare(`
      SELECT s.id AS session_id, s.pi_session_file, s.pi_session_id, s.pi_persistence_state, s.title, s.model_json, s.thinking_level,
             s.history_error_code,
             p.root_path, p.workspace_key
      FROM sessions s JOIN projects p ON p.id = s.project_id
      WHERE s.id = ?
    `).get(sessionId) as Row | undefined;
    if (!row) throw new WorkerManagerError("NOT_FOUND", `session ${sessionId} does not exist`);
    const historyError = nullableText(row, "history_error_code");
    if (historyError !== null) throw new WorkerManagerError("HISTORY_UNAVAILABLE", `session history is unavailable: ${historyError}`);
    return {
      sessionId: requiredText(row, "session_id"),
      cwd: requiredText(row, "root_path"),
      workspaceKey: requiredText(row, "workspace_key"),
      piSessionFile: nullableText(row, "pi_session_file"),
      piSessionId: nullableText(row, "pi_session_id"),
      persistenceState: requiredText(row, "pi_persistence_state") as SessionRuntimeRow["persistenceState"],
      title: requiredText(row, "title"),
      model: parseModel(row),
      thinkingLevel: nullableText(row, "thinking_level")
    };
  }

  private spawnWorker(input: SpawnWorkerInput): ChildProcessWithoutNullStreams {
    const spawnWorker = this.options.spawnWorker ?? ((value: SpawnWorkerInput) => spawn(value.nodeExecutable, [value.workerScript], {
      cwd: value.cwd,
      env: value.env,
      stdio: ["pipe", "pipe", "pipe"]
    }));
    try {
      return spawnWorker(input);
    } catch (error) {
      throw new WorkerManagerError("WORKER_SPAWN_FAILED", error instanceof Error ? error.message : String(error));
    }
  }

  private async workerFor(sessionId: string): Promise<ManagedWorker> {
    const loading = this.load(sessionId);
    // Capture this exact startup. Its initialization hook may change its
    // current app binding before ready resolves.
    const starting = this.workers.get(sessionId);
    await loading;
    const worker = this.workers.get(sessionId) ?? starting;
    if (!worker || worker.phase === "exited") throw new WorkerManagerError("WORKER_NOT_LOADED", `session ${sessionId} worker disappeared`);
    return worker;
  }

  private rehomeUndispatchedCommand(worker: ManagedWorker, request: DispatchRequest): DispatchRequest {
    const sourceSessionId = request.sessionId;
    const destination = { ...request, sessionId: worker.sessionId, operationId: randomUUID(), ...(request.runId ? { runId: randomUUID() } : {}) };
    withTransaction(this.database, () => {
      const command = this.commands.get(request.commandId);
      const row = this.database.prepare("SELECT dispatched_at FROM commands WHERE id = ?").get(request.commandId) as Row | undefined;
      if (!command || command.state !== "queued" || row?.dispatched_at !== null || !worker.ownedSessionIds.has(sourceSessionId)) {
        throw new WorkerManagerError("COMMAND_NOT_QUEUED", "only an undispatched command can follow startup replacement");
      }
      const source = loadReducerState(this.database, sourceSessionId);
      const events: ProtocolEvent[] = [];
      let seq = source.lastSeq + 1;
      const oldRun = request.runId ? source.runs[request.runId] : undefined;
      if (oldRun) {
        if (oldRun.status !== "queued") throw new WorkerManagerError("STALE_RUN", "startup replacement cannot move an active Run");
        events.push(event(source, seq++, oldRun.runId, oldRun.operationId, "run.updated", {
          kind: oldRun.kind, status: "cancelled", phase: null, source: oldRun.source, commandId: request.commandId
        }, this.now()));
      }
      const oldOperation = source.operations[request.operationId];
      if (oldOperation) events.push(event(source, seq++, oldOperation.runId, oldOperation.operationId, "operation.updated", {
        operationId: oldOperation.operationId, kind: oldOperation.kind, status: "cancelled", commandId: request.commandId,
        ...(oldOperation.runId ? { runId: oldOperation.runId } : {})
      }, this.now()));
      const refs = [...(source.commands[request.commandId]?.runs ?? []), ...(destination.runId ? [{ runId: destination.runId, sessionId: destination.sessionId }] : [])];
      events.push(event(source, seq++, null, null, "command.updated", {
        commandId: request.commandId, kind: request.commandKind ?? request.kind, state: "dispatching", runs: refs
      }, this.now()));
      events.push(event(source, seq, null, null, "runtime.notice", {
        kind: "generic", message: "Command follows the native startup Session replacement",
        details: { commandId: request.commandId, appSessionId: destination.sessionId }
      }, this.now()));
      // Keep the original idempotency scope and payload. The execution owner
      // changes only before IPC; historical source events are never moved.
      this.database.prepare("UPDATE commands SET target_run_id = NULL, session_id = ? WHERE id = ?").run(destination.sessionId, request.commandId);
      this.eventStore.appendBatchWithinTransaction({ sessionId: sourceSessionId, workerEpoch: worker.epoch, batchNo: worker.managerBatchNo++, events });
      // Source projection is already dispatching so its UI does not resend;
      // the durable command remains queued until persistPreDispatch commits.
      this.database.prepare("UPDATE commands SET state = 'queued' WHERE id = ?").run(request.commandId);
    });
    this.commandOrigins.set(request.commandId, sourceSessionId);
    return destination;
  }

  private mirrorCommandUpdates(worker: ManagedWorker, events: ProtocolEvent[]): void {
    for (const update of events) {
      if (update.type !== "command.updated") continue;
      const sourceSessionId = this.commandOrigins.get(update.payload.commandId);
      if (!sourceSessionId || sourceSessionId === update.sessionId) continue;
      const source = loadReducerState(this.database, sourceSessionId);
      const prior = source.commands[update.payload.commandId];
      const refs = [...(prior?.runs ?? [])];
      for (const ref of update.payload.runs ?? []) {
        if (!refs.some((existing) => existing.runId === ref.runId && existing.sessionId === ref.sessionId)) refs.push(ref);
      }
      const { targetRunId: _target, ...payload } = update.payload;
      void _target;
      this.eventStore.appendBatchWithinTransaction({ sessionId: sourceSessionId, workerEpoch: worker.epoch, batchNo: worker.managerBatchNo++,
        events: [event(source, source.lastSeq + 1, null, null, "command.updated", { ...payload, runs: refs }, this.now())] });
    }
  }

  private send<TType extends WorkerInboundMessage["type"]>(
    worker: ManagedWorker,
    type: TType,
    payload: unknown
  ): boolean {
    if (worker.phase === "exited") return false;
    const message = makeIpcEnvelope(worker.envelopeSessionId, worker.epoch, type, payload) as unknown as WorkerInboundMessage;
    return worker.channel.send(message);
  }

  private ensureCommandCanDispatch(request: DispatchRequest): void {
    const row = this.database.prepare("SELECT session_id, state, kind FROM commands WHERE id = ?").get(request.commandId) as Row | undefined;
    if (!row) throw new DispatchRejectedError("COMMAND_NOT_FOUND", `command ${request.commandId} does not exist`);
    const commandSessionId = nullableText(row, "session_id");
    if (commandSessionId !== null && commandSessionId !== request.sessionId) {
      throw new DispatchRejectedError("NOT_FOUND", "command does not belong to the Session");
    }
    const state = requiredText(row, "state");
    if (state !== "queued") throw new DispatchRejectedError("COMMAND_NOT_QUEUED", `command is already ${state}`);
    if (requiredText(row, "kind") !== (request.commandKind ?? request.kind)) {
      throw new DispatchRejectedError("COMMAND_KIND_MISMATCH", "dispatch kind does not match the stored command");
    }
  }

  private executePayload(request: DispatchRequest, runId: string | null): WorkerExecutePayload {
    return {
      commandId: request.commandId,
      operationId: request.operationId,
      kind: request.kind,
      ...(runId ? { runId } : {}),
      ...(request.commandKind ? { commandKind: request.commandKind } : {}),
      ...(request.text ? { text: request.text } : {}),
      ...(request.instructions ? { instructions: request.instructions } : {}),
      ...(request.command ? { command: request.command } : {}),
      ...(request.excludeFromContext !== undefined ? { excludeFromContext: request.excludeFromContext } : {}),
      ...(request.streamingBehavior ? { streamingBehavior: request.streamingBehavior } : {}),
      ...(request.inputId ? { inputId: request.inputId } : {}),
      ...(request.content ? { content: request.content } : {})
    };
  }

  private persistPreDispatch(worker: ManagedWorker, request: DispatchRequest, runId: string | null): DispatchResult {
    const state = loadReducerState(this.database, request.sessionId);
    const now = this.now();
    const events: ProtocolEvent[] = [];
    let seq = state.lastSeq + 1;
    if (runId) {
      events.push(event(state, seq++, runId, request.operationId, "operation.updated", {
        operationId: request.operationId,
        kind: "run",
        status: "running",
        runId,
        commandId: request.commandId
      }, now));
      events.push(event(state, seq++, runId, request.operationId, "run.updated", {
        kind: request.kind,
        status: "queued",
        phase: "dispatching",
        source: "command",
        commandId: request.commandId
      }, now));
    } else {
      events.push(event(state, seq++, null, request.operationId, "operation.updated", {
        operationId: request.operationId,
        kind: request.kind === "extension_command" ? "extension" : "bash",
        status: "running",
        commandId: request.commandId
      }, now));
    }
    const commandKind = request.commandKind ?? request.kind;
    events.push(event(state, seq, null, null, "command.updated", {
      commandId: request.commandId,
      kind: commandKind,
      state: "dispatching",
      ...(runId ? { targetRunId: runId } : {}),
      runs: runId ? [{ runId, sessionId: request.sessionId }] : []
    }, now));
    const batchNo = worker.managerBatchNo++;
    const workerPid = processId(worker.process);
    const processGroupId = process.platform === "linux" ? workerPid : null;
    withTransaction(this.database, () => {
      this.eventStore.appendBatchWithinTransaction({
        sessionId: request.sessionId,
        workerEpoch: worker.epoch,
        batchNo,
        events
      });
      this.commands.markDispatched(request.commandId, worker.epoch, now);
      if (runId) {
        updateRunRuntimeMetadata(this.database, {
          runId,
          workerEpoch: worker.epoch,
          workerPid,
          workerStartTicks: null,
          processGroupId,
          executionScopeKey: `session:${request.sessionId}:run:${runId}:epoch:${worker.epoch}`,
          startedAt: now
        });
      }
    });
    return {
      commandId: request.commandId,
      operationId: request.operationId,
      runId,
      workerEpoch: worker.epoch,
      state: "dispatching"
    };
  }

  private async handleMessage(worker: ManagedWorker, message: WorkerOutboundMessage, outboundSpoolFiles: readonly string[] = []): Promise<void> {
    if (worker.phase === "exited" || message.workerEpoch !== worker.epoch || message.sessionId !== worker.envelopeSessionId) return;
    worker.lastActivity = this.now();
    switch (message.type) {
      case "session_replace_intent":
        await this.handleReplacementIntent(worker, message.payload);
        return;
      case "session_replaced":
        await this.handleReplacementBound(worker, message.payload);
        return;
      case "models":
        worker.models = { items: message.payload.items, availableThinkingLevels: message.payload.availableThinkingLevels };
        worker.modelRequests.get(message.payload.requestId)?.resolve(worker.models);
        worker.modelRequests.delete(message.payload.requestId);
        return;
      case "editor_state_ack":
        worker.editorRequests.get(message.payload.requestId)?.resolve();
        worker.editorRequests.delete(message.payload.requestId);
        return;
      case "rename_ack":
        this.sessions.acknowledgeTitle(worker.sessionId, message.payload.intentId);
        return;
      case "session_mapping":
        await this.handleMapping(worker, message.payload);
        return;
      case "ready":
        if (!worker.mappingAcked) {
          throw new WorkerManagerError("WORKER_PROTOCOL_ERROR", "worker became ready before its Session mapping was acknowledged");
        }
        await this.finishInitialization(worker);
        worker.phase = "ready";
        worker.lastHeartbeat = this.now();
        worker.resolveReady();
        this.notifyRename(worker.sessionId, this.sessions.get(worker.sessionId)!.title);
        return;
      case "session_persisted":
        {
          const sessionId = message.payload.appSessionId ?? worker.sessionId;
          if (!worker.ownedSessionIds.has(sessionId)) throw new WorkerManagerError("WORKER_PROTOCOL_ERROR", "unowned persistence notice");
          this.sessions.markPiPersisted(sessionId, this.now());
        }
        return;
      case "event_batch":
        await this.handleEventBatch(worker, message, outboundSpoolFiles);
        return;
      case "heartbeat":
        worker.lastHeartbeat = this.now();
        worker.heartbeatActive = message.payload.active;
        this.scheduler.updateWorkerActivity(worker.workerId, { activeCall: message.payload.active }, this.now());
        return;
      case "command_accepted":
        this.handleCommandAccepted(worker, message.payload.commandId);
        return;
      case "command_rejected":
        await this.handleCommandRejected(worker, message.payload);
        return;
      case "command_result":
        await this.handleCommandResult(worker, message);
        return;
      case "extension_error":
        await this.handleExtensionError(worker, message.payload);
        return;
      case "fatal":
        await this.handleWorkerFailure(worker, new WorkerManagerError(message.payload.code, message.payload.message));
        return;
      case "stopped":
        worker.phase = "stopping";
        // The worker sends this only after preceding event batches are ACKed.
        // Close its input now so the JSONL reader can finish and the idle
        // process can exit, instead of waiting forever for another command.
        if (!worker.process.stdin.writableEnded) worker.process.stdin.end();
        return;
    }
  }

  private appendReplacementNotice(worker: ManagedWorker, sessionId: string, phase: "intent" | "bound", details: Record<string, unknown>): void {
    const state = loadReducerState(this.database, sessionId);
    this.eventStore.appendBatchWithinTransaction({
      sessionId, workerEpoch: worker.epoch, batchNo: worker.managerBatchNo++,
      events: [event(state, state.lastSeq + 1, null, null, "runtime.notice", {
        kind: "generic", message: phase === "intent" ? "Native session replacement requested" : "Native session replacement mapped",
        details: { nativeSessionReplacement: { ...details, phase } }
      }, this.now())]
    });
  }

  private async handleReplacementIntent(worker: ManagedWorker, payload: Extract<WorkerOutboundMessage, { type: "session_replace_intent" }>["payload"]): Promise<void> {
    const previous = worker.replacementIntents.get(payload.requestId);
    if (previous) {
      this.send(worker, "session_replace_ack", { requestId: payload.requestId, phase: "intent", appSessionId: previous.sourceSessionId });
      return;
    }
    const source = this.sessions.getRow(worker.sessionId)!;
    if (source.pi_session_id !== payload.piSessionId || source.pi_session_file !== payload.piSessionFile) {
      throw new WorkerManagerError("HISTORY_UNAVAILABLE", "replacement source does not match the durable pi mapping");
    }
    const projects = new ProjectRepository(this.database);
    const ownerId = projects.getOwnerId(String(source.project_id));
    if (!ownerId) throw new WorkerManagerError("NOT_FOUND", "source project has no owner");
    let projectId = String(source.project_id);
    let targetFile: string | undefined;
    let targetPiSessionId: string | undefined;
    let targetCwd: string | undefined;
    let nativeLocation: { rootPath: string; rootIdentity: string; workspaceKey: string; gitCommonDir: string | null } | undefined;
    if (payload.kind === "switch" || payload.kind === "import") {
      if (!payload.targetFile) throw new WorkerManagerError("HISTORY_UNAVAILABLE", "native switch requires a target history");
      const inspected = await inspectPiSessionFile(payload.targetFile);
      if (inspected.kind !== "persisted") throw new WorkerManagerError("HISTORY_UNAVAILABLE", "native switch target history is invalid or missing");
      targetFile = inspected.path;
      targetPiSessionId = inspected.header.id;
      targetCwd = realpathSync(inspected.header.cwd);
      const info = statSync(targetCwd);
      if (!info.isDirectory()) throw new WorkerManagerError("HISTORY_UNAVAILABLE", "native history cwd is not a directory");
      const gitCommonDir = await new Promise<string | null>((resolveGit) => {
        execFile("git", ["-C", targetCwd!, "rev-parse", "--git-common-dir"], { timeout: 2000, maxBuffer: 4096 }, (error, stdout) => {
          if (error || !stdout.trim()) { resolveGit(null); return; }
          const path = isAbsolute(stdout.trim()) ? stdout.trim() : resolve(targetCwd!, stdout.trim());
          try { resolveGit(realpathSync(path)); } catch { resolveGit(path); }
        });
      });
      nativeLocation = { rootPath: targetCwd, rootIdentity: `${info.dev}:${info.ino}`, workspaceKey: gitCommonDir ? `git:${gitCommonDir}` : `path:${targetCwd}`, gitCommonDir };
      const target = this.database.prepare("SELECT id, project_id, pi_session_id, pi_session_file FROM sessions WHERE pi_session_file = ? OR pi_session_id = ?").get(targetFile, targetPiSessionId) as Row | undefined;
      if (target) {
        if (projects.getOwnerId(String(target.project_id)) !== ownerId || target.pi_session_id !== targetPiSessionId || (payload.kind === "switch" && target.pi_session_file !== targetFile)) {
          throw new WorkerManagerError("HISTORY_UNAVAILABLE", "native target mapping has a different owner or identity");
        }
        const targetProject = projects.get(String(target.project_id))!;
        if (realpathSync(targetProject.rootPath) !== targetCwd) throw new WorkerManagerError("HISTORY_UNAVAILABLE", "target project does not match native history cwd");
        projectId = targetProject.id;
      }
      const loaded = target ? this.workers.get(String(target.id)) : undefined;
      if (loaded && loaded !== worker) {
        const pending = [...loaded.ownedSessionIds].some((sessionId) => this.pendingInteractionCount(sessionId) > 0);
        if (loaded.leases.size || loaded.heartbeatActive || pending || this.hasDurableActivity(loaded)) {
          throw new WorkerManagerError("SESSION_BUSY", "the target native history is in use by another worker");
        }
        loaded.gracefulStop = true;
        loaded.phase = "stopping";
        this.send(loaded, "shutdown", { reason: "native_session_transfer" });
        await this.waitForExit(loaded);
      }
    }
    withTransaction(this.database, () => {
      if (nativeLocation) {
        const existingProject = projects.findByPhysicalIdentity(nativeLocation.rootPath, nativeLocation.rootIdentity);
        if (existingProject && projects.getOwnerId(existingProject.id) !== ownerId) throw new WorkerManagerError("NOT_FOUND", "native target directory belongs to another owner");
        projectId = existingProject?.id ?? projects.create({
          userId: ownerId, name: (basename(nativeLocation.rootPath) || nativeLocation.rootPath).slice(0, 120),
          ...nativeLocation, now: this.now()
        }).id;
      }
      this.appendReplacementNotice(worker, worker.sessionId, "intent", {
        ...payload, workerEpoch: worker.epoch, projectId,
        ...(targetCwd ? { targetCwd, targetPiSessionId } : {})
      });
    });
    worker.replacementIntents.set(payload.requestId, {
      sourceSessionId: worker.sessionId, kind: payload.kind, projectId,
      ...(payload.sourceOperationId ? { sourceOperationId: payload.sourceOperationId } : {}),
      ...(targetFile ? { targetFile, targetPiSessionId, targetCwd } : {})
    });
    this.send(worker, "session_replace_ack", { requestId: payload.requestId, phase: "intent", appSessionId: worker.sessionId });
  }

  private async handleReplacementBound(worker: ManagedWorker, payload: Extract<WorkerOutboundMessage, { type: "session_replaced" }>["payload"]): Promise<void> {
    const intent = worker.replacementIntents.get(payload.requestId);
    if (!intent) throw new WorkerManagerError("WORKER_PROTOCOL_ERROR", "replacement mapping has no acknowledged intent");
    if (intent.destinationSessionId) {
      const row = this.sessions.getRow(intent.destinationSessionId)!;
      if (row.pi_session_id !== payload.piSessionId || row.pi_session_file !== payload.piSessionFile) throw new WorkerManagerError("HISTORY_UNAVAILABLE", "replacement replay changed identity");
      this.send(worker, "session_replace_ack", { requestId: payload.requestId, phase: "bound", appSessionId: intent.destinationSessionId });
      return;
    }
    const source = this.sessions.get(intent.sourceSessionId)!;
    if (intent.kind === "import") {
      const imported = await inspectPiSessionFile(payload.piSessionFile);
      if (imported.kind !== "persisted" || imported.header.id !== intent.targetPiSessionId
        || payload.piSessionId !== intent.targetPiSessionId || realpathSync(imported.header.cwd) !== intent.targetCwd) {
        throw new WorkerManagerError("HISTORY_UNAVAILABLE", "imported history does not match the inspected identity and cwd");
      }
    }
    if (intent.kind === "switch" && (payload.piSessionId !== intent.targetPiSessionId || payload.piSessionFile !== intent.targetFile)) {
      throw new WorkerManagerError("HISTORY_UNAVAILABLE", "native replacement did not bind the inspected target history");
    }
    const destinationId = withTransaction(this.database, () => {
      const existing = this.database.prepare("SELECT id, project_id, pi_session_id, pi_session_file FROM sessions WHERE pi_session_id = ? OR pi_session_file = ?").all(payload.piSessionId, payload.piSessionFile) as Row[];
      if (existing.length > 1) throw new WorkerManagerError("HISTORY_UNAVAILABLE", "replacement identity and path have different owners");
      let sessionId: string;
      if (existing[0]) {
        if (existing[0].project_id !== intent.projectId || existing[0].pi_session_id !== payload.piSessionId) throw new WorkerManagerError("HISTORY_UNAVAILABLE", "replacement history belongs to another session");
        sessionId = String(existing[0].id);
        if (intent.kind !== "switch" && intent.kind !== "import" && sessionId === intent.sourceSessionId) throw new WorkerManagerError("HISTORY_UNAVAILABLE", "new/fork replacement reused source identity");
      } else {
        sessionId = this.sessions.create({ projectId: intent.projectId, title: source.title, now: this.now() }).id;
      }
      const active = this.workers.get(sessionId);
      if (active && active !== worker) throw new WorkerManagerError("SESSION_BUSY", "replacement target already has a worker");
      if (intent.kind === "import" && existing[0]) {
        this.sessions.rebindImportedHistory({ id: sessionId, piSessionId: payload.piSessionId,
          previousFile: String(existing[0].pi_session_file), piSessionFile: payload.piSessionFile, now: this.now() });
      } else this.sessions.setPiMapping({ id: sessionId, piSessionId: payload.piSessionId, piSessionFile: payload.piSessionFile, persistenceState: payload.persistenceState, now: this.now() });
      this.appendReplacementNotice(worker, intent.sourceSessionId, "bound", { ...payload, appSessionId: sessionId });
      return sessionId;
    });
    intent.destinationSessionId = destinationId;
    if (this.workers.get(worker.sessionId) === worker) this.workers.delete(worker.sessionId);
    worker.sessionId = destinationId;
    worker.workspaceKey = new ProjectRepository(this.database).get(intent.projectId)!.workspaceKey;
    this.scheduler.unregisterWorker(worker.workerId);
    this.scheduler.registerWorker({ workerId: worker.workerId, sessionId: destinationId, workspaceKey: worker.workspaceKey }, this.now());
    this.scheduler.updateWorkerActivity(worker.workerId, { activeCall: worker.heartbeatActive || worker.leases.size > 0 }, this.now());
    worker.ownedSessionIds.add(destinationId);
    worker.models = null;
    this.workers.set(destinationId, worker);
    this.send(worker, "session_replace_ack", { requestId: payload.requestId, phase: "bound", appSessionId: destinationId });
  }

  private async handleMapping(
    worker: ManagedWorker,
    payload: Extract<WorkerOutboundMessage, { type: "session_mapping" }>["payload"]
  ): Promise<void> {
    if (payload.fileState === "invalid" || payload.fileState === "identity_mismatch") {
      this.sessions.setHistoryError(worker.sessionId, "HISTORY_UNAVAILABLE", this.now());
      throw new WorkerManagerError("HISTORY_UNAVAILABLE", "worker returned an invalid Session history");
    }
    withTransaction(this.database, () => {
      this.sessions.setPiMapping({
        id: worker.sessionId,
        piSessionId: payload.piSessionId,
        piSessionFile: payload.piSessionFile,
        persistenceState: payload.persistenceState,
        now: this.now()
      });
    });
    worker.mappingAcked = true;
    if (!this.send(worker, "session_mapping_ack", {
      piSessionId: payload.piSessionId,
      piSessionFile: payload.piSessionFile
    })) throw new WorkerManagerError("WORKER_DISCONNECTED", "worker IPC is not writable during mapping ACK");
  }

  private appendInitializationEvent(
    sessionId: string,
    workerEpoch: string,
    batchNo: number,
    operationId: string,
    status: "running" | "completed" | "failed",
    message?: string
  ): void {
    const state = loadReducerState(this.database, sessionId);
    const payload = {
      operationId,
      kind: "initialize" as const,
      status,
      ...(message ? { error: runtimeError("WORKER_INITIALIZE_FAILED", message.slice(0, 1000)) } : {})
    };
    this.eventStore.appendBatch({
      sessionId,
      workerEpoch,
      batchNo,
      events: [event(state, state.lastSeq + 1, null, operationId, "operation.updated", payload, this.now())]
    });
  }

  private async finishInitialization(worker: ManagedWorker): Promise<void> {
    if (worker.initializationFinished) return;
    const state = loadReducerState(this.database, worker.envelopeSessionId);
    const operation = state.operations[worker.initializationOperationId];
    if (operation?.status !== "completed") {
      this.eventStore.appendBatch({
        sessionId: worker.envelopeSessionId,
        workerEpoch: worker.epoch,
        batchNo: worker.managerBatchNo++,
        events: [event(state, state.lastSeq + 1, null, worker.initializationOperationId, "operation.updated", {
          operationId: worker.initializationOperationId,
          kind: "initialize",
          status: "completed"
        }, this.now())]
      });
    }
    worker.initializationFinished = true;
  }

  private async handleEventBatch(
    worker: ManagedWorker,
    message: Extract<WorkerOutboundMessage, { type: "event_batch" }>,
    outboundSpoolFiles: readonly string[] = []
  ): Promise<void> {
    if (worker.epoch !== message.workerEpoch) return;
    let result: AppendEventBatchResult;
    try {
      for (const item of message.payload.events) {
        if (!worker.ownedSessionIds.has(item.sessionId)) throw new WorkerManagerError("WORKER_PROTOCOL_ERROR", "worker event targets an unowned Session");
      }
      const artifacts = this.artifacts ??= new ArtifactStore(this.database, { rootDir: this.options.outputDir ?? join(this.options.stateDir ?? "/state", "outputs"), now: this.now });
      const events = await archiveEventOutputs(message.payload.events, artifacts);
      const groups = new Map<string, ProtocolEvent[]>();
      for (const item of events) {
        const group = groups.get(item.sessionId) ?? [];
        group.push(item);
        groups.set(item.sessionId, group);
      }
      const results = withTransaction(this.database, () => [...groups].map(([sessionId, grouped]) => {
        const appended = this.eventStore.appendBatchWithinTransaction({
          sessionId,
          workerEpoch: sessionId === worker.envelopeSessionId ? worker.epoch : `${worker.epoch}:${sessionId}`,
          batchNo: message.payload.batchNo,
          events: grouped
        });
        const pendingTitle = loadReducerState(this.database, sessionId, { includeTimeline: false }).metadataSync.pendingTitle;
        if (pendingTitle && appended.events.some((item) => item.type === "session.updated" &&
          item.payload.changes.title !== undefined && item.payload.changes.title !== pendingTitle.value &&
          (item.payload.changes.version ?? 0) > pendingTitle.version)) {
          // A later native rename supersedes the older mobile intent; our
          // own native echo is suppressed and acknowledged by intent ID.
          this.sessions.acknowledgeTitle(sessionId, pendingTitle.intentId);
        }
        // Routing namespaces distinguish one mixed IPC batch in ipc_batches;
        // runtime identities remain the real worker epoch for controls.
        this.database.prepare("UPDATE interactions SET worker_epoch = ? WHERE session_id = ? AND worker_epoch = ?").run(worker.epoch, sessionId, `${worker.epoch}:${sessionId}`);
        this.database.prepare("UPDATE runs SET worker_epoch = ? WHERE session_id = ? AND worker_epoch = ?").run(worker.epoch, sessionId, `${worker.epoch}:${sessionId}`);
        if (!appended.duplicate) this.mirrorCommandUpdates(worker, appended.events);
        return appended;
      }));
      result = { duplicate: results.every((value) => value.duplicate), firstSeq: results[0]!.firstSeq, lastSeq: results.at(-1)!.lastSeq, events: results.flatMap((value) => value.events) };
    } catch (error) {
      await this.handleWorkerFailure(worker, error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if (result.events.some((item) => item.type === "interaction.requested" &&
      (item.operationId === worker.initializationOperationId || worker.phase === "starting"))) {
      worker.initializationInteractionSeen = true;
    }
    // ACK is written only after the event and all reducer projections commit.
    for (const persistedEvent of result.events) {
      if (persistedEvent.type !== "command.updated") continue;
      if (!this.isTerminalCommandState(persistedEvent.payload.state)) continue;
      this.settleCommandProjection(worker, persistedEvent.payload.commandId, persistedEvent.payload.state);
    }
    // The worker's event backlog and this transport spool are both durable
    // until this point. Keep the large frame if the ACK cannot cross the IPC
    // boundary; a later replay can then be hydrated and ACKed safely.
    if (this.send(worker, "batch_ack", { batchNo: message.payload.batchNo })) {
      removeOutboundSpoolFiles(worker.spoolDir, outboundSpoolFiles);
    }
  }

  private isTerminalCommandState(state: string): state is "completed" | "failed" | "cancelled" | "unknown" {
    return state === "completed" || state === "failed" || state === "cancelled" || state === "unknown";
  }

  /**
   * A worker may publish the terminal command projection before its
   * command_result frame (the result frame can contain Bash/config metadata).
   * Release scheduling state at the projection boundary, then let
   * finishCommand merge the later result without closing an unrelated Run.
   */
  private settleCommandProjection(
    worker: ManagedWorker,
    commandId: string,
    status: "completed" | "failed" | "cancelled" | "unknown"
  ): void {
    this.commands.markFinished(commandId, this.now());
    this.releaseLeaseAndNotify(worker, commandId, status === "unknown" ? "failed" : status);
  }

  private releaseLeaseAndNotify(
    worker: ManagedWorker,
    commandId: string,
    status: "completed" | "failed" | "cancelled"
  ): void {
    const lease = worker.leases.get(commandId);
    if (lease) {
      worker.leases.delete(commandId);
      this.scheduler.releaseRun(lease);
    }
    this.scheduler.updateWorkerActivity(worker.workerId, { activeCall: worker.leases.size > 0 }, this.now());
    if (this.settledCommandNotifications.has(commandId)) return;
    this.settledCommandNotifications.add(commandId);
    for (const listener of this.commandSettledListeners) {
      try {
        listener({ sessionId: this.commandOrigins.get(commandId) ?? this.commands.get(commandId)?.sessionId ?? worker.sessionId, commandId, state: status });
      } catch {
        // Observers must not turn a committed result into a failed delivery.
      }
    }
  }

  private handleCommandAccepted(worker: ManagedWorker, commandId: string): void {
    const now = this.now();
    const sessionId = this.commands.get(commandId)?.sessionId ?? worker.sessionId;
    const row = this.database.prepare("SELECT state FROM commands WHERE id = ?").get(commandId) as Row | undefined;
    if (!row || requiredText(row, "state") !== "dispatching") return;
    const state = loadReducerState(this.database, sessionId);
    const projection = state.commands[commandId];
    const events: ProtocolEvent[] = [event(state, state.lastSeq + 1, null, null, "command.updated", {
      commandId,
      kind: projection?.kind ?? "prompt",
      state: "accepted",
      ...(projection?.targetRunId ? { targetRunId: projection.targetRunId } : {}),
      runs: projection?.runs ?? []
    }, now)];
    withTransaction(this.database, () => {
      this.eventStore.appendBatchWithinTransaction({
        sessionId: sessionId,
        workerEpoch: worker.epoch,
        batchNo: worker.managerBatchNo++,
        events
      });
      this.commands.markAccepted(commandId, worker.epoch, now);
    });
  }

  private async handleCommandRejected(
    worker: ManagedWorker,
    payload: Extract<WorkerOutboundMessage, { type: "command_rejected" }>["payload"]
  ): Promise<void> {
    if (!payload.commandId) return;
    await this.finishCommand(worker, payload.commandId, "failed", payload.code, payload.message);
  }

  private async handleCommandResult(
    worker: ManagedWorker,
    message: Extract<WorkerOutboundMessage, { type: "command_result" }>
  ): Promise<void> {
    const status = terminalCommandState(message);
    await this.finishCommand(
      worker,
      message.payload.commandId,
      status,
      message.payload.error?.code,
      message.payload.error?.message,
      message.payload.result
    );
  }

  private async handleExtensionError(
    worker: ManagedWorker,
    payload: Extract<WorkerOutboundMessage, { type: "extension_error" }>["payload"]
  ): Promise<void> {
    const sessionId = payload.sessionId ?? worker.sessionId;
    if (!worker.ownedSessionIds.has(sessionId)) throw new WorkerManagerError("WORKER_PROTOCOL_ERROR", "extension error targets an unowned Session");
    const state = loadReducerState(this.database, sessionId);
    const notice = event(state, state.lastSeq + 1, null, payload.operationId ?? null, "runtime.notice", {
      kind: "generic",
      message: `extension ${payload.event} failed: ${payload.error}`.slice(0, 32768),
      details: {
        extensionPath: payload.extensionPath,
        event: payload.event,
        ...(payload.stack ? { stack: payload.stack } : {})
      }
    }, this.now());
    withTransaction(this.database, () => {
      this.eventStore.appendBatchWithinTransaction({
        sessionId,
        workerEpoch: worker.epoch,
        batchNo: worker.managerBatchNo++,
        events: [notice]
      });
    });
  }

  private async finishCommand(
    worker: ManagedWorker,
    commandId: string,
    status: "completed" | "failed" | "cancelled",
    errorCode?: string,
    errorMessage?: string,
    result?: Record<string, unknown>
  ): Promise<void> {
    const sessionId = this.commands.get(commandId)?.sessionId ?? worker.sessionId;
    if (!worker.ownedSessionIds.has(sessionId)) throw new WorkerManagerError("WORKER_PROTOCOL_ERROR", "command reply targets an unowned Session");
    const state = loadReducerState(this.database, sessionId);
    const projection = state.commands[commandId];
    const commandRow = this.database.prepare("SELECT kind, state, payload_json FROM commands WHERE id = ?").get(commandId) as Row | undefined;
    if (!commandRow) return;
    const kind = projection?.kind ?? requiredText(commandRow, "kind");
    const currentState = projection?.state ?? requiredText(commandRow, "state");
    if (this.isTerminalCommandState(currentState)) {
      if (currentState !== status) {
        throw new WorkerManagerError(
          "WORKER_PROTOCOL_ERROR",
          `command ${commandId} changed from ${currentState} to ${status}`
        );
      }
      // The worker's command.updated projection is authoritative for the
      // lifecycle. command_result can arrive afterwards and carry the only
      // useful result (for example Bash output or actual configuration).
      const errorMatches = errorCode === undefined || projection?.error?.code === errorCode;
      const resultMatches = result === undefined || JSON.stringify(projection?.result) === JSON.stringify(result);
      if (!errorMatches || !resultMatches) {
        const errorDetail = errorCode ? runtimeError(errorCode, errorMessage ?? errorCode) : undefined;
        const eventState = state.commands[commandId];
        const eventPayload: Record<string, unknown> = {
          commandId,
          kind,
          state: currentState,
          ...(eventState?.targetRunId ? { targetRunId: eventState.targetRunId } : {}),
          runs: eventState?.runs ?? [],
          ...(errorDetail ? { error: errorDetail } : {}),
          ...(result ? { result } : {})
        };
        withTransaction(this.database, () => {
          this.eventStore.appendBatchWithinTransaction({
            sessionId: sessionId,
            workerEpoch: worker.epoch,
            batchNo: worker.managerBatchNo++,
            events: [event(state, state.lastSeq + 1, null, null, "command.updated", eventPayload, this.now())]
          });
          this.mirrorCommandUpdates(worker, [event(state, state.lastSeq + 1, null, null, "command.updated", eventPayload, this.now())]);
          this.commands.markFinished(commandId, this.now());
        });
      } else {
        this.commands.markFinished(commandId, this.now());
      }
      this.releaseLeaseAndNotify(
        worker,
        commandId,
        currentState === "completed" ? "completed" : currentState === "cancelled" ? "cancelled" : "failed"
      );
      return;
    }
    const targetRunId = projection?.targetRunId ?? null;
    const candidateRun = targetRunId ? state.runs[targetRunId] : undefined;
    const run = candidateRun?.commandId === commandId ? candidateRun : undefined;
    const operationId = run?.operationId ?? this.operationIdForCommand(state, commandId);
    const events: ProtocolEvent[] = [];
    let seq = state.lastSeq + 1;
    const errorDetail = errorCode ? runtimeError(errorCode, errorMessage ?? errorCode) : undefined;
    if (run && (run.status === "queued" || run.status === "running" || run.status === "stopping")) {
      if (status !== "completed" && !run.contentSealed) {
        events.push(event(state, seq++, run.runId, run.operationId, "run.content_sealed", {
          reason: status === "cancelled" ? "aborted" : "failed"
        }, this.now()));
      }
      events.push(event(state, seq++, run.runId, run.operationId, "run.updated", {
        kind: run.kind,
        status: status === "completed" ? "completed" : status === "cancelled" ? "aborted" : "failed",
        phase: null,
        source: run.source,
        ...(run.commandId ? { commandId: run.commandId } : {}),
        ...(errorDetail ? { error: errorDetail } : {})
      }, this.now()));
      events.push(event(state, seq++, run.runId, run.operationId, "operation.updated", {
        operationId: run.operationId,
        kind: "run",
        status: status === "completed" ? "completed" : status === "cancelled" ? "cancelled" : "failed",
        runId: run.runId,
        ...(run.commandId ? { commandId: run.commandId } : {}),
        ...(errorDetail ? { error: errorDetail } : {})
      }, this.now()));
    } else if (operationId !== null) {
      const operation = state.operations[operationId];
      if (operation && status !== "completed" && Object.values(state.liveItems).some((item) => item.operationId === operationId)) {
        events.push(event(state, seq++, null, operationId, "operation.content_sealed", {
          reason: status === "cancelled" ? "aborted" : "failed"
        }, this.now()));
      }
      const pendingInteraction = operationId !== null && this.hasPendingInteraction(sessionId, operationId);
      const keepConfigureOpen = operation !== undefined &&
        (kind === "set_model" || kind === "set_thinking") &&
        status === "completed" &&
        pendingInteraction;
      if (operation && (kind === "set_model" || kind === "set_thinking") && status === "completed") {
        const actualConfig = result?.actualConfig;
        const config = actualConfig !== null && typeof actualConfig === "object" && !Array.isArray(actualConfig)
          ? actualConfig as Record<string, unknown>
          : {};
        const changes: Record<string, unknown> = {
          actualConfig: config
        };
        if (config.model !== undefined) changes.model = config.model;
        if (config.thinkingLevel !== undefined) changes.thinkingLevel = config.thinkingLevel;
        events.push(event(state, seq++, null, null, "session.updated", { changes }, this.now()));
      }
      if (operation && !keepConfigureOpen && !["completed", "failed", "interrupted", "cancelled"].includes(operation.status)) {
        events.push(event(state, seq++, null, operationId, "operation.updated", {
          operationId,
          kind: operation.kind,
          status: status === "completed" ? "completed" : status === "cancelled" ? "cancelled" : "failed",
          ...(operation.runId ? { runId: operation.runId } : {}),
          ...(operation.commandId ? { commandId: operation.commandId } : {}),
          ...(errorDetail ? { error: errorDetail } : {})
        }, this.now()));
      }
    }
    events.push(event(state, seq, run?.runId ?? null, operationId, "command.updated", {
      commandId,
      kind,
      state: status,
      ...(targetRunId ? { targetRunId } : {}),
      runs: projection?.runs ?? (run ? [{ runId: run.runId, sessionId: sessionId }] : []),
      ...(errorDetail ? { error: errorDetail } : {}),
      ...(result ? { result } : {})
    }, this.now()));
    const finishedAt = this.now();
    withTransaction(this.database, () => {
      if (events.length > 0) {
        this.eventStore.appendBatchWithinTransaction({
          sessionId: sessionId,
          workerEpoch: worker.epoch,
          batchNo: worker.managerBatchNo++,
          events
        });
        this.mirrorCommandUpdates(worker, events);
      }
      this.commands.markFinished(commandId, finishedAt);
    });
    this.releaseLeaseAndNotify(worker, commandId, status);
  }

  private hasPendingInteraction(sessionId: string, operationId: string): boolean {
    const row = this.database.prepare(
      "SELECT 1 AS pending FROM interactions WHERE session_id = ? AND operation_id = ? AND status = 'pending' LIMIT 1"
    ).get(sessionId, operationId) as Row | undefined;
    return row !== undefined;
  }

  private operationIdForCommand(state: ReducerState, commandId: string): string | null {
    const operation = Object.values(state.operations).find((candidate) => candidate.commandId === commandId);
    return operation?.operationId ?? null;
  }

  private pendingInteractionCount(sessionId: string): number {
    const row = this.database.prepare(
      "SELECT COUNT(*) AS count FROM interactions WHERE session_id = ? AND status = 'pending'"
    ).get(sessionId) as Row | undefined;
    const value = row?.count;
    return Number.isSafeInteger(value) ? Number(value) : 0;
  }

  private checkHeartbeats(): void {
    const now = this.now();
    const timeout = this.options.heartbeatTimeoutMs ?? 15_000;
    for (const worker of [...this.workers.values()]) {
      if (worker.phase === "exited" || worker.phase === "stopping") continue;
      if (now - worker.lastHeartbeat <= timeout) continue;
      void this.handleWorkerFailure(worker, new WorkerManagerError("WORKER_HEARTBEAT_TIMEOUT", "worker heartbeat timed out"));
    }
  }

  private async handleWorkerFailure(worker: ManagedWorker, error: Error): Promise<void> {
    if (worker.exitHandled) return;
    worker.gracefulStop = false;
    if (error instanceof WorkerManagerError && /HISTORY|SESSION_FILE|IDENTITY/.test(error.code)) {
      this.sessions.setHistoryError(worker.sessionId, error.code, this.now());
    }
    worker.rejectReady(error);
    for (const request of worker.modelRequests.values()) request.reject(error);
    worker.modelRequests.clear();
    for (const request of worker.editorRequests.values()) request.reject(error);
    worker.editorRequests.clear();
    try {
      worker.process.kill("SIGTERM");
    } catch {
      // The exit handler performs the durable recovery if the process is gone.
    }
  }

  private handleWorkerExit(worker: ManagedWorker): void {
    void worker.channel.drain().catch(() => undefined).then(() => this.finalizeWorkerExit(worker));
  }

  private finalizeWorkerExit(worker: ManagedWorker): void {
    if (worker.exitHandled) return;
    const error = new WorkerManagerError("WORKER_DISCONNECTED", "worker exited");
    worker.rejectReady(error);
    for (const request of worker.modelRequests.values()) request.reject(error);
    worker.modelRequests.clear();
    for (const request of worker.editorRequests.values()) request.reject(error);
    worker.editorRequests.clear();
    worker.exitHandled = true;
    worker.phase = "exited";
    worker.channel.close();
    const ownsSessionSlot = this.workers.get(worker.sessionId) === worker;
    if (ownsSessionSlot) {
      this.workers.delete(worker.sessionId);
      this.scheduler.unregisterWorker(worker.workerId);
    }
    for (const lease of worker.leases.values()) this.scheduler.releaseRun(lease);
    worker.leases.clear();
    if (!ownsSessionSlot) return;
    if (!worker.gracefulStop || this.stopping) {
      try {
        for (const sessionId of worker.ownedSessionIds) {
          if (!this.workers.has(sessionId)) this.recovery.recoverSession(sessionId, `recovery-${worker.epoch}:${sessionId}`);
        }
      } catch {
        // Preserve the original process failure. The next explicit startup
        // will retry recovery and surface a storage error if it remains.
      }
    }
  }

  private waitForExit(worker: ManagedWorker): Promise<void> {
    if (worker.phase === "exited") return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setInterval(() => {
        if (worker.phase === "exited") {
          clearInterval(timer);
          resolve();
        }
      }, 10);
      unrefTimer(timer);
    });
  }
}

function cryptoRandomUuid(): string {
  // Kept as a tiny wrapper so tests can replace the process boundary without
  // importing a crypto implementation into their fake worker.
  return randomUUID();
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export { InstanceLock };
