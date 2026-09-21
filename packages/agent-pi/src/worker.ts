import { AsyncLocalStorage } from "node:async_hooks";
import { createInterface, type Interface } from "node:readline";
import { randomUUID } from "node:crypto";
import { readFileSync, mkdtempSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventBacklog } from "./event-backlog.js";
import { WidgetHost, type WidgetFactory } from "./widget-host.js";
import { SurfaceHost, type SurfaceMethod } from "./surface-host.js";
import { runCustomUi } from "./custom-ui.js";
import { EditorHost } from "./editor-host.js";
import { createModelSelector, findEditorModel, type ModelSelection } from "./model-selector.js";
import { createThinkingSelector, type ThinkingSelection } from "./thinking-selector.js";
import { createTrustSelector } from "./trust-selector.js";
import { saveProjectTrust, type TrustSelection } from "./project-trust.js";
import { createSettingsSelector } from "./settings-selector.js";
import { createScopedModelsSelector } from "./scoped-models-selector.js";
import { EDITOR_COMMANDS, PENDING_EDITOR_COMMANDS, sessionInformation, hotkeyInformation, changelogInformation, editorPathArgument, createInformationViewer } from "./editor-commands.js";
import { createSessionSelector } from "./session-selector.js";
import { createForkSelector } from "./fork-selector.js";
import { createTreeSelector } from "./tree-selector.js";
import { CombinedAutocompleteProvider, matchesKey } from "@earendil-works/pi-tui";
import { TerminalInputHub } from "./terminal-input.js";
import { encodeSpooledOutbound } from "./outbound-spool.js";
import { fileURLToPath } from "node:url";
import {
  parseProtocolEvent,
  jsonObjectSchema,
  type InputContent,
  type ContentBlock,
  type JsonObject,
  type ModelRef,
  type ModelInfo,
  type ProtocolEvent,
  type OperationKind,
  type OperationStatus
} from "@pi-remote/protocol";
import {
  createPiWorkerSession,
  type PiSessionReplacementRequest,
  type PiAgentSessionHandle,
  type PiAgentSessionOptions
} from "./runtime.js";
import { inspectPiSessionFile, PiSessionHistoryError, type PiSessionFileState } from "./session-file.js";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type {
  AgentSession,
  AgentSessionEvent,
  ExtensionError,
  ExtensionUIContext,
  ExtensionUIDialogOptions,
  UserBashEventResult
} from "@earendil-works/pi-coding-agent";

const nativeSlashCommands = await import(new URL("./core/slash-commands.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href) as {
  BUILTIN_SLASH_COMMANDS: Array<{ name: string }>;
};

function unrefTimer(timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval> | undefined): void {
  if (timer === undefined) return;
  (timer as unknown as { unref?: () => void }).unref?.();
}

export const IPC_VERSION = 1 as const;

export type WorkerCommandKind =
  | "prompt"
  | "compact"
  | "bash"
  | "extension_command"
  | "steer"
  | "follow_up"
  | "abort"
  | "abort_bash"
  | "respond"
  | "set_model"
  | "set_thinking"
  | "rename"
  | "shutdown";

export interface IpcEnvelope<TType extends string = string, TPayload = unknown> {
  ipcVersion: typeof IPC_VERSION;
  sessionId: string;
  workerEpoch: string;
  type: TType;
  payload: TPayload;
}

export interface WorkerInitializePayload {
  cwd: string;
  agentDir: string;
  sessionDir: string;
  sessionFile?: string;
  sessionId?: string;
  persistenceState?: "uninitialized" | "unflushed" | "persisted";
  title?: string;
  hasPendingTitle?: boolean;
  /** Operation used by extension/session-start UI before the worker is ready. */
  operationId?: string;
  model?: ModelRef | null;
  thinkingLevel?: string | null;
}

export interface WorkerExecutePayload {
  commandId: string;
  operationId: string;
  runId?: string;
  /** The SDK entry point to invoke. Extension commands use session.prompt(). */
  kind: "prompt" | "compact" | "bash" | "extension_command";
  /** The external command kind. A follow_up is executed by the prompt entry point. */
  commandKind?: "prompt" | "follow_up" | "compact" | "bash" | "extension_command";
  text?: string;
  instructions?: string;
  command?: string;
  excludeFromContext?: boolean;
  streamingBehavior?: "steer" | "followUp";
  content?: InputContent;
  inputId?: string;
}

export interface WorkerInputPayload {
  commandId?: string;
  operationId?: string;
  runId?: string;
  inputId: string;
  content: InputContent;
  text: string;
  streamingBehavior?: "steer" | "followUp";
}

export interface WorkerModelPayload {
  commandId?: string;
  operationId?: string;
  provider: string;
  modelId: string;
  persist?: boolean;
}

export interface WorkerThinkingPayload {
  commandId?: string;
  operationId?: string;
  level: string;
  persist?: boolean;
}

export interface WorkerRespondPayload {
  commandId?: string;
  operationId: string;
  interactionId: string;
  response: Record<string, unknown>;
}

export interface WorkerExtensionErrorPayload {
  sessionId?: string;
  operationId?: string;
  extensionPath: string;
  event: string;
  error: string;
  stack?: string;
}

export interface WorkerSessionMappingPayload {
  piSessionId: string;
  piSessionFile: string;
  persistenceState: "unflushed" | "persisted";
  fileState: PiSessionFileState["kind"];
}

export interface WorkerReadyPayload {
  pid: number;
  processGroupId: number | null;
  workerStartTicks: string | null;
  persistenceState: "unflushed" | "persisted";
}

export interface WorkerEventBatchPayload {
  batchNo: number;
  events: ProtocolEvent[];
}

export interface WorkerCommandResultPayload {
  commandId: string;
  status: "completed" | "failed" | "cancelled";
  error?: { code: string; message?: string };
  result?: Record<string, unknown>;
}

export type WorkerInboundMessage =
  | IpcEnvelope<"session_replace_ack", { requestId: string; phase: "intent" | "bound"; appSessionId: string }>
  | IpcEnvelope<"initialize", WorkerInitializePayload>
  | IpcEnvelope<"session_mapping_ack", { piSessionId: string; piSessionFile: string }>
  | IpcEnvelope<"execute", WorkerExecutePayload>
  | IpcEnvelope<"steer", WorkerInputPayload>
  | IpcEnvelope<"follow_up", WorkerInputPayload>
  | IpcEnvelope<"abort", { commandId?: string; runId: string; preserveQueue?: boolean }>
  | IpcEnvelope<"abort_bash", { commandId?: string }>
  | IpcEnvelope<"respond", WorkerRespondPayload>
  | IpcEnvelope<"set_model", WorkerModelPayload>
  | IpcEnvelope<"set_thinking", WorkerThinkingPayload>
  | IpcEnvelope<"rename", { name: string; intentId?: string }>
  | IpcEnvelope<"editor_state", { text: string; requestId?: string }>
  | IpcEnvelope<"get_models", { requestId: string; refresh?: boolean }>
  | IpcEnvelope<"batch_ack", { batchNo: number }>
  | IpcEnvelope<"shutdown", { reason?: string }>;

export type WorkerOutboundMessage =
  | IpcEnvelope<"session_replace_intent", { requestId: string; kind: "new" | "switch" | "fork" | "import"; sourceOperationId?: string; piSessionId: string; piSessionFile: string; targetFile?: string }>
  | IpcEnvelope<"session_replaced", { requestId: string; piSessionId: string; piSessionFile: string; persistenceState: "unflushed" | "persisted" }>
  | IpcEnvelope<"models", { requestId: string; items: ModelInfo[]; availableThinkingLevels: string[] }>
  | IpcEnvelope<"editor_state_ack", { requestId: string }>
  | IpcEnvelope<"rename_ack", { name: string; intentId: string }>
  | IpcEnvelope<"session_mapping", WorkerSessionMappingPayload>
  | IpcEnvelope<"session_persisted", { pid: number; at: string; appSessionId?: string }>
  | IpcEnvelope<"ready", WorkerReadyPayload>
  | IpcEnvelope<"command_accepted", { commandId: string; runId?: string; operationId?: string }>
  | IpcEnvelope<"command_rejected", { commandId?: string; code: string; message: string }>
  | IpcEnvelope<"command_result", WorkerCommandResultPayload>
  | IpcEnvelope<"extension_error", WorkerExtensionErrorPayload>
  | IpcEnvelope<"event_batch", WorkerEventBatchPayload>
  | IpcEnvelope<"heartbeat", { pid: number; at: string; active: boolean }>
  | IpcEnvelope<"fatal", { code: string; message: string; details?: Record<string, unknown> }>
  | IpcEnvelope<"stopped", { reason: string }>;

export interface WorkerTransport {
  send(message: WorkerOutboundMessage): void;
}

export interface WorkerSessionFactory {
  (options: PiAgentSessionOptions): Promise<PiAgentSessionHandle>;
}

interface Execution {
  commandId: string;
  operationId: string;
  runId: string | null;
  kind: "prompt" | "compact" | "bash" | "extension_command";
  operationKind: OperationKind;
  commandKind: "prompt" | "follow_up" | "compact" | "bash" | "extension_command";
  abortRequested: boolean;
  finished: boolean;
  persistedNoticeSent: boolean;
  assistantOutcome?: { stopReason: string; error?: string };
}

interface TrackedInput {
  inputId: string;
  operationId: string;
  runId: string | null;
  commandId: string | null;
  delivery: "steer" | "followUp";
  content: InputContent;
  text: string;
}

interface PendingInteraction {
  interactionId: string;
  operationId: string;
  runId: string | null;
  operationKind: OperationKind;
  kind: "select" | "confirm" | "input" | "editor";
  options?: string[];
  resolve: (value: Record<string, unknown> | undefined) => void;
  settled: boolean;
  timer?: ReturnType<typeof setTimeout>;
  removeAbortListener?: () => void;
}

interface OperationContext {
  operationId: string;
  runId: string | null;
  kind: OperationKind;
}

interface ControlOperation {
  operationId: string;
  commandId: string;
  kind: "configure";
}

interface PendingBatch {
  message: WorkerOutboundMessage;
  backlogLeaseId: string | null;
}

interface ToolContext {
  operationId: string;
  runId: string | null;
}

type RecordValue = Record<string, unknown>;

function recordValue(value: unknown): RecordValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as RecordValue
    : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function boolValue(value: unknown): boolean {
  return value === true;
}

function nowTimestamp(): string {
  return new Date().toISOString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function bounded(value: string, max = 32768): string {
  return value.length <= max ? value : value.slice(0, max);
}

function jsonObject(value: unknown): JsonObject {
  return jsonObjectSchema.parse(recordValue(value) ?? {});
}

function textFromUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function roleOf(message: unknown): "user" | "assistant" | "custom" | "bash" | null {
  const role = recordValue(message)?.role;
  if (role === "user" || role === "assistant" || role === "custom") return role;
  if (role === "bashExecution") return "bash";
  return null;
}

function contentBlocks(message: unknown, messageId: string): ContentBlock[] {
  const record = recordValue(message);
  const content = record?.content;
  if (typeof content === "string") return [{ id: `${messageId}:0`, index: 0, kind: "text", text: content }];
  if (!Array.isArray(content)) return [];
  const blocks: ContentBlock[] = [];
  for (let index = 0; index < content.length; index += 1) {
    const candidate = recordValue(content[index]);
    if (!candidate) continue;
    const type = candidate.type;
    const id = `${messageId}:${index}`;
    if (type === "text" && typeof candidate.text === "string") {
      blocks.push({ id, index, kind: "text", text: candidate.text });
    } else if (type === "thinking" && typeof candidate.thinking === "string") {
      blocks.push({
        id,
        index,
        kind: "thinking",
        text: candidate.thinking,
        ...(candidate.redacted === true ? { redacted: true } : {})
      });
    } else if (type === "toolCall" && typeof candidate.id === "string" && typeof candidate.name === "string") {
      blocks.push({
        id,
        index,
        kind: "tool_call",
        toolCallId: candidate.id,
        toolName: candidate.name,
        arguments: jsonObject(candidate.arguments)
      });
    }
  }
  return blocks;
}

/**
 * The SDK worker deliberately owns only SDK state and the native executor.
 * It never opens SQLite and never decides whether a command is safe to retry.
 * The parent process persists and classifies every durable outcome.
 */
export class PiWorker {
  private readonly factory: WorkerSessionFactory;
  private eventBuffer: ProtocolEvent[] = [];
  private backlog: EventBacklog | undefined;
  private flushScheduled = false;
  private readonly deferredMessages: WorkerOutboundMessage[] = [];
  private handle: PiAgentSessionHandle | undefined;
  private initialized = false;
  private mappingAcknowledged = false;
  private stopped = false;
  private batchNo = 0;
  private readonly pendingBatches = new Map<number, PendingBatch>();
  private readonly messageIds = new WeakMap<object, string>();
  private readonly activeMessageIds = new Map<string, string>();
  private clearingQueue = false;
  private renaming = false;
  private editorText = "";
  private readonly editorHost = new EditorHost();
  private readonly terminalInputs = new Map<string, TerminalInputHub>();
  private toolsExpanded = false;
  private readonly widgetHost = new WidgetHost();
  private readonly surfaceHosts = new Map<string, SurfaceHost>();
  private agentDir?: string;
  private readonly customControllers = new Set<AbortController>();
  private readonly controllerOwners = new Map<AbortController, string>();
  private readonly extensionUiKeys = new Map<string, { widgets: Set<string>; statuses: Set<string> }>();
  private readonly reloading = new Set<string>();
  private currentSessionId: string;
  private readonly persistedMappings = new Set<string>();
  private readonly replacementRequests = new WeakMap<PiSessionReplacementRequest, string>();
  private readonly replacementAcks = new Map<string, { resolve: (appSessionId: string) => void; reject: (error: Error) => void }>();
  private readonly operationSessions = new Map<string, string>();
  private readonly causalCommands = new Map<string, { commandId: string; kind: Execution["commandKind"]; state: "accepted" | "completed" | "failed" | "cancelled"; refs: { runId: string; sessionId: string }[] }>();
  private readonly closedOperations = new Set<string>();
  private readonly standaloneOperations = new Set<string>();
  private autonomous: (OperationContext & { source: "extension" | "runtime"; commandId?: string; outcome?: { stopReason: string; error?: string } }) | undefined;
  private bashExecution: Execution | undefined;
  private readonly startedBlocks = new Set<string>();
  private readonly startedMessages = new Set<string>();
  private readonly toolMessages = new Map<string, ToolContext>();
  private readonly messageContexts = new Map<string, ToolContext>();
  private readonly pendingInteractions = new Map<string, PendingInteraction>();
  private readonly pendingInputs: { steering: TrackedInput[]; followUp: TrackedInput[] } = {
    steering: [],
    followUp: []
  };
  private execution: Execution | undefined;
  // Extension slash commands are handled by AgentSession.prompt() even while
  // the main agent turn is streaming. Keep them separate from the model
  // execution so they do not fabricate a Run or steal its event ownership.
  private readonly extensionExecutions = new Map<string, Execution>();
  private readonly controlOperations = new Map<string, ControlOperation>();
  private readonly uiContextStorage = new AsyncLocalStorage<OperationContext>();
  private initializationOperationId: string | null = null;
  private mappingAckResolver: (() => void) | undefined;
  private mappingAckRejecter: ((error: Error) => void) | undefined;
  private readonly heartbeatTimer: ReturnType<typeof setInterval>;
  private readonly sessionId: string;
  private readonly workerEpoch: string;

  constructor(
    private readonly transport: WorkerTransport,
    options: {
      sessionId: string;
      workerEpoch: string;
      factory?: WorkerSessionFactory;
      heartbeatMs?: number;
    }
  ) {
    this.sessionId = options.sessionId;
    this.currentSessionId = options.sessionId;
    this.workerEpoch = options.workerEpoch;
    this.factory = options.factory ?? ((sessionOptions) => createPiWorkerSession({
      ...sessionOptions,
      onBeforeSessionReplace: (request) => this.beforeSessionReplace(request),
      onSessionReplaced: (session, request) => this.afterSessionReplace(session, request),
      runInSessionContext: async (_session, callback) => {
        const context = this.createStandaloneOperation(this.currentSessionId);
        try { return await this.uiContextStorage.run(context, callback); }
        finally {
          if (this.standaloneOperations.delete(context.operationId) && !this.closedOperations.has(context.operationId)) this.emitOperationStatus("completed", context);
        }
      }
    }));
    const heartbeatMs = options.heartbeatMs ?? 5_000;
    this.heartbeatTimer = setInterval(() => {
      this.send("heartbeat", {
        pid: process.pid,
        at: nowTimestamp(),
        active: this.execution !== undefined || this.bashExecution !== undefined || this.extensionExecutions.size > 0
      });
    }, heartbeatMs);
    unrefTimer(this.heartbeatTimer);
  }

  async receive(message: WorkerInboundMessage): Promise<void> {
    if (message.ipcVersion !== IPC_VERSION || message.sessionId !== this.sessionId || message.workerEpoch !== this.workerEpoch) {
      return;
    }
    switch (message.type) {
      case "session_replace_ack": {
        const key = `${message.payload.requestId}:${message.payload.phase}`;
        this.replacementAcks.get(key)?.resolve(message.payload.appSessionId);
        this.replacementAcks.delete(key);
        return;
      }
      case "initialize":
        // Initialization waits for the parent's mapping ACK. Do not hold the
        // line reader open while waiting, otherwise the ACK can never be
        // delivered to receive().
        void this.initialize(message.payload);
        return;
      case "session_mapping_ack":
        this.acceptMappingAck(message.payload);
        return;
      case "batch_ack":
        this.ackBatch(message.payload.batchNo);
        return;
      case "execute":
        void this.execute(message.payload);
        return;
      case "steer":
        void this.steer(message.payload);
        return;
      case "follow_up":
        void this.followUp(message.payload);
        return;
      case "abort":
        void this.abort(message.payload);
        return;
      case "abort_bash":
        this.abortBash(message.payload);
        return;
      case "respond":
        this.respond(message.payload);
        return;
      case "set_model":
        void this.setModel(message.payload);
        return;
      case "set_thinking":
        void this.setThinking(message.payload);
        return;
      case "get_models":
        void this.sendModels(message.payload);
        return;
      case "editor_state":
        this.editorText = message.payload.text;
        // Repeated handset snapshots must not reset native cursor/completion state.
        if (this.editorHost.getText() !== message.payload.text) this.editorHost.setText(message.payload.text);
        if (message.payload.requestId) this.send("editor_state_ack", { requestId: message.payload.requestId });
        return;
      case "rename":
        this.rename(message.payload);
        return;
      case "shutdown":
        await this.shutdown(message.payload.reason ?? "parent_shutdown");
        return;
    }
  }

  dispose(): void {
    for (const hub of this.terminalInputs.values()) hub.clear();
    this.terminalInputs.clear();
    this.editorHost.reset();
    for (const controller of this.customControllers) controller.abort();
    this.widgetHost.dispose();
    for (const host of this.surfaceHosts.values()) host.dispose();
    this.surfaceHosts.clear();
    this.cancelPendingInteractions("worker_disposed");
    clearInterval(this.heartbeatTimer);
    this.handle?.dispose();
    this.backlog?.dispose();
    for (const ack of this.replacementAcks.values()) ack.reject(new Error("worker disposed"));
    this.replacementAcks.clear();
    this.handle = undefined;
  }

  private envelope<TType extends string, TPayload>(type: TType, payload: TPayload): IpcEnvelope<TType, TPayload> {
    return {
      ipcVersion: IPC_VERSION,
      sessionId: this.sessionId,
      workerEpoch: this.workerEpoch,
      type,
      payload
    };
  }

  private send<TType extends WorkerOutboundMessage["type"]>(
    type: TType,
    payload: Extract<WorkerOutboundMessage, { type: TType }>["payload"]
  ): void {
    // Terminal/control records must never overtake earlier content batches.
    this.flushEvents();
    const message = this.envelope(type, payload) as WorkerOutboundMessage;
    if ((this.backlog?.length || this.eventBuffer.length || this.pendingBatches.size > 0) && type !== "heartbeat" && type !== "fatal") {
      this.deferredMessages.push(message);
    } else this.transport.send(message);
  }

  private hasPersistedHistory(session: AgentSession): boolean {
    // SDK isPersisted() means persistence is enabled, not that _persist flushed.
    const path = session.sessionFile;
    if (!path) return false;
    let fd: number | undefined;
    try {
      fd = openSync(path, "r");
      const bytes = Buffer.alloc(16384);
      const length = readSync(fd, bytes, 0, bytes.length, 0);
      const newline = bytes.indexOf(10, 0);
      if (newline < 0 || newline >= length) return false;
      const header = JSON.parse(bytes.subarray(0, newline).toString("utf8")) as RecordValue;
      return header.type === "session" && header.id === session.sessionId;
    } catch { return false; }
    finally { if (fd !== undefined) closeSync(fd); }
  }

  private notifyPersistence(): void {
    const session = this.handle?.session;
    if (!session || this.persistedMappings.has(session.sessionId) || !this.hasPersistedHistory(session)) return;
    this.persistedMappings.add(session.sessionId);
    this.send("session_persisted", { pid: process.pid, at: nowTimestamp(), appSessionId: this.currentSessionId });
  }

  private replacementAck(requestId: string, phase: "intent" | "bound"): Promise<string> {
    return new Promise((resolve, reject) => this.replacementAcks.set(`${requestId}:${phase}`, { resolve, reject }));
  }

  private async beforeSessionReplace(request: PiSessionReplacementRequest): Promise<void> {
    const requestId = randomUUID();
    this.replacementRequests.set(request, requestId);
    const ack = this.replacementAck(requestId, "intent");
    const context = this.operationContext();
    this.send("session_replace_intent", { requestId, kind: request.kind,
      ...(context ? { sourceOperationId: context.operationId } : {}),
      piSessionId: request.session.sessionId, piSessionFile: request.session.sessionFile!,
      ...(request.sessionPath ? { targetFile: request.sessionPath } : {}) });
    await ack;
  }

  private async afterSessionReplace(session: AgentSession, request?: PiSessionReplacementRequest): Promise<void> {
    const requestId = request && this.replacementRequests.get(request);
    if (!requestId || !session.sessionFile) throw new Error("native replacement has no durable intent");
    const ack = this.replacementAck(requestId, "bound");
    this.send("session_replaced", { requestId, piSessionId: session.sessionId, piSessionFile: session.sessionFile,
      persistenceState: this.hasPersistedHistory(session) ? "persisted" : "unflushed" });
    const sourceSessionId = this.currentSessionId;
    this.currentSessionId = await ack;
    this.terminalInputs.get(sourceSessionId)?.clear();
    this.editorHost.reset();
    if (request) this.replacementRequests.delete(request);
    // Expansion belongs to the surviving UI runtime, but the destination
    // needs its own durable projection after the mapping is acknowledged.
    const context = this.createStandaloneOperation(this.currentSessionId);
    this.uiContextStorage.run(context, () => {
      this.emitUi("setToolsExpanded", [this.toolsExpanded]);
      const name = session.sessionManager.getSessionName();
      if (name) this.onSessionEvent({ type: "session_info_changed", name });
    });
    this.standaloneOperations.delete(context.operationId);
    this.emitOperationStatus("completed", context);
    await this.sendModels({ requestId: "runtime-state" });
  }

  private async initialize(payload: WorkerInitializePayload): Promise<void> {
    this.agentDir = payload.agentDir;
    if (this.initialized || this.initializationOperationId || this.stopped) {
      this.fatal("WORKER_ALREADY_INITIALIZED", "worker was initialized more than once");
      return;
    }
    try {
      this.initializationOperationId = payload.operationId ?? randomUUID();
      const sessionOptions: PiAgentSessionOptions = {
        cwd: payload.cwd,
        agentDir: payload.agentDir,
        sessionDir: payload.sessionDir,
        projectTrustContextFactory: cwd => {
          const ui = this.createUiContext();
          return { cwd, mode: "rpc", hasUI: true, ui: {
            confirm: ui.confirm, input: ui.input, notify: ui.notify,
            select: async (title, options, dialogOptions) => {
              const result = await this.requestInteraction("select", title, { options, message: title }, dialogOptions);
              return typeof result?.value === "string" ? result.value : undefined;
            }
          } };
        },
        onProjectTrustError: message => this.createUiContext().notify(message, "warning"),
        ...(payload.sessionFile ? { sessionFile: payload.sessionFile } : {}),
        ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
        ...(payload.persistenceState ? { persistenceState: payload.persistenceState } : {})
      };
      this.handle = await this.factory(sessionOptions);
      // Extension session-start hooks can suspend initialization on an RPC
      // form. Mark the SDK handle usable before binding extensions so the
      // parent can deliver respond while mapping/ready is still pending.
      this.initialized = true;
      const initializationContext: OperationContext = {
        operationId: this.initializationOperationId ?? randomUUID(),
        runId: null,
        kind: "initialize"
      };
      const sessionFile = this.handle.session.sessionFile ?? this.handle.sessionManager.getSessionFile();
      if (!sessionFile) throw new Error("SDK did not allocate a session file");
      const fileState = this.handle.sessionFileState ?? await inspectPiSessionFile(sessionFile, payload.cwd);
      const persistenceState = fileState.kind === "persisted" || this.hasPersistedHistory(this.handle.session)
        ? "persisted"
        : "unflushed";
      const mappingAck = new Promise<void>((resolve, reject) => {
        this.mappingAckResolver = resolve;
        this.mappingAckRejecter = reject;
      });
      this.send("session_mapping", {
        piSessionId: this.handle.session.sessionId,
        piSessionFile: sessionFile,
        persistenceState,
        fileState: fileState.kind
      });
      await mappingAck;
      if (this.stopped) return;
      this.mappingAcknowledged = true;
      this.handle.onEvent((event) => this.onSessionEvent(event));
      const nativeName = this.handle.sessionManager.getSessionName?.();
      if (!payload.hasPendingTitle && nativeName) this.onSessionEvent({ type: "session_info_changed", name: nativeName });
      await this.sendModels({ requestId: "runtime-state" });
      await this.uiContextStorage.run(initializationContext, async () => {
        // A new worker starts with the native collapsed-tools default. Publish
        // it so an older mobile snapshot cannot retain another worker's flag.
        this.emitUi("setToolsExpanded", [this.toolsExpanded]);
        if (payload.model) {
          const model = this.handle!.services.modelRuntime.getModel(payload.model.provider, payload.model.id);
          if (!model) throw new Error(`model ${payload.model.provider}/${payload.model.id} is not available`);
          await this.handle!.session.setModel(model, { persist: false });
        }
        if (payload.thinkingLevel && this.handle!.session.model) {
          type ThinkingLevel = Parameters<PiAgentSessionHandle["session"]["setThinkingLevel"]>[0];
          this.handle!.session.setThinkingLevel(payload.thinkingLevel as ThinkingLevel);
        }
        await this.handle!.bindExtensions({
          mode: "rpc",
          uiContext: this.createUiContext(),
          onError: (error) => this.onExtensionError(error),
          abortHandler: () => {
            const runId = this.execution?.runId ?? this.autonomous?.runId;
            if (runId) void this.abort({ runId });
            else { this.clearSdkQueue(); void this.handle!.session.abort(); }
          }
        });
        // Defaults and initialization hooks may select a model without an
        // explicit configure command. Publish the final SDK state before ready
        // so snapshots and empty-session reloads retain the effective config.
        const model = this.handle!.session.model;
        const thinkingLevel = this.handle!.session.thinkingLevel ?? null;
        const changes: Record<string, unknown> = {};
        if ((model?.provider ?? null) !== (payload.model?.provider ?? null) ||
            (model?.id ?? null) !== (payload.model?.id ?? null)) {
          changes.model = model ? { provider: model.provider, id: model.id } : null;
        }
        if (thinkingLevel !== (payload.thinkingLevel ?? null)) changes.thinkingLevel = thinkingLevel;
        if (Object.keys(changes).length > 0) {
          this.emitSessionConfig(changes);
          this.flushEvents();
        }
        await this.sendModels({ requestId: "runtime-state" });
      });
      this.initializationOperationId = null;
      this.send("ready", {
        pid: process.pid,
        processGroupId: process.platform === "linux" ? process.pid : null,
        workerStartTicks: this.readStartTicks(),
        persistenceState
      });
    } catch (error) {
      this.fatal(error instanceof PiSessionHistoryError ? "HISTORY_UNAVAILABLE" : "WORKER_INITIALIZE_FAILED", errorMessage(error));
    }
  }

  private acceptMappingAck(payload: { piSessionId: string; piSessionFile: string }): void {
    if (!this.handle) return;
    const file = this.handle.session.sessionFile ?? this.handle.sessionManager.getSessionFile();
    if (this.handle.session.sessionId !== payload.piSessionId || file !== payload.piSessionFile) {
      this.mappingAckRejecter?.(new Error("session mapping ACK does not match SDK allocation"));
      this.mappingAckResolver = undefined;
      this.mappingAckRejecter = undefined;
      return;
    }
    this.mappingAckResolver?.();
    this.mappingAckResolver = undefined;
    this.mappingAckRejecter = undefined;
  }

  private async execute(payload: WorkerExecutePayload): Promise<void> {
    if (!this.mappingAcknowledged || !this.handle) {
      this.rejectCommand(payload.commandId, "WORKER_NOT_READY", "worker is not ready");
      return;
    }
    const isExtension = payload.kind === "extension_command";
    const isBash = payload.kind === "bash";
    if ((isBash && this.bashExecution) || (this.execution && !isExtension && !isBash)) {
      this.rejectCommand(payload.commandId, "WORKER_BUSY", "worker already has an active SDK operation");
      return;
    }
    this.operationSessions.set(payload.operationId, this.currentSessionId);
    const runId = payload.kind === "bash" || payload.kind === "extension_command" ? null : payload.runId ?? null;
    const execution: Execution = {
      commandId: payload.commandId,
      operationId: payload.operationId,
      runId,
      kind: payload.kind,
      commandKind: payload.commandKind ?? payload.kind,
      operationKind: payload.kind === "bash" ? "bash" : payload.kind === "extension_command" ? "extension" : "run",
      abortRequested: false,
      finished: false,
      persistedNoticeSent: false
    };
    this.causalCommands.set(payload.operationId, { commandId: payload.commandId, kind: payload.commandKind ?? payload.kind,
      state: "accepted", refs: runId ? [{ runId, sessionId: this.currentSessionId }] : [] });
    if (isExtension) this.extensionExecutions.set(payload.commandId, execution);
    else if (isBash) this.bashExecution = execution;
    else this.execution = execution;
    this.send("command_accepted", {
      commandId: payload.commandId,
      ...(runId ? { runId } : {}),
      operationId: payload.operationId
    });
    const context: OperationContext = {
      operationId: execution.operationId,
      runId: execution.runId,
      kind: execution.operationKind
    };
    try {
      if (execution.runId) this.emitEvent({
        sessionId: this.sessionId, seq: 1, runId: execution.runId, operationId: execution.operationId,
        schemaVersion: 1, timestamp: nowTimestamp(), type: "run.updated",
        payload: { kind: execution.kind === "compact" ? "compact" : "prompt", status: "running",
          phase: execution.kind === "compact" ? "compacting" : "thinking", source: "command", commandId: execution.commandId }
      });
      await this.uiContextStorage.run(context, async () => {
        if (payload.kind === "prompt") {
          if (!payload.text) throw new Error(`${payload.kind} text is required`);
          if (payload.inputId && payload.content) {
            const input: TrackedInput = {
              inputId: payload.inputId,
              operationId: payload.operationId,
              runId,
              commandId: payload.commandId,
              delivery: payload.commandKind === "follow_up" ? "followUp" : "steer",
              content: structuredClone(payload.content),
              text: payload.text
            };
            this.emitInputUpdated(input, "queued");
            // A direct prompt is handed to the SDK immediately. It is not part
            // of clearQueue(), so its input is consumed at the call boundary.
            this.emitInputUpdated(input, "consumed");
          }
          await this.handle!.session.prompt(payload.text, {
            source: "rpc",
            ...(payload.streamingBehavior ? { streamingBehavior: payload.streamingBehavior } : {})
          });
        } else if (payload.kind === "extension_command") {
          if (!payload.text) throw new Error("extension command text is required");
          await this.handle!.session.prompt(payload.text, { source: "rpc" });
        } else if (payload.kind === "compact") {
          await this.handle!.session.compact(payload.instructions);
        } else {
          if (!payload.command) throw new Error("bash command is required");
          const result = await this.executeUserBash(payload.command, payload.excludeFromContext === true, payload.commandId);
          await this.finishExecution(execution, execution.abortRequested ? "aborted" : "completed", undefined, result);
          return;
        }
        const outcome = execution.assistantOutcome;
        const status = execution.abortRequested || outcome?.stopReason === "aborted" ? "aborted" : outcome?.stopReason === "error" ? "failed" : "completed";
        await this.finishExecution(execution, status, status === "failed" ? outcome?.error ?? "Model request failed" : undefined);
      });
    } catch (error) {
      await this.uiContextStorage.run(context, () =>
        this.finishExecution(execution, execution.abortRequested ? "aborted" : "failed", errorMessage(error))
      );
    }
  }

  private async finishExecution(
    execution: Execution,
    status: "completed" | "failed" | "aborted",
    message?: string,
    result?: Record<string, unknown>
  ): Promise<void> {
    if (execution.finished) return;
    execution.finished = true;
    const causal = this.causalCommands.get(execution.operationId);
    if (causal) causal.state = status === "aborted" ? "cancelled" : status;
    const reason = status === "failed" ? "failed" : status === "aborted" ? "aborted" : undefined;
    if (execution.runId && reason) {
      this.emitEvent({
        sessionId: this.sessionId,
        seq: 1,
        runId: execution.runId,
        operationId: execution.operationId,
        schemaVersion: 1,
        timestamp: nowTimestamp(),
        type: "run.content_sealed",
        payload: { reason }
      });
    }
    const runTerminal = execution.runId
      ? {
          sessionId: this.sessionId,
          seq: 1,
          runId: execution.runId,
          operationId: execution.operationId,
          schemaVersion: 1 as const,
          timestamp: nowTimestamp(),
          type: "run.updated" as const,
          payload: {
            kind: execution.kind === "compact" ? "compact" as const : "prompt" as const,
            status: status === "completed" ? "completed" as const : status === "aborted" ? "aborted" as const : "failed" as const,
            phase: null,
            source: "command" as const,
            commandId: execution.commandId,
            ...(message ? { error: { code: "SDK_OPERATION_FAILED", message: bounded(message, 1000) } } : {})
          }
        }
      : null;
    if (runTerminal) this.emitEvent(runTerminal);
    this.emitEvent({
      sessionId: this.sessionId,
      seq: 1,
      runId: execution.runId,
      operationId: execution.operationId,
      schemaVersion: 1,
      timestamp: nowTimestamp(),
      type: "operation.updated",
      payload: {
        operationId: execution.operationId,
        kind: execution.operationKind,
        status: status === "completed" ? "completed" : status === "aborted" ? "cancelled" : "failed",
        runId: execution.runId ?? undefined,
        commandId: execution.commandId,
        ...(message ? { error: { code: "SDK_OPERATION_FAILED", message: bounded(message, 1000) } } : {})
      }
    });
    this.emitEvent({
      sessionId: this.sessionId,
      seq: 1,
      runId: execution.runId,
      operationId: execution.operationId,
      schemaVersion: 1,
      timestamp: nowTimestamp(),
      type: "command.updated",
      payload: {
        commandId: execution.commandId,
        kind: execution.commandKind,
        state: status === "completed" ? "completed" : status === "aborted" ? "cancelled" : "failed",
        targetRunId: execution.runId ?? undefined,
        runs: this.causalCommands.get(execution.operationId)?.refs ?? [],
        ...(message ? { error: { code: "SDK_OPERATION_FAILED", message: bounded(message, 1000) } } : {})
      }
    });
    this.send("command_result", {
      commandId: execution.commandId,
      status: status === "completed" ? "completed" : status === "aborted" ? "cancelled" : "failed",
      ...(message ? { error: { code: "SDK_OPERATION_FAILED", message: bounded(message, 1000) } } : {}),
      ...(result ? { result } : {})
    });
    this.notifyPersistence();

    if (this.execution === execution) this.execution = undefined;
    if (this.bashExecution === execution) this.bashExecution = undefined;
    if (this.extensionExecutions.get(execution.commandId) === execution) {
      this.extensionExecutions.delete(execution.commandId);
    }
  }

  private operationContext(): OperationContext | null {
    // The SDK can have a model Run, an extension command, and an asynchronous
    // configuration hook alive at the same time. AsyncLocalStorage is the
    // ownership boundary: always prefer the context captured at the SDK call
    // site over mutable "current execution" fields.
    const scoped = this.uiContextStorage.getStore();
    // A delayed hook from a closed operation is still causally scoped. Let
    // callers create a child operation instead of borrowing an unrelated Run.
    if (scoped) return this.closedOperations.has(scoped.operationId) ? null : scoped;
    if (this.autonomous) return this.autonomous;
    if (this.execution) {
      return {
        operationId: this.execution.operationId,
        runId: this.execution.runId,
        kind: this.execution.operationKind
      };
    }
    if (this.initializationOperationId) {
      return { operationId: this.initializationOperationId, runId: null, kind: "initialize" };
    }
    return null;
  }

  private emitOperationStatus(status: OperationStatus, context = this.operationContext()): void {
    if (!context) return;
    this.emitEvent({
      sessionId: this.sessionId,
      seq: 1,
      runId: context.runId,
      operationId: context.operationId,
      schemaVersion: 1,
      timestamp: nowTimestamp(),
      type: "operation.updated",
      payload: {
        operationId: context.operationId,
        kind: context.kind,
        status,
        ...(context.runId ? { runId: context.runId } : {})
      }
    });
  }

  private controlInput(payload: WorkerInputPayload, delivery: "steer" | "followUp"): TrackedInput {
    const content = payload.content ?? { text: payload.text };
    const context = this.operationContext();
    return {
      inputId: payload.inputId || randomUUID(),
      operationId: payload.operationId ?? context?.operationId ?? this.initializationOperationId ?? randomUUID(),
      runId: payload.runId ?? context?.runId ?? null,
      commandId: payload.commandId ?? null,
      delivery,
      content: structuredClone(content),
      text: payload.text
    };
  }

  private emitInputUpdated(input: TrackedInput, state: "queued" | "consumed" | "returned" | "unknown"): void {
    this.emitEvent({
      sessionId: this.sessionId,
      seq: 1,
      runId: input.runId,
      operationId: input.operationId,
      schemaVersion: 1,
      timestamp: nowTimestamp(),
      type: "input.updated",
      payload: {
        inputId: input.inputId,
        delivery: input.delivery,
        state,
        ...(input.commandId ? { commandId: input.commandId } : {}),
        ...(state === "queued" || state === "returned" || state === "unknown" ? { content: structuredClone(input.content) } : {})
      }
    });
  }

  private removeTrackedInput(input: TrackedInput): void {
    const list = input.delivery === "steer" ? this.pendingInputs.steering : this.pendingInputs.followUp;
    const index = list.indexOf(input);
    if (index >= 0) list.splice(index, 1);
  }

  /** Reconcile SDK FIFO queue updates without using text as an identity key. */
  private reconcileSdkQueue(delivery: "steer" | "followUp", current: readonly string[]): void {
    const list = delivery === "steer" ? this.pendingInputs.steering : this.pendingInputs.followUp;
    if (this.clearingQueue || current.length >= list.length) return;
    const removed = list.length - current.length;
    const suffixMatches = current.every((value, index) => list[index + removed]?.text === value);
    if (!suffixMatches) return;
    for (let index = 0; index < removed; index += 1) {
      const input = list.shift();
      if (input) this.emitInputUpdated(input, "consumed");
    }
  }

  private clearSdkQueue(): { steering: string[]; followUp: string[] } | undefined {
    if (!this.handle) return;
    let cleared: { steering: string[]; followUp: string[] };
    try {
      this.clearingQueue = true;
      const result = this.handle.session.clearQueue();
      cleared = {
        steering: Array.isArray(result?.steering) ? [...result.steering] : [],
        followUp: Array.isArray(result?.followUp) ? [...result.followUp] : []
      };
    } catch (error) {
      this.fatal("CLEAR_QUEUE_FAILED", errorMessage(error));
      return;
    } finally {
      this.clearingQueue = false;
    }
    this.persistClearedInputs("steer", cleared.steering);
    this.persistClearedInputs("followUp", cleared.followUp);
    return cleared;
  }

  private restoreEditorQueue(): void {
    const cleared = this.clearSdkQueue();
    if (!cleared) return;
    const queued = [...cleared.steering, ...cleared.followUp];
    if (queued.length) this.editorHost.setText([queued.join("\n\n"), this.editorHost.getText()].filter(text => text.trim()).join("\n\n"));
  }

  private persistClearedInputs(delivery: "steer" | "followUp", returned: readonly string[]): void {
    const list = delivery === "steer" ? this.pendingInputs.steering : this.pendingInputs.followUp;
    const exact = returned.length === list.length && returned.every((value, index) => list[index]?.text === value);
    const inputs = list.splice(0, list.length);
    for (const input of inputs) this.emitInputUpdated(input, exact ? "returned" : "unknown");
  }

  private async executeUserBash(command: string, excludeFromContext: boolean, commandId: string): Promise<Record<string, unknown>> {
    const message: RecordValue = { role: "bashExecution", command, excludeFromContext, output: "" };
    this.messageStarted(message);
    const messageId = this.messageId(message);
    const context = this.messageContexts.get(messageId)!;
    this.emitContentStarted(context, messageId, { id: `${messageId}:0`, index: 0, kind: "text", text: "" });
    const onChunk = (chunk: string) => {
      message.output = String(message.output) + chunk;
      this.emitEvent({ sessionId: this.sessionId, seq: 1, runId: null, operationId: context.operationId,
        schemaVersion: 1, timestamp: nowTimestamp(), type: "content.delta",
        payload: { messageId, blockId: `${messageId}:0`, delta: chunk } });
    };
    try {
      const runner = this.handle?.session.extensionRunner;
      const hookResult: UserBashEventResult | undefined = runner ? await runner.emitUserBash({
        type: "user_bash", command, excludeFromContext,
        cwd: this.handle?.services.cwd ?? process.cwd()
      }) : undefined;
      let result: Record<string, unknown>;
      if (hookResult?.result !== undefined) {
        this.handle!.session.recordBashResult(command, hookResult.result, { excludeFromContext });
        result = recordValue(hookResult.result) ?? {};
      } else {
        result = recordValue(await this.handle!.session.executeBash(command, onChunk, {
          excludeFromContext, id: commandId,
          ...(hookResult?.operations ? { operations: hookResult.operations } : {})
        })) ?? {};
      }
      Object.assign(message, result);
      this.messageCompleted(message);
      return result;
    } catch (error) {
      Object.assign(message, { exitCode: -1, cancelled: this.bashExecution?.abortRequested === true });
      this.messageCompleted(message);
      throw error;
    }
  }

  private emitSessionConfig(changes: Record<string, unknown>): void {
    const context = this.operationContext();
    this.emitEvent({
      sessionId: this.sessionId,
      seq: 1,
      runId: context?.runId ?? null,
      operationId: context?.operationId ?? null,
      schemaVersion: 1,
      timestamp: nowTimestamp(),
      type: "session.updated",
      payload: { changes }
    });
  }

  private async sendModels(payload: { requestId: string; refresh?: boolean }): Promise<void> {
    if (!this.handle) return;
    const runtime = this.handle.services.modelRuntime;
    if (payload.refresh) {
      try { await runtime.refresh(); }
      catch (error) {
        this.emitEvent({ sessionId: this.sessionId, seq: 1, runId: null, operationId: null,
          schemaVersion: 1, timestamp: nowTimestamp(), type: "runtime.notice",
          payload: { kind: "generic", message: bounded(`Model catalog refresh failed: ${errorMessage(error)}`, 1000) } });
      }
    }
    if (typeof runtime.getModels !== "function" || typeof this.handle.session.getAvailableThinkingLevels !== "function") return;
    const models = runtime.getModels();
    const surface = this.surfaceHosts.get(this.currentSessionId);
    if (surface) this.updateSurfaceData(surface);
    const session = this.handle.session;
    const availableThinkingLevels = session.getAvailableThinkingLevels();
    const items: ModelInfo[] = models.map((model) => ({
      model: { provider: model.provider, id: model.id }, name: model.name,
      contextWindow: model.contextWindow,
      thinkingLevels: session.getAvailableThinkingLevels.call({ model })
    }));
    this.send("models", { requestId: payload.requestId, items, availableThinkingLevels });
  }

  private emitUi(method: string, args: unknown[]): void {
    const context = this.operationContext();
    const owner = context ? this.operationSessions.get(context.operationId) ?? this.currentSessionId : this.currentSessionId;
    if ((method === "setWidget" || method === "setStatus") && typeof args[0] === "string") {
      let keys = this.extensionUiKeys.get(owner);
      if (!keys) { keys = { widgets: new Set(), statuses: new Set() }; this.extensionUiKeys.set(owner, keys); }
      const set = method === "setWidget" ? keys.widgets : keys.statuses;
      if (args[1] === undefined || args[1] === null) set.delete(args[0]); else set.add(args[0]);
    }
    // Functions are terminal renderers; do not pretend they were rendered remotely.
    const seen = new WeakSet<object>();
    const serializableArgs: unknown = JSON.parse(JSON.stringify(args, (_key, value: unknown) => {
      if (typeof value === "function") return { unsupportedRenderer: true };
      if (typeof value === "bigint") return value.toString();
      if (value && typeof value === "object") {
        if (seen.has(value)) return { unsupportedValue: "circular" };
        seen.add(value);
      }
      return value ?? null;
    }));
    this.emitEvent({ sessionId: this.sessionId, seq: 1, runId: context?.runId ?? null,
      operationId: context?.operationId ?? null, schemaVersion: 1, timestamp: nowTimestamp(),
      type: "runtime.notice", payload: { kind: "extension_ui", message: method, details: { method, args: serializableArgs } } });
  }

  private actualConfig(): Record<string, unknown> {
    const model = this.handle?.session.model;
    return {
      actualConfig: {
        model: model ? { provider: model.provider, id: model.id } : null,
        thinkingLevel: this.handle?.session.thinkingLevel ?? null
      }
    };
  }

  private async requestInteraction(
    kind: PendingInteraction["kind"],
    title: string,
    fields: {
      options?: string[];
      message?: string;
      placeholder?: string;
      prefill?: string;
    },
    options?: ExtensionUIDialogOptions
  ): Promise<Record<string, unknown> | undefined> {
    const context = this.operationContext() ?? this.createStandaloneOperation();
    const interactionId = randomUUID();
    const timeout = options?.timeout;
    const expiresAt = Number.isFinite(timeout) && timeout !== undefined && timeout > 0
      ? new Date(Date.now() + timeout).toISOString()
      : undefined;
    let resolvePending!: (value: Record<string, unknown> | undefined) => void;
    const promise = new Promise<Record<string, unknown> | undefined>((resolve) => { resolvePending = resolve; });
    const pending: PendingInteraction = {
      interactionId,
      operationId: context.operationId,
      runId: context.runId,
      operationKind: context.kind,
      kind,
      ...(fields.options ? { options: [...fields.options] } : {}),
      resolve: resolvePending,
      settled: false
    };
    this.pendingInteractions.set(interactionId, pending);
    if (timeout !== undefined && Number.isFinite(timeout) && timeout > 0) {
      pending.timer = setTimeout(() => this.finishInteraction(interactionId, undefined, "expired", "timeout"), timeout);
    }
    if (options?.signal) {
      const onAbort = () => this.finishInteraction(interactionId, undefined, "cancelled", "cancelled");
      options.signal.addEventListener("abort", onAbort, { once: true });
      pending.removeAbortListener = () => options.signal?.removeEventListener("abort", onAbort);
      if (options.signal.aborted) onAbort();
    }
    try {
      this.emitOperationStatus("waiting_input", context);
      this.emitEvent({
        sessionId: this.sessionId,
        seq: 1,
        runId: context.runId,
        operationId: context.operationId,
        schemaVersion: 1,
        timestamp: nowTimestamp(),
        type: "interaction.requested",
        payload: {
          interactionId,
          operationId: context.operationId,
          origin: context.kind,
          kind,
          title: bounded(title, 120),
          ...(fields.options ? { options: fields.options.map((value) => ({ value, label: value })) } : {}),
          ...(fields.message !== undefined ? { message: bounded(fields.message) } : {}),
          ...(fields.placeholder !== undefined ? { placeholder: bounded(fields.placeholder) } : {}),
          ...(fields.prefill !== undefined ? { prefill: bounded(fields.prefill) } : {}),
          ...(expiresAt ? { expiresAt } : {})
        }
      });
    } catch (error) {
      this.finishInteraction(interactionId, undefined, "cancelled", "bridge_error");
      throw error;
    }
    return promise;
  }

  private finishInteraction(
    interactionId: string,
    response: Record<string, unknown> | undefined,
    status: "resolved" | "cancelled" | "expired",
    reason?: string
  ): boolean {
    const pending = this.pendingInteractions.get(interactionId);
    if (!pending || pending.settled) return false;
    pending.settled = true;
    this.pendingInteractions.delete(interactionId);
    if (pending.timer !== undefined) clearTimeout(pending.timer);
    pending.removeAbortListener?.();
    try {
      this.emitEvent({
        sessionId: this.sessionId,
        seq: 1,
        runId: pending.runId,
        operationId: pending.operationId,
        schemaVersion: 1,
        timestamp: nowTimestamp(),
        type: "interaction.resolved",
        payload: {
          interactionId,
          status,
          ...(response ? { response } : {}),
          ...(reason ? { reason } : {})
        }
      });
      this.emitOperationStatus("running", {
        operationId: pending.operationId,
        runId: pending.runId,
        kind: pending.operationKind
      });
    } catch (error) {
      this.fatal("INTERACTION_BRIDGE_FAILED", errorMessage(error));
    }
    pending.resolve(response);
    if (this.uiContextStorage.getStore()?.operationId !== pending.operationId && this.standaloneOperations.has(pending.operationId)) queueMicrotask(() => {
      if ([...this.pendingInteractions.values()].some((item) => item.operationId === pending.operationId)) return;
      this.standaloneOperations.delete(pending.operationId);
      this.emitOperationStatus("completed", { operationId: pending.operationId, runId: pending.runId, kind: pending.operationKind });
    });
    // thinking_level_select is intentionally fire-and-forget in the native
    // SDK. Keep its configure Operation open while its RPC form is pending,
    // and close it on a microtask so a hook can immediately ask for its next
    // form after the first answer is delivered.
    if (this.controlOperations.has(pending.operationId)) {
      queueMicrotask(() => this.completeControlOperation(pending.operationId));
    }
    return true;
  }

  private cancelPendingInteractions(reason: string): void {
    for (const interactionId of [...this.pendingInteractions.keys()]) {
      this.finishInteraction(interactionId, undefined, "cancelled", reason);
    }
  }

  private completeControlOperation(operationId: string): void {
    const operation = this.controlOperations.get(operationId);
    if (!operation) return;
    if ([...this.pendingInteractions.values()].some((interaction) => interaction.operationId === operationId)) return;
    this.emitOperationStatus("completed", {
      operationId: operation.operationId,
      runId: null,
      kind: operation.kind
    });
    this.controlOperations.delete(operationId);
  }

  private respond(payload: WorkerRespondPayload): void {
    // Trust negotiation runs before an SDK handle exists. A live pending
    // interaction and its operation identity authorize the response.
    if (this.stopped) {
      this.rejectCommand(payload.commandId, "WORKER_NOT_READY", "worker is not ready to answer forms");
      return;
    }
    const pending = this.pendingInteractions.get(payload.interactionId);
    if (!pending) {
      this.rejectCommand(payload.commandId, "INTERACTION_CLOSED", "interaction is no longer pending");
      return;
    }
    if (pending.operationId !== payload.operationId) {
      this.rejectCommand(payload.commandId, "INTERACTION_MISMATCH", "interaction operation does not match");
      return;
    }
    const response = payload.response;
    if (response.cancelled === true) {
      this.finishInteraction(payload.interactionId, undefined, "cancelled", "user_cancelled");
    } else if (
      (pending.kind === "select" && typeof response.value === "string" && response.value.length > 0 &&
        (pending.options === undefined || pending.options.includes(response.value))) ||
      (pending.kind === "confirm" && typeof response.confirmed === "boolean") ||
      ((pending.kind === "input" || pending.kind === "editor") && typeof response.value === "string")
    ) {
      this.finishInteraction(payload.interactionId, response, "resolved");
    } else {
      this.rejectCommand(payload.commandId, "INTERACTION_INVALID_RESPONSE", "response does not match the interaction kind");
      return;
    }
    this.acceptControl(payload.commandId);
  }

  private terminalInput(owner = this.currentSessionId): TerminalInputHub {
    let hub = this.terminalInputs.get(owner);
    if (!hub) { hub = new TerminalInputHub(); this.terminalInputs.set(owner, hub); }
    return hub;
  }

  private async configureFromEditor(owner: string, action: "thinking" | "thinking-select" | "forward" | "backward" | "select", signal?: AbortSignal, search?: string): Promise<void> {
    if (owner !== this.currentSessionId || !this.handle || signal?.aborted) return;
    const context = this.createStandaloneOperation(owner, "configure");
    this.standaloneOperations.delete(context.operationId);
    this.causalCommands.delete(context.operationId);
    try {
      await this.uiContextStorage.run(context, async () => {
        const session = this.handle!.session;
        let message: string;
        if (action === "thinking-select") {
          const settings = this.handle!.services.settingsManager;
          let selection: ThinkingSelection | undefined;
          if (search) {
            const levels = session.getAvailableThinkingLevels();
            const level = levels.find(level => level.toLowerCase() === search.toLowerCase());
            if (!level) { this.createUiContext().notify(`未知思考等级「${search}」。可用等级：${levels.join(", ")}`, "error"); return; }
            selection = { level, persist: false };
          } else {
            selection = await runCustomUi<ThinkingSelection | undefined>((_tui, _theme, keys, done) =>
              createThinkingSelector(keys, session, settings.getDefaultThinkingLevel(), done), {
              agentDir: this.agentDir, signal: signal!, terminalInput: this.terminalInput(owner),
              publish: lines => this.emitUi("custom.render", [context.operationId, lines]),
              inputError: message => this.createUiContext().notify(message, "error"),
              ask: (kind, keys, inputSignal) => this.requestInteraction(kind, kind === "select" ? "思考等级" : "思考等级输入", {
                ...(keys ? { options: keys } : {}), message: "原生思考等级菜单：搜索后 Enter 选择，Ctrl+S 保存默认值，Esc 取消；遵循模型能力和自定义键位。"
              }, { signal: inputSignal })
            });
          }
          if (!selection || signal?.aborted || owner !== this.currentSessionId) return;
          session.setThinkingLevel(selection.level, { persist: selection.persist });
          if (selection.persist) await settings.flush();
          message = selection.persist ? `默认思考等级：${selection.level}；当前等级：${session.thinkingLevel}` : `思考等级：${session.thinkingLevel}`;
        } else if (action === "select") {
          const settings = this.handle!.services.settingsManager;
          const provider = settings.getDefaultProvider(), id = settings.getDefaultModel();
          const exact = search ? await findEditorModel(session, search, signal!, (text, type) => this.createUiContext().notify(text, type)) : undefined;
          if (signal?.aborted || owner !== this.currentSessionId) return;
          const selection: ModelSelection | undefined = exact ? { model: exact, persist: false }
            : await runCustomUi<ModelSelection | undefined>((tui, _theme, keys, done) =>
            createModelSelector(tui, keys, session, provider && id ? { provider, id } : undefined, done, search), {
            agentDir: this.agentDir, signal: signal!, terminalInput: this.terminalInput(owner),
            publish: lines => this.emitUi("custom.render", [context.operationId, lines]),
            inputError: message => this.createUiContext().notify(message, "error"),
            ask: (kind, keys, inputSignal) => this.requestInteraction(kind, kind === "select" ? "模型选择" : "模型选择输入", {
              ...(keys ? { options: keys } : {}), message: "原生模型菜单：输入文本搜索，Enter 选择，Ctrl+S 设为默认，Esc 取消；遵循自定义键位。"
            }, { signal: inputSignal })
          });
          if (!selection || signal?.aborted || owner !== this.currentSessionId) return;
          await session.setModel(selection.model, { persist: selection.persist });
          if (selection.persist) await settings.flush();
          message = selection.persist ? `默认模型：${selection.model.provider}/${selection.model.id}` : `模型：${selection.model.id}`;
        } else if (action === "thinking") {
          const level = session.cycleThinkingLevel();
          message = level === undefined ? "当前模型不支持思考等级" : `思考等级：${level}`;
        } else {
          const result = await session.cycleModel(action);
          message = result === undefined ? (session.scopedModels.length ? "作用域内只有一个可用模型" : "只有一个可用模型")
            : `已切换至 ${result.model.name || result.model.id}`;
        }
        // A model hook can replace the native session while the action awaits it.
        if (owner !== this.currentSessionId) return;
        if (action !== "thinking" && action !== "thinking-select" && session.model) this.emitSessionConfig({
          model: { provider: session.model.provider, id: session.model.id }, thinkingLevel: session.thinkingLevel
        });
        await this.sendModels({ requestId: "runtime-state" });
        this.createUiContext().notify(message, "info");
      });
      // Model hooks are awaited; thinking hooks are fire-and-forget. Only hand
      // completion to the form lifecycle after the awaited mutation has ended.
      this.controlOperations.set(context.operationId, { operationId: context.operationId, commandId: "", kind: "configure" });
      this.completeControlOperation(context.operationId);
    } catch (error) {
      this.emitOperationStatus("failed", context);
      throw error;
    }
  }

  private resetReloadUi(owner: string, operationId: string): void {
    for (const [controller, sessionId] of this.controllerOwners) if (sessionId === owner) controller.abort();
    for (const [id, pending] of this.pendingInteractions) {
      if (pending.operationId !== operationId && this.operationSessions.get(pending.operationId) === owner)
        this.finishInteraction(id, undefined, "cancelled", "extension_reload");
    }
    this.terminalInputs.get(owner)?.clear();
    this.editorHost.reset();
    this.surfaceHosts.get(owner)?.dispose(); this.surfaceHosts.delete(owner);
    this.emitUi("setHeader", [null]); this.emitUi("setFooter", [null]);
    const keys = this.extensionUiKeys.get(owner);
    for (const key of [...keys?.widgets ?? []]) { this.widgetHost.remove(JSON.stringify([owner, key])); this.emitUi("setWidget", [key, null]); }
    for (const key of [...keys?.statuses ?? []]) this.emitUi("setStatus", [key, null]);
    this.extensionUiKeys.delete(owner);
    this.emitUi("setWorkingMessage", [null]); this.emitUi("setWorkingVisible", [true]);
    this.emitUi("setWorkingIndicator", [null]); this.emitUi("setHiddenThinkingLabel", [null]);
  }

  private async commandFromEditor(owner: string, text: string, signal: AbortSignal): Promise<void> {
    if (owner !== this.currentSessionId || !this.handle || signal.aborted) return;
    const context = this.createStandaloneOperation(owner, text === "/trust" ? "configure" : undefined);
    this.standaloneOperations.delete(context.operationId);
    this.causalCommands.delete(context.operationId);
    const session = this.handle.session;
    try {
      await this.uiContextStorage.run(context, async () => {
        const name = text.split(/\s/, 1)[0]!;
        const argument = text.slice(name.length).trim();
        const notify = (message: string) => this.createUiContext().notify(message, "info");
        if (name === "/trust") {
          const agentDir = this.handle!.services.agentDir;
          const selection = await runCustomUi<TrustSelection | undefined>((_tui, _theme, keys, done) =>
            createTrustSelector(keys, agentDir, session.sessionManager.getCwd(), this.handle!.services.settingsManager.isProjectTrusted(), done), {
            agentDir, signal, terminalInput: this.terminalInput(owner),
            publish: lines => this.emitUi("custom.render", [context.operationId, lines]),
            inputError: message => this.createUiContext().notify(message, "error"),
            ask: (kind, keys, inputSignal) => this.requestInteraction(kind, kind === "select" ? "项目信任" : "项目信任输入", {
              ...(keys ? { options: keys } : {}), message: "选择当前目录或父目录的信任决定，Enter 保存，Esc 取消。保存后须重新启动该会话的 worker 才生效；当前任务继续。"
            }, { signal: inputSignal })
          });
          if (!selection || signal.aborted || owner !== this.currentSessionId) return;
          saveProjectTrust(agentDir, selection);
          notify(`已保存项目信任：${selection.trusted ? "信任" : "不信任"}；重新启动该会话的 worker 后生效，当前任务与资源保持原状`);
          return;
        }
        if (name === "/reload") {
          if (session.isStreaming || session.isCompacting) throw new Error("请等待当前回复或压缩结束后重载（原生前置条件）");
          if (this.reloading.has(owner)) throw new Error("资源正在重载");
          this.reloading.add(owner);
          try {
            this.resetReloadUi(owner, context.operationId);
            await session.reload({ beforeSessionStart: async () => {
              if (owner !== this.currentSessionId) throw new Error("重载期间会话已切换");
              // Shutdown hooks may have installed additional old-runtime UI.
              // Clear that before startup hooks install the new runtime's UI.
              this.resetReloadUi(owner, context.operationId);
              this.setEditor((tui, theme, keys) => new CustomEditor(tui, theme, keys));
            } });
            if (owner !== this.currentSessionId) return;
            this.editorHost.refreshAutocomplete();
            await this.sendModels({ requestId: "runtime-state" });
            for (const error of session.resourceLoader.getExtensions().errors) this.createUiContext().notify(`扩展加载失败：${error.path}: ${error.error}`, "error");
            const modelError = session.modelRuntime.getError();
            if (modelError) this.createUiContext().notify(`模型配置加载失败：${modelError}`, "error");
            notify("已重载扩展、键位、skills、提示模板和上下文；远程显示设置仍遵循当前适配能力");
          } finally {
            this.reloading.delete(owner);
            if (owner === this.currentSessionId && !this.editorHost.getFactory())
              this.setEditor((tui, theme, keys) => new CustomEditor(tui, theme, keys));
          }
          return;
        }
        if (name === "/import") {
          const path = editorPathArgument(text, name);
          if (!path) throw new Error("用法：/import <服务端路径.jsonl>");
          const answer = await this.requestInteraction("confirm", "导入会话", { message: `从 ${path} 导入并切换当前会话？原生会话 ID 保留，手机不会回填原历史时间线。` }, { signal });
          if (!answer?.confirmed || signal.aborted || owner !== this.currentSessionId) { notify("导入已取消"); return; }
          if (!this.handle?.importFromJsonl) throw new Error("当前运行时不支持受管导入");
          const result = await this.handle.importFromJsonl(path);
          if (result.cancelled) notify("导入已取消");
          return;
        }
        if (name === "/clone") {
          const leaf = session.sessionManager.getLeafId();
          if (!leaf) { notify("当前会话没有可克隆的历史"); return; }
          const result = await session.extensionRunner.createCommandContext().fork(leaf, {
            position: "at", withSession: async ctx => { ctx.ui.setEditorText(""); ctx.ui.notify("已克隆到新会话", "info"); }
          });
          if (result.cancelled) notify("克隆已取消");
          return;
        }
        if (name === "/name") {
          if (argument) session.setSessionName(argument);
          notify(session.sessionManager.getSessionName() ? `会话标题：${session.sessionManager.getSessionName()}` : "用法：/name <标题>");
          return;
        }
        if (name === "/export") {
          const path = editorPathArgument(text, name);
          const output = path?.endsWith(".jsonl") ? session.exportToJsonl(path) : await session.exportToHtml(path, { themeName: "dark" });
          notify(`会话已导出到服务端：${output}`); return;
        }
        if (name === "/compact") {
          await session.compact(argument || undefined);
          notify("手动压缩已完成"); return;
        }
        if (name === "/copy") {
          const message = session.getLastAssistantText();
          if (!message) throw new Error("还没有可复制的助手回复");
          // The device owns its clipboard; returning edited text must never submit a prompt.
          await this.requestInteraction("editor", "复制最后回复", { prefill: message,
            message: message.length > 32768
              ? "回复超过文本框上限，仅展示前 32768 个字符；完整内容可通过 /export 导出。编辑或关闭不会发送消息。"
              : "请在手机文本框中选择并复制；关闭或编辑不会发送消息，也不会写入服务器剪贴板。" }, { signal });
          return;
        }
        await runCustomUi<void>((_tui, _theme, keys, done) => createInformationViewer(
          name === "/session" ? sessionInformation(session) : name === "/hotkeys"
            ? hotkeyInformation(this.editorHost.getKeybindings() ?? keys) : changelogInformation(), () => done(undefined)), {
          agentDir: this.agentDir, signal, terminalInput: this.terminalInput(owner),
          publish: lines => this.emitUi("custom.render", [context.operationId, lines]),
          inputError: message => this.createUiContext().notify(message, "error"),
          ask: (kind, keys, inputSignal) => this.requestInteraction(kind, kind === "select" ? "会话信息" : "信息输入", {
            ...(keys ? { options: keys } : {}), message: `${name}：上下滚动、翻页、Home/End，Enter 或 Esc 关闭。`
          }, { signal: inputSignal })
        });
      });
      this.emitOperationStatus("completed", context);
    } catch (error) { this.emitOperationStatus("failed", context); throw error; }
  }

  private async scopedModelsFromEditor(owner: string, signal: AbortSignal): Promise<void> {
    if (owner !== this.currentSessionId || !this.handle || signal.aborted) return;
    const context = this.createStandaloneOperation(owner, "configure");
    this.standaloneOperations.delete(context.operationId);
    this.causalCommands.delete(context.operationId);
    const session = this.handle.session, settings = this.handle.services.settingsManager;
    let writes = Promise.resolve();
    let writeFailed = false;
    try {
      await this.uiContextStorage.run(context, async () => {
        await runCustomUi<void>((tui, _theme, keys, done) => createScopedModelsSelector(tui, keys, session, settings,
          () => !signal.aborted && owner === this.currentSessionId, patterns => {
            settings.setEnabledModels(patterns);
            writes = writes.then(async () => {
              await settings.flush();
              const errors = settings.drainErrors();
              if (errors.length) throw new Error(errors.map(item => errorMessage(item.error)).join("; "));
              this.createUiContext().notify("模型范围已保存", "info");
            }).catch(error => { writeFailed = true; this.createUiContext().notify(`模型范围保存失败：${errorMessage(error)}`, "error"); });
          }, () => done(undefined), () => {
            const surface = this.surfaceHosts.get(owner);
            if (surface) this.updateSurfaceData(surface);
          }), {
          agentDir: this.agentDir, signal, terminalInput: this.terminalInput(owner),
          publish: lines => this.emitUi("custom.render", [context.operationId, lines]),
          inputError: message => this.createUiContext().notify(message, "error"),
          ask: (kind, keys, inputSignal) => this.requestInteraction(kind, kind === "select" ? "模型范围" : "模型范围输入", {
            ...(keys ? { options: keys } : {}), message: "原生模型范围菜单：选择与排序即时影响本会话，使用菜单保存键写入设置；关闭不撤销选择。"
          }, { signal: inputSignal })
        });
        await writes;
      });
      this.emitOperationStatus(writeFailed ? "failed" : "completed", context);
    } catch (error) { await writes; this.emitOperationStatus("failed", context); throw error; }
  }

  private async settingsFromEditor(owner: string, signal: AbortSignal): Promise<void> {
    if (owner !== this.currentSessionId || !this.handle || signal.aborted) return;
    const context = this.createStandaloneOperation(owner, "configure");
    this.standaloneOperations.delete(context.operationId);
    this.causalCommands.delete(context.operationId);
    const session = this.handle.session, settings = this.handle.services.settingsManager;
    let writes = Promise.resolve();
    let writeFailed = false;
    try {
      await this.uiContextStorage.run(context, async () => {
        await runCustomUi<void>((_tui, _theme, keys, done) => createSettingsSelector(keys, session, settings, {
          change: apply => {
            if (signal.aborted || owner !== this.currentSessionId) return;
            apply();
            writes = writes.then(async () => {
              await settings.flush();
              const errors = settings.drainErrors();
              if (errors.length) throw new Error(errors.map(item => errorMessage(item.error)).join("; "));
              this.createUiContext().notify("设置已保存", "info");
            }).catch(error => { writeFailed = true; this.createUiContext().notify(`设置保存失败：${errorMessage(error)}`, "error"); });
          },
          unavailable: message => this.createUiContext().notify(message, "warning"),
          refreshAutocomplete: () => this.editorHost.refreshAutocomplete(),
          setPaddingX: value => this.editorHost.setPaddingX(value),
          setAutocompleteMaxVisible: value => this.editorHost.setAutocompleteMaxVisible(value)
        }, () => done(undefined)), {
          agentDir: this.agentDir, signal, terminalInput: this.terminalInput(owner),
          publish: lines => this.emitUi("custom.render", [context.operationId, lines]),
          inputError: message => this.createUiContext().notify(message, "error"),
          ask: (kind, keys, inputSignal) => this.requestInteraction(kind, kind === "select" ? "设置" : "设置输入", {
            ...(keys ? { options: keys } : {}), message: "原生设置菜单：搜索并按 Enter 修改，即时保存；关闭不撤销已改设置。标为待适配的显示/启动项不会修改配置。"
          }, { signal: inputSignal })
        });
        await writes;
      });
      if (writeFailed) this.emitOperationStatus("failed", context);
      else {
        this.controlOperations.set(context.operationId, { operationId: context.operationId, commandId: "", kind: "configure" });
        this.completeControlOperation(context.operationId);
      }
    } catch (error) { await writes; this.emitOperationStatus("failed", context); throw error; }
  }

  private branchSummary?: { owner: string; session: AgentSession };

  private async treeFromEditor(owner: string, signal: AbortSignal): Promise<void> {
    if (owner !== this.currentSessionId || !this.handle || signal.aborted) return;
    const context = this.createStandaloneOperation(owner);
    this.standaloneOperations.delete(context.operationId);
    this.causalCommands.delete(context.operationId);
    const session = this.handle.session;
    const settings = this.handle.services.settingsManager;
    const valid = () => !signal.aborted && owner === this.currentSessionId;
    try {
      await this.uiContextStorage.run(context, async () => {
        let selected: string | undefined;
        while (valid()) {
          if (!session.sessionManager.getTree().length) { this.createUiContext().notify("会话中没有历史节点", "info"); return; }
          const menu = new AbortController();
          const close = () => menu.abort();
          signal.addEventListener("abort", close, { once: true });
          let copying = false;
          try {
            selected = await runCustomUi<string | undefined>((tui, _theme, keys, done) =>
              createTreeSelector(tui, keys, session, done, text => {
                if (!text) { this.createUiContext().notify("该节点没有可复制的文本", "info"); return; }
                if (copying) return;
                copying = true;
                // Use the handset's editable text surface; never claim host clipboard access.
                void this.requestInteraction("editor", "复制树节点文本", {
                  prefill: text, message: text.length > 32768
                    ? "文本过长，此框仅展示前 32768 个字符；长按复制，完整内容保留在原生历史中。关闭不会修改消息或对话草稿。"
                    : "长按文本复制；关闭此框不会修改消息或对话草稿。"
                }, { signal: menu.signal }).catch(error => {
                  if (valid()) this.createUiContext().notify(errorMessage(error), "error");
                }).finally(() => { copying = false; });
              }, selected, settings.getTreeFilterMode()), {
              agentDir: this.agentDir, signal: menu.signal, terminalInput: this.terminalInput(owner),
              publish: lines => this.emitUi("custom.render", [context.operationId, lines]),
              inputError: message => this.createUiContext().notify(message, "error"),
              ask: (kind, keys, inputSignal) => this.requestInteraction(kind, kind === "select" ? "会话树" : "会话树输入", {
                ...(keys ? { options: keys } : {}), message: "切换模型使用的历史分支；手机事件记录保留。支持原生搜索、过滤、折叠和标签；复制键打开可复制文本。"
              }, { signal: inputSignal })
            });
          } finally { signal.removeEventListener("abort", close); menu.abort(); }
          if (!selected || !valid()) return;
          if (selected === session.sessionManager.getLeafId()) { this.createUiContext().notify("已在所选节点", "info"); return; }
          let summarize = false;
          let customInstructions: string | undefined;
          let back = false;
          if (!settings.getBranchSummarySkipPrompt()) {
            while (valid()) {
              const choice = await this.requestInteraction("select", "分支摘要选项", {
                options: ["不生成摘要", "生成摘要", "使用自定义提示生成摘要"]
              }, { signal });
              if (typeof choice?.value !== "string") { back = true; break; }
              summarize = choice.value !== "不生成摘要";
              if (choice.value === "使用自定义提示生成摘要") {
                const instructions = await this.requestInteraction("editor", "自定义摘要指令", {}, { signal });
                if (typeof instructions?.value !== "string") continue;
                customInstructions = instructions.value;
              }
              break;
            }
          }
          if (!valid()) return;
          if (back) continue;
          // Match native commit ordering: recover every queued Input before abort.
          if (session.isStreaming) {
            const target = this.execution?.runId ? this.execution : this.autonomous;
            if (target?.runId) await this.abort({ runId: target.runId, restoreEditor: true });
            else { this.restoreEditorQueue(); await session.abort(); }
          }
          if (!valid()) return;
          const summaryControl = new AbortController();
          const summary = { owner, session };
          let cancelControl: Promise<void> | undefined;
          try {
            if (summarize) this.branchSummary = summary;
            // Start the SDK operation before allowing cancellation, so its abort controller exists.
            const navigation = session.navigateTree(selected, { summarize, customInstructions });
            if (summarize) {
              cancelControl = this.requestInteraction("select", "正在生成分支摘要", {
                options: ["取消摘要"], message: "取消后返回会话树，也可按编辑器 Esc；不会提交对话草稿。"
              }, { signal: summaryControl.signal }).then(() => {
                if (!summaryControl.signal.aborted && this.branchSummary === summary) session.abortBranchSummary();
              });
            }
            const result = await navigation;
            if (owner !== this.currentSessionId) return;
            if (result.aborted) { this.createUiContext().notify("分支摘要已取消", "info"); continue; }
            if (result.cancelled) { this.createUiContext().notify("树导航已取消", "info"); return; }
            if (result.editorText && !this.editorHost.getText().trim()) this.createUiContext().setEditorText(result.editorText);
            this.createUiContext().notify("已切换到所选历史分支；手机事件记录保留", "info");
            return;
          } finally {
            summaryControl.abort();
            await cancelControl;
            if (this.branchSummary === summary) this.branchSummary = undefined;
          }
        }
      });
      this.emitOperationStatus("completed", context);
    } catch (error) { this.emitOperationStatus("failed", context); throw error; }
  }

  private async sessionFromEditor(owner: string, action: "new" | "resume" | "fork", signal: AbortSignal): Promise<void> {
    if (owner !== this.currentSessionId || !this.handle || signal.aborted) return;
    const context = this.createStandaloneOperation(owner);
    this.standaloneOperations.delete(context.operationId);
    this.causalCommands.delete(context.operationId);
    try {
      await this.uiContextStorage.run(context, async () => {
        if (action === "fork") {
          const messages = this.handle!.session.getUserMessagesForForking();
          if (!messages.length) { this.createUiContext().notify("没有可分叉的用户消息", "info"); return; }
          const selected = await runCustomUi<typeof messages[number] | undefined>((_tui, _theme, keys, done) =>
            createForkSelector(keys, messages, done), {
            agentDir: this.agentDir, signal, terminalInput: this.terminalInput(owner),
            publish: lines => this.emitUi("custom.render", [context.operationId, lines]),
            inputError: message => this.createUiContext().notify(message, "error"),
            ask: (kind, keys, inputSignal) => this.requestInteraction(kind, kind === "select" ? "分叉会话" : "分叉菜单输入", {
              ...(keys ? { options: keys } : {}), message: "选择用户消息，将此前历史复制到新会话；所选消息恢复为草稿，不自动发送。"
            }, { signal: inputSignal })
          });
          if (!selected || signal.aborted || owner !== this.currentSessionId) return;
          await this.handle!.session.extensionRunner.createCommandContext().fork(selected.entryId, {
            // The bound continuation runs only after the destination mapping ACK.
            withSession: async ctx => { ctx.ui.setEditorText(selected.text); }
          });
          return;
        }
        let path: string | undefined;
        if (action === "resume") {
          path = await runCustomUi<string | undefined>((tui, _theme, keys, done) =>
            createSessionSelector(tui, keys, this.handle!.session, done,
              () => {
                if (signal.aborted || owner !== this.currentSessionId) return;
                this.createUiContext().notify("已退出远程编辑器；后端会话继续运行", "info");
                this.setEditor(undefined);
              }), {
            agentDir: this.agentDir, signal, terminalInput: this.terminalInput(owner),
            publish: lines => this.emitUi("custom.render", [context.operationId, lines]),
            inputError: message => this.createUiContext().notify(message, "error"),
            ask: (kind, keys, inputSignal) => this.requestInteraction(kind, kind === "select" ? "恢复会话" : "会话菜单输入", {
              ...(keys ? { options: keys } : {}), message: "原生历史菜单：搜索并选择恢复；重命名/删除作用于原生历史，手机事件记录保留。删除遵循菜单确认。"
            }, { signal: inputSignal })
          });
          if (!path) return;
        }
        if (signal.aborted || owner !== this.currentSessionId) return;
        // Use the bound SDK command actions: these validate persistent history,
        // serialize replacements and await the server's identity mapping ACK.
        const actions = this.handle!.session.extensionRunner.createCommandContext();
        if (action === "new") await actions.newSession();
        else await actions.switchSession(path!);
      });
      this.emitOperationStatus("completed", context);
    } catch (error) { this.emitOperationStatus("failed", context); throw error; }
  }

  private setEditor(factory: Parameters<ExtensionUIContext["setEditorComponent"]>[0]): void {
    if (!factory) {
      this.editorHost.stop();
      this.editorText = this.editorHost.getText();
      this.emitUi("setEditorText", [this.editorText]);
      return;
    }
    const owner = this.currentSessionId;
    const context = this.createStandaloneOperation(owner);
    this.standaloneOperations.delete(context.operationId);
    // Installing an editor is not the cause of a later user submission.
    this.causalCommands.delete(context.operationId);
    const controller = new AbortController();
    this.customControllers.add(controller);
    this.controllerOwners.set(controller, owner);
    let lastClear: number | undefined;
    let lastEscape = 0;
    let modelMenu: Promise<void> | undefined;
    let thinkingMenu: Promise<void> | undefined;
    let settingsMenu: Promise<void> | undefined;
    let scopedModelsMenu: Promise<void> | undefined;
    let sessionMenu: Promise<void> | undefined;
    const commandMenus = new Map<string, Promise<void>>();
    const openCommand = (text: string) => {
      const name = text.split(/\s/, 1)[0]!;
      if (!["/session", "/hotkeys", "/changelog", "/copy", "/trust"].includes(name)) return this.commandFromEditor(owner, text, controller.signal);
      const existing = commandMenus.get(name);
      if (existing) return existing;
      const pending = this.commandFromEditor(owner, text, controller.signal).finally(() => { commandMenus.delete(name); });
      commandMenus.set(name, pending); return pending;
    };
    const closeEditor = () => {
      if (owner !== this.currentSessionId || controller.signal.aborted) return;
      this.createUiContext().notify("已退出远程编辑器；后端会话继续运行，可使用手机输入框或由扩展重新打开编辑器", "info");
      this.setEditor(undefined);
    };
    const openModelMenu = (search?: string) => {
      if (!modelMenu) modelMenu = this.configureFromEditor(owner, "select", controller.signal, search).finally(() => { modelMenu = undefined; });
      return modelMenu;
    };
    const openThinkingMenu = (search?: string) => {
      if (!thinkingMenu) thinkingMenu = this.configureFromEditor(owner, "thinking-select", controller.signal, search).finally(() => { thinkingMenu = undefined; });
      return thinkingMenu;
    };
    const openSessionMenu = (action: "resume" | "fork" | "tree") => {
      if (!sessionMenu) sessionMenu = (action === "tree" ? this.treeFromEditor(owner, controller.signal)
        : this.sessionFromEditor(owner, action, controller.signal)).finally(() => { sessionMenu = undefined; });
      return sessionMenu;
    };
    const failure = (error: unknown) => this.send("extension_error", {
      sessionId: owner, operationId: context.operationId, extensionPath: "editor", event: "input", error: bounded(errorMessage(error), 2000)
    });
    void this.uiContextStorage.run(context, async () => {
      try {
        await this.editorHost.run(factory, {
          agentDir: this.agentDir, signal: controller.signal,
          terminalInput: this.terminalInput(owner), inputError: failure,
          actions: new Map<string, () => void | Promise<void>>([
            ["app.session.new", () => this.sessionFromEditor(owner, "new", controller.signal)],
            ["app.session.resume", () => openSessionMenu("resume")],
            ["app.session.fork", () => openSessionMenu("fork")],
            ["app.session.tree", () => openSessionMenu("tree")],
            ["app.model.select", () => openModelMenu()],
            ["app.thinking.cycle", () => this.configureFromEditor(owner, "thinking")],
            ["app.model.cycleForward", () => this.configureFromEditor(owner, "forward")],
            ["app.model.cycleBackward", () => this.configureFromEditor(owner, "backward")],
            ["app.clear", () => {
              const now = Date.now();
              if (lastClear !== undefined && now - lastClear < 500) { closeEditor(); return; }
              this.editorHost.setText(""); lastClear = now;
            }],
            ["app.exit", closeEditor],
            ["app.message.copy", () => openCommand("/copy")],
            ["app.suspend", () => { throw new Error("远程编辑器挂起/恢复尚待适配；手机可退到后台，服务继续运行，不向 worker 发送 SIGTSTP"); }],
            ["app.tools.expand", () => this.createUiContext().setToolsExpanded(!this.toolsExpanded)],
            ["app.interrupt", async () => {
              if (owner !== this.currentSessionId || controller.signal.aborted) return;
              const session = this.handle!.session;
              if (this.branchSummary?.owner === owner) { this.branchSummary.session.abortBranchSummary(); return; }
              if (session.isCompacting) { session.abortCompaction(); return; }
              if (session.isRetrying && !session.isStreaming) { session.abortRetry(); return; }
              if (session.isStreaming) {
                const target = this.execution?.runId ? this.execution : this.autonomous;
                if (target?.runId) await this.abort({ runId: target.runId, restoreEditor: true });
                else { this.restoreEditorQueue(); await session.abort(); }
              } else if (session.isBashRunning) this.abortBash({});
              else if (this.editorHost.getText().trimStart().startsWith("!")) this.editorHost.setText("");
              else if (!this.editorHost.getText().trim()) {
                const action = this.handle!.services.settingsManager.getDoubleEscapeAction();
                if (action !== "none") {
                  const now = Date.now();
                  if (now - lastEscape < 500) { lastEscape = 0; await openSessionMenu(action === "tree" ? "tree" : "fork"); }
                  else lastEscape = now;
                }
              }
            }]
          ]),
          shortcuts: keys => {
            const runner = this.handle!.session.extensionRunner;
            const shortcuts = runner.getShortcuts(keys.getEffectiveConfig());
            return data => {
              for (const [key, shortcut] of shortcuts) {
                if (!matchesKey(data, key)) continue;
                try { void Promise.resolve(shortcut.handler(runner.createContext())).catch(failure); }
                catch (error) { failure(error); }
                return true;
              }
              return false;
            };
          },
          paddingX: this.handle?.services.settingsManager.getEditorPaddingX(),
          autocompleteMaxVisible: this.handle?.services.settingsManager.getAutocompleteMaxVisible(),
          publish: lines => this.uiContextStorage.run(context, () => this.emitUi("custom.render", [context.operationId, lines])),
          changed: text => {
            if (text !== this.editorText) { this.editorText = text; this.uiContextStorage.run(context, () => this.emitUi("setEditorText", [text])); }
          },
          failure,
          ask: (kind, keys, signal) => this.requestInteraction(kind, kind === "select" ? "扩展编辑器" : "扩展编辑器输入文本", {
            ...(keys ? { options: keys } : {}),
            message: "按键交给原生编辑器；组合键示例 ctrl+k、alt+enter、f5。Enter 遵循编辑器提交行为，取消恢复普通输入区并保留草稿。"
          }, { signal }),
          autocomplete: () => {
            const session = this.handle!.session;
            const commands = session.extensionRunner.getRegisteredCommands().map(command => ({
              name: command.invocationName, description: command.description, getArgumentCompletions: command.getArgumentCompletions
            }));
            const skills = this.handle!.services.settingsManager.getEnableSkillCommands()
              ? this.handle!.services.resourceLoader.getSkills().skills.map(skill => ({ name: `skill:${skill.name}`, description: skill.description })) : [];
            return new CombinedAutocompleteProvider([...commands, ...session.promptTemplates, ...skills], this.handle!.services.cwd);
          },
          submit: async text => {
            if (owner !== this.currentSessionId || controller.signal.aborted) throw new Error("编辑器所属会话已切换，未提交");
            const name = /^\/([^\s]+)/.exec(text)?.[1];
            if (text === "/quit") { closeEditor(); return; }
            if (["/session", "/hotkeys", "/changelog", "/copy", "/clone", "/reload", "/trust"].includes(text)
              || ["/name", "/export", "/import", "/compact"].some(command => text === command || text.startsWith(`${command} `))) {
              await openCommand(text); return;
            }
            if (text === "/scoped-models") {
              if (!scopedModelsMenu) scopedModelsMenu = this.scopedModelsFromEditor(owner, controller.signal).finally(() => { scopedModelsMenu = undefined; });
              await scopedModelsMenu; return;
            }
            if (text === "/settings") {
              if (!settingsMenu) settingsMenu = this.settingsFromEditor(owner, controller.signal).finally(() => { settingsMenu = undefined; });
              await settingsMenu; return;
            }
            if (text === "/thinking" || text.startsWith("/thinking ")) { await openThinkingMenu(text.slice(10).trim() || undefined); return; }
            if (text === "/model" || text.startsWith("/model ")) { await openModelMenu(text.slice(7).trim() || undefined); return; }
            if (text === "/resume" || text === "/fork") { await openSessionMenu(text === "/fork" ? "fork" : "resume"); return; }
            if (text === "/tree") { await openSessionMenu("tree"); return; }
            if (text === "/new") { await this.sessionFromEditor(owner, "new", controller.signal); return; }
            if (nativeSlashCommands.BUILTIN_SLASH_COMMANDS.some(command => command.name === name)) {
              throw new Error(`/${name}：${PENDING_EDITOR_COMMANDS[name!] ?? `参数无效；${EDITOR_COMMANDS[name as keyof typeof EDITOR_COMMANDS] ?? "请检查命令用法"}`}；文本已保留`);
            }
            const submission = this.createStandaloneOperation(owner, text.startsWith("!") ? "bash" : "extension");
            this.standaloneOperations.delete(submission.operationId);
            this.causalCommands.delete(submission.operationId);
            await this.uiContextStorage.run(submission, async () => {
              try {
                if (text.startsWith("!")) {
                  const excluded = text.startsWith("!!");
                  await this.executeUserBash(text.slice(excluded ? 2 : 1), excluded, randomUUID());
                } else await this.handle!.session.prompt(text, { source: "interactive", streamingBehavior: "steer" });
                this.emitOperationStatus("completed", submission);
              } catch (error) { this.emitOperationStatus("failed", submission); throw error; }
            });
          }
        });
        this.emitOperationStatus("completed", context);
      } catch (error) {
        failure(error);
        this.emitOperationStatus("failed", context);
      } finally { controller.abort(); this.customControllers.delete(controller); this.controllerOwners.delete(controller); }
    });
  }

  private updateSurfaceData(host: SurfaceHost): void {
    const session = this.handle?.session;
    const models = session?.scopedModels?.length ? session.scopedModels.map(item => item.model)
      : this.handle?.services.modelRuntime.getAvailableSnapshot?.() ?? [];
    host.update(new Set(models.map(model => model.provider)).size, this.toolsExpanded);
  }

  private createUiContext(): ExtensionUIContext {
    const owner = () => {
      const context = this.operationContext();
      return context ? this.operationSessions.get(context.operationId) ?? this.currentSessionId : this.currentSessionId;
    };
    const surfaces = () => {
      const sessionId = owner();
      let host = this.surfaceHosts.get(sessionId);
      if (!host) {
        host = new SurfaceHost(this.handle?.services.cwd ?? process.cwd());
        this.surfaceHosts.set(sessionId, host);
      }
      this.updateSurfaceData(host);
      return host;
    };
    const setSurface = (method: SurfaceMethod, factory: Parameters<ExtensionUIContext["setFooter"]>[0]) => {
      const parent = this.operationContext();
      const sessionId = owner();
      surfaces().set(method, factory, value => {
        const context = parent && !this.closedOperations.has(parent.operationId) ? parent : this.createStandaloneOperation(sessionId);
        this.uiContextStorage.run(context, () => this.emitUi(method, [value]));
        if (context !== parent) { this.standaloneOperations.delete(context.operationId); this.emitOperationStatus("completed", context); }
      });
    };
    const request = (
      kind: PendingInteraction["kind"],
      title: string,
      fields: { options?: string[]; message?: string; placeholder?: string; prefill?: string },
      options?: ExtensionUIDialogOptions
    ) => this.requestInteraction(kind, title, fields, options);
    return {
      select: async (title: string, options: string[], dialogOptions?: ExtensionUIDialogOptions) => {
        const result = await request("select", title, { options }, dialogOptions);
        return typeof result?.value === "string" ? result.value : undefined;
      },
      confirm: async (title: string, message: string, dialogOptions?: ExtensionUIDialogOptions) => {
        const result = await request("confirm", title, { message }, dialogOptions);
        return result?.confirmed === true;
      },
      input: async (title: string, placeholder?: string, dialogOptions?: ExtensionUIDialogOptions) => {
        const result = await request("input", title, { placeholder }, dialogOptions);
        return typeof result?.value === "string" ? result.value : undefined;
      },
      editor: async (title: string, prefill?: string) => {
        const result = await request("editor", title, { prefill });
        return typeof result?.value === "string" ? result.value : undefined;
      },
      notify: (message: string, type?: "info" | "warning" | "error") => {
        const context = this.operationContext();
        this.emitEvent({
          sessionId: this.sessionId,
          seq: 1,
          runId: context?.runId ?? null,
          operationId: context?.operationId ?? null,
          schemaVersion: 1,
          timestamp: nowTimestamp(),
          type: "runtime.notice",
          payload: {
            kind: "extension_notify",
            message: bounded(message),
            details: { type: type ?? "info" }
          }
        });
      },
      onTerminalInput: (handler: Parameters<ExtensionUIContext["onTerminalInput"]>[0]) => this.terminalInput(owner()).subscribe(handler),
      setStatus: (key: string, text: string | undefined) => { surfaces().setStatus(key, text); this.emitUi("setStatus", [key, text]); },
      setWorkingMessage: (...args: unknown[]) => this.emitUi("setWorkingMessage", args),
      setWorkingVisible: (...args: unknown[]) => this.emitUi("setWorkingVisible", args),
      setWorkingIndicator: (...args: unknown[]) => this.emitUi("setWorkingIndicator", args),
      setHiddenThinkingLabel: (...args: unknown[]) => this.emitUi("setHiddenThinkingLabel", args),
      setWidget: (key: string, content: string[] | WidgetFactory | undefined, options?: { placement?: string }) => {
        const parent = this.operationContext();
        const owner = parent ? this.operationSessions.get(parent.operationId) ?? this.currentSessionId : this.currentSessionId;
        const publish = (args: unknown[]) => {
          // Timers can refresh a widget after its originating command ended.
          const context = parent && !this.closedOperations.has(parent.operationId) ? parent : this.createStandaloneOperation(owner);
          this.uiContextStorage.run(context, () => this.emitUi("setWidget", args));
          if (context !== parent) { this.standaloneOperations.delete(context.operationId); this.emitOperationStatus("completed", context); }
        };
        const identity = JSON.stringify([owner, key]);
        const argsFor = (value: unknown) => options ? [key, value, options] : [key, value];
        if (typeof content === "function") {
          this.widgetHost.set(identity, content, lines => publish(argsFor(lines)), error => publish(argsFor({ rendererError: errorMessage(error) })));
        } else { this.widgetHost.remove(identity); publish(argsFor(content)); }
      },
      setFooter: (factory: Parameters<ExtensionUIContext["setFooter"]>[0]) => setSurface("setFooter", factory),
      setHeader: (factory: Parameters<ExtensionUIContext["setHeader"]>[0]) => setSurface("setHeader", factory),
      setTitle: (...args: unknown[]) => this.emitUi("setTitle", args),
      custom: async <T>(factory: Parameters<ExtensionUIContext["custom"]>[0], options?: Parameters<ExtensionUIContext["custom"]>[1]): Promise<T> => {
        const context = this.createStandaloneOperation();
        // Keep the factory/controls alive across one-shot form completions.
        this.standaloneOperations.delete(context.operationId);
        const controller = new AbortController();
        this.customControllers.add(controller);
        this.controllerOwners.set(controller, this.operationSessions.get(context.operationId) ?? this.currentSessionId);
        return this.uiContextStorage.run(context, async () => {
          try {
            const result = await runCustomUi<T>(factory, {
              agentDir: this.agentDir, signal: controller.signal,
              terminalInput: this.terminalInput(this.operationSessions.get(context.operationId) ?? this.currentSessionId),
              inputError: message => this.onExtensionError({ extensionPath: "custom", event: "input", error: message }),
              publish: lines => this.emitUi("custom.render", [context.operationId, lines]),
              ask: (kind, keys, signal) => this.requestInteraction(kind, kind === "select" ? "自定义组件控制" : "自定义组件输入文本", {
                ...(keys ? { options: keys } : {}),
                message: "Esc 交给扩展处理；取消控制面板会关闭组件。输入文本不自动发送 Enter；组合键示例 ctrl+k、alt+enter、f5。"
              }, { signal })
            }, options);
            this.emitOperationStatus("completed", context);
            return result;
          } catch (error) { this.emitOperationStatus("failed", context); throw error; }
          finally { this.customControllers.delete(controller); this.controllerOwners.delete(controller); }
        });
      },
      pasteToEditor: (text: string) => { this.editorHost.paste(text); this.editorText = this.editorHost.getText(); this.emitUi("setEditorText", [this.editorText]); },
      setEditorText: (text: string) => { this.editorHost.setText(text); this.editorText = this.editorHost.getText(); this.emitUi("setEditorText", [this.editorText]); },
      getEditorText: () => this.editorHost.getText(),
      addAutocompleteProvider: (factory: Parameters<ExtensionUIContext["addAutocompleteProvider"]>[0]) => this.editorHost.addAutocompleteProvider(factory),
      setEditorComponent: (factory: Parameters<ExtensionUIContext["setEditorComponent"]>[0]) => this.setEditor(factory),
      getEditorComponent: () => this.editorHost.getFactory(),
      theme: undefined,
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({ success: false, error: "themes are not available in the RPC bridge" }),
      getToolsExpanded: () => this.toolsExpanded,
      setToolsExpanded: (expanded: boolean) => { this.toolsExpanded = expanded; surfaces(); this.emitUi("setToolsExpanded", [expanded]); }
    } as unknown as ExtensionUIContext;
  }

  private onExtensionError(error: ExtensionError): void {
    const context = this.operationContext();
    this.send("extension_error", {
      sessionId: context ? this.operationSessions.get(context.operationId) ?? this.currentSessionId : this.currentSessionId,
      ...(context ? { operationId: context.operationId } : {}),
      extensionPath: bounded(error.extensionPath, 4096),
      event: bounded(error.event, 160),
      error: bounded(error.error, 2000),
      ...(error.stack ? { stack: bounded(error.stack, 4000) } : {})
    });
  }

  private async steer(payload: WorkerInputPayload): Promise<void> {
    if (!this.readyForControl()) {
      this.rejectCommand(payload.commandId, "WORKER_NOT_READY", "worker is not ready");
      return;
    }
    const input = this.controlInput(payload, "steer");
    this.emitInputUpdated(input, "queued");
    this.pendingInputs.steering.push(input);
    try {
      const context: OperationContext = { operationId: input.operationId, runId: input.runId, kind: "run" };
      await this.uiContextStorage.run(context, () => this.handle!.session.steer(payload.text));
      this.acceptControl(payload.commandId);
    } catch (error) {
      this.removeTrackedInput(input);
      this.emitInputUpdated(input, "unknown");
      this.rejectCommand(payload.commandId, "STEER_FAILED", errorMessage(error));
    }
  }

  private async followUp(payload: WorkerInputPayload): Promise<void> {
    if (!this.readyForControl()) {
      this.rejectCommand(payload.commandId, "WORKER_NOT_READY", "worker is not ready");
      return;
    }
    const input = this.controlInput(payload, "followUp");
    this.emitInputUpdated(input, "queued");
    this.pendingInputs.followUp.push(input);
    try {
      const context: OperationContext = { operationId: input.operationId, runId: input.runId, kind: "run" };
      await this.uiContextStorage.run(context, () => this.handle!.session.followUp(payload.text));
      this.acceptControl(payload.commandId);
    } catch (error) {
      this.removeTrackedInput(input);
      this.emitInputUpdated(input, "unknown");
      this.rejectCommand(payload.commandId, "FOLLOW_UP_FAILED", errorMessage(error));
    }
  }

  private async abort(payload: { commandId?: string; runId: string; preserveQueue?: boolean; restoreEditor?: boolean }): Promise<void> {
    if (!this.readyForControl()) {
      this.rejectCommand(payload.commandId, "WORKER_NOT_READY", "worker is not ready");
      return;
    }
    const target = this.execution?.runId === payload.runId ? this.execution : this.autonomous?.runId === payload.runId ? this.autonomous : undefined;
    if (!target) {
      this.rejectCommand(payload.commandId, "STALE_RUN", "target run is not active in this worker");
      return;
    }
    if ("abortRequested" in target) {
      if (payload.preserveQueue) {
        // Native compact may drain preserved inputs after aborting the current
        // generation. A later assistant outcome must be allowed to replace this
        // interrupted outcome; explicit stop still wins via abortRequested.
        target.assistantOutcome = { stopReason: "aborted" };
      } else target.abortRequested = true;
    }
    else target.outcome = { stopReason: "aborted" };
    try {
      // Match the native TUI stop order: take the SDK queue first, persist
      // every known input with its original metadata, and only then abort.
      if (!payload.preserveQueue) {
        if (payload.restoreEditor) this.restoreEditorQueue();
        else this.clearSdkQueue();
      }
      await this.uiContextStorage.run({
        operationId: target.operationId,
        runId: target.runId,
        kind: "operationKind" in target ? target.operationKind : target.kind
      }, () => this.handle!.session.abort());
      this.acceptControl(payload.commandId);
    } catch (error) {
      this.rejectCommand(payload.commandId, "ABORT_FAILED", errorMessage(error));
    }
  }

  private abortBash(payload: { commandId?: string }): void {
    if (!this.readyForControl()) {
      this.rejectCommand(payload.commandId, "WORKER_NOT_READY", "worker is not ready");
      return;
    }
    if (this.bashExecution) this.bashExecution.abortRequested = true;
    this.handle!.session.abortBash();
    this.acceptControl(payload.commandId);
  }

  private async setModel(payload: WorkerModelPayload): Promise<void> {
    if (!this.readyForControl()) {
      this.rejectCommand(payload.commandId, "WORKER_NOT_READY", "worker is not ready");
      return;
    }
    const context: OperationContext | null = payload.operationId
      ? { operationId: payload.operationId, runId: null, kind: "configure" }
      : this.operationContext();
    if (payload.operationId) {
      this.controlOperations.set(payload.operationId, {
        operationId: payload.operationId,
        commandId: payload.commandId ?? "",
        kind: "configure"
      });
    }
    try {
      const run = async () => {
        const model = this.handle!.services.modelRuntime.getModel(payload.provider, payload.modelId);
        if (!model) throw new Error(`model ${payload.provider}/${payload.modelId} is not available`);
        await this.handle!.session.setModel(model, { persist: payload.persist === true });
        if (payload.persist === true) await this.handle!.services.settingsManager.flush();
        await this.sendModels({ requestId: "runtime-state" });
        this.emitSessionConfig({ model: { provider: this.handle!.session.model?.provider ?? payload.provider, id: this.handle!.session.model?.id ?? payload.modelId } });
      };
      if (context) await this.uiContextStorage.run(context, run);
      else await run();
      if (payload.operationId) this.completeControlOperation(payload.operationId);
      await this.sendModels({ requestId: "runtime-state" });
      this.acceptControl(payload.commandId, this.actualConfig());
    } catch (error) {
      this.rejectCommand(payload.commandId, "MODEL_UNAVAILABLE", errorMessage(error));
      if (payload.operationId) this.controlOperations.delete(payload.operationId);
    }
  }

  private async setThinking(payload: WorkerThinkingPayload): Promise<void> {
    if (!this.readyForControl()) {
      this.rejectCommand(payload.commandId, "WORKER_NOT_READY", "worker is not ready");
      return;
    }
    const context: OperationContext | null = payload.operationId
      ? { operationId: payload.operationId, runId: null, kind: "configure" }
      : this.operationContext();
    if (payload.operationId) {
      this.controlOperations.set(payload.operationId, {
        operationId: payload.operationId,
        commandId: payload.commandId ?? "",
        kind: "configure"
      });
    }
    try {
      const run = async () => {
        type ThinkingLevel = Parameters<PiAgentSessionHandle["session"]["setThinkingLevel"]>[0];
        this.handle!.session.setThinkingLevel(payload.level as ThinkingLevel, {
          persist: payload.persist === true
        });
        if (payload.persist === true) await this.handle!.services.settingsManager.flush();
        this.emitSessionConfig({ thinkingLevel: this.handle!.session.thinkingLevel });
      };
      if (context) await this.uiContextStorage.run(context, run);
      else await run();
      if (payload.operationId) this.completeControlOperation(payload.operationId);
      await this.sendModels({ requestId: "runtime-state" });
      this.acceptControl(payload.commandId, this.actualConfig());
    } catch (error) {
      this.rejectCommand(payload.commandId, "THINKING_LEVEL_INVALID", errorMessage(error));
      if (payload.operationId) this.controlOperations.delete(payload.operationId);
    }
  }

  private rename(payload: { name: string; intentId?: string }): void {
    if (!this.readyForControl()) return;
    try {
      this.renaming = true;
      this.handle!.session.setSessionName(payload.name);
      if (payload.intentId) this.send("rename_ack", { name: payload.name, intentId: payload.intentId });
    } catch (error) {
      this.fatal("RENAME_FAILED", errorMessage(error));
    } finally { this.renaming = false; }
  }

  private async shutdown(reason: string): Promise<void> {
    if (this.stopped) return;
    try {
      for (const hub of this.terminalInputs.values()) hub.clear();
      this.terminalInputs.clear();
      this.editorHost.reset();
      if (this.execution) this.execution.abortRequested = true;
      for (const controller of this.customControllers) controller.abort();
      this.cancelPendingInteractions(reason);
      const handle = this.handle;
      if (handle && "shutdown" in handle && typeof handle.shutdown === "function") await handle.shutdown();
      else handle?.dispose();
    } finally {
      this.stopped = true;
      this.widgetHost.dispose();
      for (const host of this.surfaceHosts.values()) host.dispose();
      this.surfaceHosts.clear();
      clearInterval(this.heartbeatTimer);
      this.mappingAckRejecter?.(new Error(reason));
      this.mappingAckResolver = undefined;
      this.mappingAckRejecter = undefined;
      this.send("stopped", { reason });
    }
  }

  private readyForControl(): boolean {
    return this.initialized && this.mappingAcknowledged && this.handle !== undefined && !this.stopped;
  }

  private acceptControl(commandId: string | undefined, result?: Record<string, unknown>): void {
    if (!commandId) return;
    this.send("command_accepted", { commandId });
    this.send("command_result", { commandId, status: "completed", ...(result ? { result } : {}) });
  }

  private rejectCommand(commandId: string | undefined, code: string, message: string): void {
    this.send("command_rejected", {
      ...(commandId ? { commandId } : {}),
      code,
      message
    });
  }

  private fatal(code: string, message: string): void {
    this.send("fatal", { code, message: bounded(message, 1000) });
  }

  private readStartTicks(): string | null {
    if (process.platform !== "linux") return null;
    try {
      // The start-time field is field 22 in /proc/<pid>/stat. The second field
      // can contain spaces and parentheses, so find the closing command name.
      const raw = readFileSync(`/proc/${process.pid}/stat`, "utf8");
      const closing = raw.lastIndexOf(")");
      const fields = raw.slice(closing + 2).trim().split(/\s+/);
      return fields[19] ?? null;
    } catch {
      return null;
    }
  }

  private onSessionEvent(event: AgentSessionEvent): void {
    try {
      switch (event.type) {
        case "agent_start":
          this.startNativeRun();
          break;
        case "agent_settled":
          this.finishNativeRun();
          break;
        case "message_start":
          this.messageStarted(event.message);
          break;
        case "message_update":
          this.messageUpdated(event.message, event.assistantMessageEvent);
          break;
        case "message_end":
          this.messageCompleted(event.message);
          break;
        case "tool_execution_start":
          this.toolStarted(event);
          break;
        case "tool_execution_update":
          this.toolUpdated(event);
          break;
        case "tool_execution_end":
          this.toolFinished(event);
          break;
        case "session_info_changed":
          if (event.name !== undefined && !this.renaming) {
            const context = this.operationContext();
            this.emitEvent({
              sessionId: this.sessionId,
              seq: 1,
              runId: context?.runId ?? null,
              operationId: context?.operationId ?? null,
              schemaVersion: 1,
              timestamp: nowTimestamp(),
              type: "session.updated",
              payload: { changes: { title: bounded(event.name, 120) } }
            });
          }
          break;
        case "thinking_level_changed":
          {
            const context = this.operationContext();
            this.emitEvent({
              sessionId: this.sessionId,
              seq: 1,
              runId: context?.runId ?? null,
              operationId: context?.operationId ?? null,
              schemaVersion: 1,
              timestamp: nowTimestamp(),
              type: "session.updated",
              payload: { changes: { thinkingLevel: event.level } }
            });
            break;
          }
        case "entry_appended":
          this.notifyPersistence();
          break;
        case "queue_update":
          this.reconcileSdkQueue("steer", event.steering);
          this.reconcileSdkQueue("followUp", event.followUp);
          break;
        case "compaction_start":
          {
            const context = this.operationContext();
            this.emitEvent({
              sessionId: this.sessionId,
              seq: 1,
              runId: context?.runId ?? null,
              operationId: context?.operationId ?? null,
              schemaVersion: 1,
              timestamp: nowTimestamp(),
              type: "runtime.notice",
              payload: { kind: "compaction", message: "compaction started" }
            });
          }
          break;
        case "compaction_end":
          {
            const context = this.operationContext();
            this.emitEvent({
              sessionId: this.sessionId,
              seq: 1,
              runId: context?.runId ?? null,
              operationId: context?.operationId ?? null,
              schemaVersion: 1,
              timestamp: nowTimestamp(),
              type: "runtime.notice",
              payload: {
                kind: "compaction",
                message: event.aborted ? "compaction aborted" : event.errorMessage ? bounded(event.errorMessage) : "compaction completed"
              }
            });
          }
          break;
        default:
          break;
      }
    } catch (error) {
      this.fatal("SDK_EVENT_ADAPTER_FAILED", errorMessage(error));
    }
  }

  private createStandaloneOperation(owner?: string, kind: "extension" | "bash" | "configure" = "extension"): OperationContext {
    const parent = this.uiContextStorage.getStore();
    const context: OperationContext = { operationId: randomUUID(), runId: null, kind };
    this.standaloneOperations.add(context.operationId);
    const causal = parent ? this.causalCommands.get(parent.operationId) : undefined;
    if (causal) this.causalCommands.set(context.operationId, causal);
    this.operationSessions.set(context.operationId, owner ?? (parent ? this.operationSessions.get(parent.operationId) : undefined) ?? this.currentSessionId);
    this.emitEvent({ sessionId: this.sessionId, seq: 1, runId: null, operationId: context.operationId,
      schemaVersion: 1, timestamp: nowTimestamp(), type: "operation.updated",
      payload: { operationId: context.operationId, kind: context.kind, status: "running",
        ...(parent && this.operationSessions.get(parent.operationId) === this.currentSessionId ? { parentOperationId: parent.operationId } : {}) } });
    return context;
  }

  private executionContext(): ToolContext | null {
    if (this.autonomous) return this.autonomous;
    const scoped = this.uiContextStorage.getStore();
    if (scoped && !this.closedOperations.has(scoped.operationId)) return scoped;
    if (this.execution) return { operationId: this.execution.operationId, runId: this.execution.runId };
    const extension = this.extensionExecutions.values().next().value as Execution | undefined;
    return extension ? { operationId: extension.operationId, runId: extension.runId } : null;
  }

  private startNativeRun(): void {
    if (this.execution?.runId || this.autonomous) return;
    const parent = this.uiContextStorage.getStore();
    const causal = parent ? this.causalCommands.get(parent.operationId) : undefined;
    const context = { operationId: randomUUID(), runId: randomUUID(), kind: "run" as const,
      source: parent ? "extension" as const : "runtime" as const,
      ...(causal ? { commandId: causal.commandId } : {}) };
    if (causal) {
      this.causalCommands.set(context.operationId, causal);
      causal.refs.push({ runId: context.runId, sessionId: this.currentSessionId });
      this.emitEvent({ sessionId: this.sessionId, seq: 1, runId: null, operationId: parent!.operationId,
        schemaVersion: 1, timestamp: nowTimestamp(), type: "command.updated",
        payload: { commandId: causal.commandId, kind: causal.kind, state: causal.state, runs: causal.refs } });
    }
    this.autonomous = context;
    this.emitEvent({ sessionId: this.sessionId, seq: 1, runId: context.runId, operationId: context.operationId,
      schemaVersion: 1, timestamp: nowTimestamp(), type: "operation.updated",
      payload: { operationId: context.operationId, kind: "run", runId: context.runId, status: "running",
        ...(parent && this.operationSessions.get(parent.operationId) === this.currentSessionId ? { parentOperationId: parent.operationId } : {}) } });
    this.emitEvent({ sessionId: this.sessionId, seq: 1, runId: context.runId, operationId: context.operationId,
      schemaVersion: 1, timestamp: nowTimestamp(), type: "run.updated",
      payload: { kind: "prompt", status: "running", phase: "thinking", source: context.source, ...(context.commandId ? { commandId: context.commandId } : {}) } });
  }

  private finishNativeRun(): void {
    const context = this.autonomous;
    if (!context) return;
    const status = context.outcome?.stopReason === "error" ? "failed" : context.outcome?.stopReason === "aborted" ? "aborted" : "completed";
    if (status !== "completed") this.emitEvent({ sessionId: this.sessionId, seq: 1, runId: context.runId,
      operationId: context.operationId, schemaVersion: 1, timestamp: nowTimestamp(), type: "run.content_sealed", payload: { reason: status } });
    this.emitEvent({ sessionId: this.sessionId, seq: 1, runId: context.runId, operationId: context.operationId,
      schemaVersion: 1, timestamp: nowTimestamp(), type: "run.updated", payload: {
        kind: "prompt", status, phase: null, source: context.source, ...(context.commandId ? { commandId: context.commandId } : {}),
        ...(context.outcome?.error ? { error: { code: "SDK_OPERATION_FAILED", message: bounded(context.outcome.error, 1000) } } : {}) } });
    this.emitOperationStatus(status === "aborted" ? "cancelled" : status, context);
    this.autonomous = undefined;
  }

  private messageId(message: unknown): string {
    const object = recordValue(message);
    const role = roleOf(message);
    // Agent core emits fresh partial objects for every assistant update.
    // Identity belongs to the start/update/end lifecycle, not JS references.
    if (role && this.activeMessageIds.has(role)) return this.activeMessageIds.get(role)!;
    const existing = object ? this.messageIds.get(object) : undefined;
    const value = existing ?? randomUUID();
    if (object) this.messageIds.set(object, value);
    if (role) this.activeMessageIds.set(role, value);
    return value;
  }

  private messageStarted(message: unknown): void {
    const role = roleOf(message);
    if (role === null) return;
    const context = this.executionContext() ?? this.createStandaloneOperation();
    const messageId = this.messageId(message);
    if (this.startedMessages.has(messageId)) return;
    this.startedMessages.add(messageId);
    this.messageContexts.set(messageId, { ...context });
    const record = recordValue(message) ?? {};
    const payload: RecordValue = { messageId, role };
    if (role === "custom") {
      payload.custom = {
        type: stringValue(record.customType) ?? "custom",
        display: boolValue(record.display),
        ...(recordValue(record.details) ? { details: recordValue(record.details) } : {})
      };
    } else if (role === "bash") {
      payload.bash = {
        command: bounded(stringValue(record.command) ?? "bash"),
        excludeFromContext: boolValue(record.excludeFromContext),
        outcome: "running"
      };
    }
    this.emitEvent({
      sessionId: this.sessionId,
      seq: 1,
      runId: context.runId,
      operationId: context.operationId,
      schemaVersion: 1,
      timestamp: nowTimestamp(),
      type: "message.started",
      payload
    });
    if (role === "user") {
      for (const block of contentBlocks(message, messageId)) this.emitContentStarted(context, messageId, block);
    }
  }

  private messageUpdated(message: unknown, assistantEvent: unknown): void {
    const role = roleOf(message);
    if (role !== "assistant") return;
    const messageId = this.messageId(message);
    if (!this.startedMessages.has(messageId)) this.messageStarted(message);
    const context = this.messageContexts.get(messageId) ?? this.executionContext();
    if (!context) return;
    const update = recordValue(assistantEvent);
    if (!update) return;
    const contentIndex = typeof update.contentIndex === "number" ? update.contentIndex : undefined;
    if (contentIndex === undefined) return;
    const partial = recordValue(update.partial);
    const content = Array.isArray(partial?.content) ? recordValue(partial.content[contentIndex]) : null;
    if (!content) return;
    const blockId = `${messageId}:${contentIndex}`;
    if (update.type === "text_start" || update.type === "thinking_start" || update.type === "toolcall_start") {
      const block = this.blockFromSdk(content, messageId, contentIndex);
      if (block) this.emitContentStarted(context, messageId, block);
      return;
    }
    if (update.type === "text_delta" || update.type === "thinking_delta" || update.type === "toolcall_delta") {
      if (!this.startedBlocks.has(blockId)) {
        const block = this.blockFromSdk(content, messageId, contentIndex);
        if (block) this.emitContentStarted(context, messageId, block);
      }
      if (typeof update.delta === "string") {
        this.emitEvent({
          sessionId: this.sessionId,
          seq: 1,
          runId: context.runId,
          operationId: context.operationId,
          schemaVersion: 1,
          timestamp: nowTimestamp(),
          type: "content.delta",
          payload: { messageId, blockId, delta: update.delta }
        });
      }
      return;
    }
    if (update.type === "text_end" || update.type === "thinking_end" || update.type === "toolcall_end") {
      const block = update.type === "toolcall_end"
        ? this.blockFromSdk(recordValue(update.toolCall) ?? content, messageId, contentIndex)
        : this.blockFromSdk(content, messageId, contentIndex);
      if (block && !this.startedBlocks.has(blockId)) this.emitContentStarted(context, messageId, block);
      if (block) {
        this.emitEvent({
          sessionId: this.sessionId,
          seq: 1,
          runId: context.runId,
          operationId: context.operationId,
          schemaVersion: 1,
          timestamp: nowTimestamp(),
          type: "content.ended",
          payload: { messageId, block: block }
        });
        this.startedBlocks.delete(blockId);
      }
    }
  }

  private messageCompleted(message: unknown): void {
    const role = roleOf(message);
    if (role === null) return;
    const messageId = this.messageId(message);
    if (!this.startedMessages.has(messageId)) this.messageStarted(message);
    const context = this.messageContexts.get(messageId) ?? this.executionContext();
    if (!context) return;
    const record = recordValue(message) ?? {};
    const blocks = contentBlocks(message, messageId);
    const payload: RecordValue = { messageId, role, blocks };
    if (role === "custom") {
      payload.custom = {
        type: stringValue(record.customType) ?? "custom",
        display: boolValue(record.display),
        ...(recordValue(record.details) ? { details: recordValue(record.details) } : {})
      };
    } else if (role === "bash") {
      const exitCode = typeof record.exitCode === "number" ? record.exitCode : undefined;
      const cancelled = boolValue(record.cancelled);
      payload.bash = {
        command: bounded(stringValue(record.command) ?? "bash"),
        excludeFromContext: boolValue(record.excludeFromContext),
        outcome: cancelled ? "aborted" : exitCode === 0 ? "succeeded" : "failed",
        ...(exitCode === undefined ? {} : { exitCode }),
        ...(cancelled ? { cancelled: true } : {}),
        ...(boolValue(record.truncated) ? { truncated: true } : {})
      };
      const output = stringValue(record.output);
      if (output) blocks.push({ id: `${messageId}:0`, index: 0, kind: "text", text: output });
    } else if (role === "assistant") {
      const execution = [this.execution, ...this.extensionExecutions.values()].find((candidate) => candidate?.operationId === context.operationId);
      const outcome = {
        stopReason: stringValue(record.stopReason) ?? "stop",
        ...(typeof record.errorMessage === "string" ? { error: record.errorMessage } : {})
      };
      if (execution) execution.assistantOutcome = outcome;
      if (this.autonomous?.operationId === context.operationId) this.autonomous.outcome = outcome;
      if (typeof record.stopReason === "string") payload.stopReason = record.stopReason;
      if (recordValue(record.usage)) payload.usage = recordValue(record.usage);
    }
    this.emitEvent({
      sessionId: this.sessionId,
      seq: 1,
      runId: context.runId,
      operationId: context.operationId,
      schemaVersion: 1,
      timestamp: nowTimestamp(),
      type: "message.completed",
      payload
    });
    for (const block of blocks) this.startedBlocks.delete(block.id);
    this.activeMessageIds.delete(role);
    this.startedMessages.delete(messageId);
    this.messageContexts.delete(messageId);
    if (this.uiContextStorage.getStore()?.operationId !== context.operationId && this.standaloneOperations.delete(context.operationId)) {
      this.emitOperationStatus("completed", { ...context, kind: "extension" });
    }
  }

  private blockFromSdk(value: RecordValue, messageId: string, index: number): ContentBlock | null {
    const type = value.type;
    const id = `${messageId}:${index}`;
    if (type === "text") return { id, index, kind: "text", text: stringValue(value.text) ?? "" };
    if (type === "thinking") {
      return {
        id,
        index,
        kind: "thinking",
        text: stringValue(value.thinking) ?? "",
        ...(value.redacted === true ? { redacted: true } : {})
      };
    }
    if (type === "toolCall" || typeof value.arguments === "object") {
      return {
        id,
        index,
        kind: "tool_call",
        toolCallId: stringValue(value.id) ?? id,
        toolName: stringValue(value.name) ?? "tool",
        arguments: jsonObject(value.arguments)
      };
    }
    return null;
  }

  private emitContentStarted(context: { operationId: string; runId: string | null }, messageId: string, block: ContentBlock): void {
    if (this.startedBlocks.has(block.id)) return;
    this.startedBlocks.add(block.id);
    this.emitEvent({
      sessionId: this.sessionId,
      seq: 1,
      runId: context.runId,
      operationId: context.operationId,
      schemaVersion: 1,
      timestamp: nowTimestamp(),
      type: "content.started",
      payload: {
        messageId,
        blockId: block.id,
        index: block.index,
        kind: block.kind,
        ...(block.kind === "tool_call" ? { toolCallId: block.toolCallId, toolName: block.toolName } : {})
      }
    });
  }

  private toolStarted(event: Extract<AgentSessionEvent, { type: "tool_execution_start" }>): void {
    const context = this.executionContext();
    if (!context) return;
    this.toolMessages.set(event.toolCallId, { ...context });
    this.emitEvent({
      sessionId: this.sessionId,
      seq: 1,
      runId: context.runId,
      operationId: context.operationId,
      schemaVersion: 1,
      timestamp: nowTimestamp(),
      type: "tool.started",
      payload: {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: jsonObject(event.args)
      }
    });
  }

  private toolUpdated(event: Extract<AgentSessionEvent, { type: "tool_execution_update" }>): void {
    const context = this.toolMessages.get(event.toolCallId);
    if (!context) return;
    this.emitEvent({
      sessionId: this.sessionId,
      seq: 1,
      runId: context.runId,
      operationId: context.operationId,
      schemaVersion: 1,
      timestamp: nowTimestamp(),
      type: "tool.updated",
      payload: {
        toolCallId: event.toolCallId,
        output: { text: textFromUnknown(event.partialResult), truncated: false }
      }
    });
  }

  private toolFinished(event: Extract<AgentSessionEvent, { type: "tool_execution_end" }>): void {
    const context = this.toolMessages.get(event.toolCallId);
    if (!context) return;
    this.emitEvent({
      sessionId: this.sessionId,
      seq: 1,
      runId: context.runId,
      operationId: context.operationId,
      schemaVersion: 1,
      timestamp: nowTimestamp(),
      type: "tool.finished",
      payload: {
        toolCallId: event.toolCallId,
        output: { text: textFromUnknown(event.result), truncated: false },
        isError: event.isError
      }
    });
    this.toolMessages.delete(event.toolCallId);
  }

  private emitEvent(input: unknown): void {
    const raw = recordValue(input)!;
    const operationId = stringValue(raw.operationId);
    const owner = operationId ? this.operationSessions.get(operationId) ?? this.currentSessionId : this.currentSessionId;
    if (operationId) this.operationSessions.set(operationId, owner);
    const event = parseProtocolEvent({ ...raw, sessionId: owner });
    if (event.type === "operation.updated" && ["completed", "failed", "cancelled", "interrupted"].includes(event.payload.status)) {
      this.closedOperations.add(event.payload.operationId);
    }
    if (this.backlog?.length || this.pendingBatches.size >= 256) {
      this.ensureBacklog().enqueue(event);
    } else this.eventBuffer.push(event);
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      queueMicrotask(() => { this.flushScheduled = false; this.flushEvents(); });
    }
    if (this.eventBuffer.length >= 500) this.flushEvents();
  }

  private ensureBacklog(): EventBacklog {
    this.backlog ??= new EventBacklog({ spoolDir: join(process.env.PI_REMOTE_WORKER_SPOOL_DIR ?? mkdtempSync(join(tmpdir(), "pi-worker-spool-")), "backlog") });
    return this.backlog;
  }

  private flushEvents(): void {
    while (this.pendingBatches.size < 256) {
      const batch = this.eventBuffer.length
        ? { events: this.eventBuffer.splice(0, 500), leaseId: null }
        : this.backlog?.takeBatch(500) ?? { events: [], leaseId: null };
      if (!batch.events.length) break;
      const batchNo = ++this.batchNo;
      const message = this.envelope("event_batch", { batchNo, events: batch.events }) as WorkerOutboundMessage;
      this.pendingBatches.set(batchNo, { message, backlogLeaseId: batch.leaseId });
      this.transport.send(message);
    }
    // A leased backlog batch has already left the queue's visible length, but
    // its file is still the only durable copy until the parent ACKs it.
    if (!this.eventBuffer.length && !this.backlog?.length && this.pendingBatches.size === 0) {
      for (const message of this.deferredMessages.splice(0)) this.transport.send(message);
    }
  }

  private ackBatch(batchNo: number): void {
    if (!Number.isSafeInteger(batchNo) || batchNo < 1) return;
    const pending = this.pendingBatches.get(batchNo);
    if (!pending) return;
    this.pendingBatches.delete(batchNo);
    if (pending.backlogLeaseId !== null) this.backlog?.ack(pending.backlogLeaseId);
    this.flushEvents();
  }

}

export interface WorkerProcessOptions {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  sessionId?: string;
  workerEpoch?: string;
  heartbeatMs?: number;
  factory?: WorkerSessionFactory;
}

function encodeMessage(message: WorkerOutboundMessage): string {
  return encodeSpooledOutbound(message, { spoolDir: process.env.PI_REMOTE_WORKER_SPOOL_DIR ?? "" });
}

function decodeMessage(line: string): WorkerInboundMessage {
  const value = JSON.parse(line) as RecordValue;
  if (value.ipcVersion !== IPC_VERSION || typeof value.sessionId !== "string" || typeof value.workerEpoch !== "string" || typeof value.type !== "string") {
    throw new Error("invalid IPC envelope");
  }
  return value as unknown as WorkerInboundMessage;
}

/** Start the newline-delimited worker protocol on arbitrary streams (testable without a child process). */
export async function runWorkerProcess(options: WorkerProcessOptions = {}): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const sessionId = options.sessionId ?? process.env.PI_REMOTE_WORKER_SESSION_ID ?? "unknown-session";
  const workerEpoch = options.workerEpoch ?? process.env.PI_REMOTE_WORKER_EPOCH ?? randomUUID();
  const transport: WorkerTransport = {
    send(message) {
      output.write(`${encodeMessage(message)}\n`);
    }
  };
  const worker = new PiWorker(transport, {
    sessionId,
    workerEpoch,
    factory: options.factory,
    heartbeatMs: options.heartbeatMs ?? Number(process.env.PI_REMOTE_WORKER_HEARTBEAT_MS ?? 5000)
  });
  const reader: Interface = createInterface({ input });
  try {
    for await (const line of reader) {
      try {
        await worker.receive(decodeMessage(line));
      } catch (error) {
        worker.receive({
          ipcVersion: IPC_VERSION,
          sessionId,
          workerEpoch,
          type: "shutdown",
          payload: { reason: "invalid_ipc" }
        }).catch(() => undefined);
        throw error;
      }
    }
  } finally {
    reader.close();
    worker.dispose();
  }
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  runWorkerProcess().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
