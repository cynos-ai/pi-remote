import { Buffer } from "node:buffer";
import type { Readable, Writable } from "node:stream";
import {
  IPC_VERSION,
  type IpcEnvelope,
  type WorkerInboundMessage,
  type WorkerOutboundMessage
} from "@pi-remote/agent-pi/worker";
import { authDisplaySchema, inputContentSchema, jsonObjectSchema, modelsResponseSchema, parseProtocolEvent, type ProtocolEvent } from "@pi-remote/protocol";

/** One JSON object per line keeps the worker transport inspectable and restartable. */
export const MAX_IPC_FRAME_BYTES = 1024 * 1024;
export const MAX_IPC_INPUT_FRAME_BYTES = 64 * 1024;

export class IpcProtocolError extends Error {
  constructor(message: string, public readonly code = "INVALID_IPC_FRAME") {
    super(message);
    this.name = "IpcProtocolError";
  }
}

type RecordValue = Record<string, unknown>;

function recordValue(value: unknown): RecordValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new IpcProtocolError("IPC frame must be a JSON object");
  }
  return value as RecordValue;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw new IpcProtocolError(`IPC ${field} must be a non-empty string`);
  }
  return value;
}

/** Text payloads obey transport byte limits, not the short identity limit. */
function payloadText(value: unknown, field: string, maxBytes = MAX_IPC_FRAME_BYTES): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new IpcProtocolError(`IPC ${field} must be text within the transport byte limit`, "INVALID_IPC_PAYLOAD");
  }
  return value;
}

function inputText(value: unknown, field: string): string {
  return payloadText(value, field, MAX_IPC_INPUT_FRAME_BYTES);
}

function requiredObject(value: unknown, field: string): RecordValue {
  try {
    return recordValue(value);
  } catch {
    throw new IpcProtocolError(`IPC ${field} must be an object`, "INVALID_IPC_PAYLOAD");
  }
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new IpcProtocolError(`IPC ${field} must be a positive integer`, "INVALID_IPC_PAYLOAD");
  }
  return value as number;
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new IpcProtocolError(`IPC ${field} must be a boolean`, "INVALID_IPC_PAYLOAD");
  }
  return value;
}

function baseEnvelope(value: unknown, allowedTypes: readonly string[]): { base: IpcEnvelope; record: RecordValue } {
  const record = recordValue(value);
  if (record.ipcVersion !== IPC_VERSION) throw new IpcProtocolError("unsupported IPC version");
  const sessionId = requiredString(record.sessionId, "sessionId");
  const workerEpoch = requiredString(record.workerEpoch, "workerEpoch");
  const type = requiredString(record.type, "type");
  if (!allowedTypes.includes(type)) throw new IpcProtocolError(`unsupported IPC message type ${type}`);
  return {
    base: { ipcVersion: IPC_VERSION, sessionId, workerEpoch, type, payload: record.payload },
    record
  };
}

function withPayload<TType extends string, TPayload>(base: IpcEnvelope, payload: TPayload): IpcEnvelope<TType, TPayload> {
  return { ...base, type: base.type as TType, payload };
}

function persistenceState(value: unknown, allowUninitialized = false): "uninitialized" | "unflushed" | "persisted" {
  if (value === "persisted" || value === "unflushed" || (allowUninitialized && value === "uninitialized")) return value as "uninitialized" | "unflushed" | "persisted";
  throw new IpcProtocolError("invalid persistence state", "INVALID_IPC_PAYLOAD");
}

function parseInboundPayload(type: string, value: unknown): unknown {
  const payload = requiredObject(value, "payload");
  switch (type) {
    case "initialize": {
      const result = {
        cwd: inputText(payload.cwd, "cwd"),
        agentDir: inputText(payload.agentDir, "agentDir"),
        sessionDir: inputText(payload.sessionDir, "sessionDir"),
        ...(payload.sessionFile === undefined ? {} : { sessionFile: inputText(payload.sessionFile, "sessionFile") }),
        ...(payload.sessionId === undefined ? {} : { sessionId: requiredString(payload.sessionId, "sessionId") }),
        ...(payload.persistenceState === undefined ? {} : { persistenceState: persistenceState(payload.persistenceState, true) }),
        ...(payload.title === undefined ? {} : { title: inputText(payload.title, "title") }),
        ...(payload.hasPendingTitle === undefined ? {} : { hasPendingTitle: booleanValue(payload.hasPendingTitle, "hasPendingTitle") }),
        ...(payload.operationId === undefined ? {} : { operationId: requiredString(payload.operationId, "operationId") }),
        ...(payload.model === undefined ? {} : { model: payload.model }),
        ...(payload.thinkingLevel === undefined ? {} : { thinkingLevel: payload.thinkingLevel === null ? null : requiredString(payload.thinkingLevel, "thinkingLevel") })
      };
      return result;
    }
    case "session_mapping_ack":
      return {
        piSessionId: requiredString(payload.piSessionId, "piSessionId"),
        piSessionFile: payloadText(payload.piSessionFile, "piSessionFile")
      };
    case "execute": {
      const kind = payload.kind;
      if (kind !== "prompt" && kind !== "compact" && kind !== "bash" && kind !== "extension_command") {
        throw new IpcProtocolError("IPC execute kind is invalid", "INVALID_IPC_PAYLOAD");
      }
      const commandKind = payload.commandKind === undefined
        ? undefined
        : payload.commandKind === "prompt" || payload.commandKind === "follow_up" || payload.commandKind === "compact" ||
            payload.commandKind === "bash" || payload.commandKind === "extension_command"
          ? payload.commandKind
          : (() => { throw new IpcProtocolError("IPC commandKind is invalid", "INVALID_IPC_PAYLOAD"); })();
      return {
        commandId: requiredString(payload.commandId, "commandId"),
        operationId: requiredString(payload.operationId, "operationId"),
        ...(payload.runId === undefined ? {} : { runId: requiredString(payload.runId, "runId") }),
        kind,
        ...(commandKind === undefined ? {} : { commandKind }),
        ...(payload.text === undefined ? {} : { text: inputText(payload.text, "text") }),
        ...(payload.instructions === undefined ? {} : { instructions: inputText(payload.instructions, "instructions") }),
        ...(payload.command === undefined ? {} : { command: inputText(payload.command, "command") }),
        ...(payload.excludeFromContext === undefined ? {} : { excludeFromContext: booleanValue(payload.excludeFromContext, "excludeFromContext") }),
        ...(payload.streamingBehavior === undefined ? {} : {
          streamingBehavior: payload.streamingBehavior === "steer" || payload.streamingBehavior === "followUp"
            ? payload.streamingBehavior
            : (() => { throw new IpcProtocolError("IPC streamingBehavior is invalid", "INVALID_IPC_PAYLOAD"); })()
        }),
        ...(payload.inputId === undefined ? {} : { inputId: requiredString(payload.inputId, "inputId") }),
        ...(payload.content === undefined ? {} : { content: inputContentSchema.parse(payload.content) })
      };
    }
    case "steer":
    case "follow_up":
      return {
        ...(payload.commandId === undefined ? {} : { commandId: requiredString(payload.commandId, "commandId") }),
        ...(payload.operationId === undefined ? {} : { operationId: requiredString(payload.operationId, "operationId") }),
        ...(payload.runId === undefined ? {} : { runId: requiredString(payload.runId, "runId") }),
        inputId: requiredString(payload.inputId, "inputId"),
        content: inputContentSchema.parse(payload.content ?? { text: payload.text }),
        text: inputText(payload.text, "text"),
        ...(payload.streamingBehavior === undefined ? {} : { streamingBehavior: payload.streamingBehavior })
      };
    case "abort":
      return {
        ...(payload.commandId === undefined ? {} : { commandId: requiredString(payload.commandId, "commandId") }),
        runId: requiredString(payload.runId, "runId"),
        ...(payload.preserveQueue === undefined ? {} : { preserveQueue: booleanValue(payload.preserveQueue, "preserveQueue") })
      };
    case "abort_bash":
      return payload.commandId === undefined ? {} : { commandId: requiredString(payload.commandId, "commandId") };
    case "respond":
      return {
        ...(payload.commandId === undefined ? {} : { commandId: requiredString(payload.commandId, "commandId") }),
        operationId: requiredString(payload.operationId, "operationId"),
        interactionId: requiredString(payload.interactionId, "interactionId"),
        response: requiredObject(payload.response, "response")
      };
    case "set_model":
      return {
        ...(payload.commandId === undefined ? {} : { commandId: requiredString(payload.commandId, "commandId") }),
        ...(payload.operationId === undefined ? {} : { operationId: requiredString(payload.operationId, "operationId") }),
        provider: requiredString(payload.provider, "provider"),
        modelId: requiredString(payload.modelId, "modelId"),
        ...(payload.persist === undefined ? {} : { persist: booleanValue(payload.persist, "persist") })
      };
    case "set_thinking":
      return {
        ...(payload.commandId === undefined ? {} : { commandId: requiredString(payload.commandId, "commandId") }),
        ...(payload.operationId === undefined ? {} : { operationId: requiredString(payload.operationId, "operationId") }),
        level: requiredString(payload.level, "level"),
        ...(payload.persist === undefined ? {} : { persist: booleanValue(payload.persist, "persist") })
      };
    case "rename":
      return { name: inputText(payload.name, "name"), ...(payload.intentId === undefined ? {} : { intentId: requiredString(payload.intentId, "intentId") }) };
    case "get_models":
      return { requestId: requiredString(payload.requestId, "requestId"), ...(payload.refresh === undefined ? {} : { refresh: booleanValue(payload.refresh, "refresh") }) };
    case "editor_state":
      return { text: inputText(payload.text, "text"), ...(payload.requestId === undefined ? {} : { requestId: requiredString(payload.requestId, "requestId") }) };
    case "session_replace_ack":
      if (payload.phase !== "intent" && payload.phase !== "bound") throw new IpcProtocolError("invalid replacement ACK phase");
      return { requestId: requiredString(payload.requestId, "requestId"), phase: payload.phase,
        appSessionId: requiredString(payload.appSessionId, "appSessionId"),
        ...(payload.error === undefined ? {} : { error: {
          code: requiredString(requiredObject(payload.error, "error").code, "error.code"),
          message: payloadText(requiredObject(payload.error, "error").message, "error.message")
        } }) };
    case "batch_ack":
      return { batchNo: positiveInteger(payload.batchNo, "batchNo") };
    case "shutdown":
      return payload.reason === undefined ? {} : { reason: payloadText(payload.reason, "reason") };
    default:
      throw new IpcProtocolError(`unsupported inbound IPC message type ${type}`);
  }
}

function parseOutboundPayload(type: string, value: unknown): unknown {
  const payload = requiredObject(value, "payload");
  switch (type) {
    case "auth_display":
      return { appSessionId: requiredString(payload.appSessionId, "appSessionId"), operationId: requiredString(payload.operationId, "operationId"),
        display: payload.display === null ? null : authDisplaySchema.parse(payload.display) };
    case "editor_state_ack":
      return { requestId: requiredString(payload.requestId, "requestId") };
    case "rename_ack":
      return { name: inputText(payload.name, "name"), intentId: requiredString(payload.intentId, "intentId") };
    case "models":
      if (!Array.isArray(payload.availableThinkingLevels) || !payload.availableThinkingLevels.every((level) => typeof level === "string" && level.length > 0)) throw new IpcProtocolError("invalid thinking levels");
      return { requestId: requiredString(payload.requestId, "requestId"), items: modelsResponseSchema.parse({ items: payload.items }).items, availableThinkingLevels: payload.availableThinkingLevels };
    case "session_replace_intent":
      if (!["new", "switch", "fork", "import"].includes(String(payload.kind))) throw new IpcProtocolError("invalid replacement kind");
      return {
        requestId: requiredString(payload.requestId, "requestId"), kind: payload.kind,
        piSessionId: requiredString(payload.piSessionId, "piSessionId"), piSessionFile: payloadText(payload.piSessionFile, "piSessionFile"),
        ...(payload.sourceOperationId === undefined ? {} : { sourceOperationId: requiredString(payload.sourceOperationId, "sourceOperationId") }),
        ...(payload.targetFile === undefined ? {} : { targetFile: payloadText(payload.targetFile, "targetFile") }),
        ...(payload.relocationCwd === undefined ? {} : { relocationCwd: payloadText(payload.relocationCwd, "relocationCwd") })
      };
    case "session_replaced":
      return {
        requestId: requiredString(payload.requestId, "requestId"), piSessionId: requiredString(payload.piSessionId, "piSessionId"),
        piSessionFile: payloadText(payload.piSessionFile, "piSessionFile"), persistenceState: persistenceState(payload.persistenceState)
      };
    case "session_mapping":
      return {
        piSessionId: requiredString(payload.piSessionId, "piSessionId"),
        piSessionFile: payloadText(payload.piSessionFile, "piSessionFile"),
        persistenceState: payload.persistenceState === "persisted" || payload.persistenceState === "unflushed"
          ? payload.persistenceState
          : (() => { throw new IpcProtocolError("IPC persistenceState is invalid", "INVALID_IPC_PAYLOAD"); })(),
        fileState: requiredString(payload.fileState, "fileState")
      };
    case "session_persisted":
      return { pid: positiveInteger(payload.pid, "pid"), at: requiredString(payload.at, "at"), ...(payload.appSessionId === undefined ? {} : { appSessionId: requiredString(payload.appSessionId, "appSessionId") }) };
    case "ready":
      return {
        pid: positiveInteger(payload.pid, "pid"),
        processGroupId: payload.processGroupId === null ? null : positiveInteger(payload.processGroupId, "processGroupId"),
        workerStartTicks: payload.workerStartTicks === null ? null : requiredString(payload.workerStartTicks, "workerStartTicks"),
        persistenceState: payload.persistenceState === "persisted" || payload.persistenceState === "unflushed"
          ? payload.persistenceState
          : (() => { throw new IpcProtocolError("IPC persistenceState is invalid", "INVALID_IPC_PAYLOAD"); })()
      };
    case "command_accepted":
      return {
        commandId: requiredString(payload.commandId, "commandId"),
        ...(payload.runId === undefined ? {} : { runId: requiredString(payload.runId, "runId") }),
        ...(payload.operationId === undefined ? {} : { operationId: requiredString(payload.operationId, "operationId") })
      };
    case "command_rejected":
      return {
        ...(payload.commandId === undefined ? {} : { commandId: requiredString(payload.commandId, "commandId") }),
        code: requiredString(payload.code, "code"),
        message: payloadText(payload.message, "message")
      };
    case "command_result":
      return {
        commandId: requiredString(payload.commandId, "commandId"),
        status: payload.status === "completed" || payload.status === "failed" || payload.status === "cancelled"
          ? payload.status
          : (() => { throw new IpcProtocolError("IPC command result status is invalid", "INVALID_IPC_PAYLOAD"); })(),
        ...(payload.error === undefined ? {} : { error: requiredObject(payload.error, "error") }),
        ...(payload.result === undefined ? {} : { result: jsonObjectSchema.parse(payload.result) })
      };
    case "event_batch": {
      const batchNo = positiveInteger(payload.batchNo, "batchNo");
      if (!Array.isArray(payload.events) || payload.events.length === 0 || payload.events.length > 500) {
        throw new IpcProtocolError("IPC event batch size is invalid", "INVALID_IPC_PAYLOAD");
      }
      return { batchNo, events: payload.events.map((event) => parseProtocolEvent(event)) };
    }
    case "heartbeat":
      return {
        pid: positiveInteger(payload.pid, "pid"),
        at: requiredString(payload.at, "at"),
        active: booleanValue(payload.active, "active")
      };
    case "fatal":
      return {
        code: requiredString(payload.code, "code"),
        message: payloadText(payload.message, "message"),
        ...(payload.details === undefined ? {} : { details: requiredObject(payload.details, "details") })
      };
    case "extension_error":
      return {
        ...(payload.sessionId === undefined ? {} : { sessionId: requiredString(payload.sessionId, "sessionId") }),
        ...(payload.operationId === undefined ? {} : { operationId: requiredString(payload.operationId, "operationId") }),
        extensionPath: payloadText(payload.extensionPath, "extensionPath"),
        event: requiredString(payload.event, "event"),
        error: payloadText(payload.error, "error"),
        ...(payload.stack === undefined ? {} : { stack: payloadText(payload.stack, "stack") })
      };
    case "stopped":
      return { reason: payloadText(payload.reason, "reason") };
    default:
      throw new IpcProtocolError(`unsupported outbound IPC message type ${type}`);
  }
}

const inboundTypes = [
  "initialize", "session_mapping_ack", "execute", "steer", "follow_up", "abort", "abort_bash",
  "respond", "set_model", "set_thinking", "rename", "batch_ack", "shutdown", "get_models", "editor_state", "session_replace_ack"
] as const;
const outboundTypes = [
  "auth_display",
  "session_mapping", "session_persisted", "ready", "command_accepted", "command_rejected", "command_result",
  "event_batch", "heartbeat", "fatal", "extension_error", "stopped", "models", "editor_state_ack", "rename_ack", "session_replace_intent", "session_replaced"
] as const;

export function decodeWorkerInbound(value: unknown): WorkerInboundMessage {
  const { base } = baseEnvelope(value, inboundTypes);
  return withPayload(base, parseInboundPayload(base.type, base.payload)) as WorkerInboundMessage;
}

export function decodeWorkerOutbound(value: unknown): WorkerOutboundMessage {
  const { base } = baseEnvelope(value, outboundTypes);
  return withPayload(base, parseOutboundPayload(base.type, base.payload)) as WorkerOutboundMessage;
}

export function encodeIpcMessage(message: WorkerInboundMessage | WorkerOutboundMessage): string {
  let encoded: string;
  try {
    encoded = JSON.stringify(message);
  } catch (error) {
    throw new IpcProtocolError(`IPC message is not JSON serializable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (Buffer.byteLength(encoded, "utf8") > MAX_IPC_FRAME_BYTES) {
    throw new IpcProtocolError("IPC message exceeds the frame limit", "IPC_FRAME_TOO_LARGE");
  }
  return encoded;
}

export class IpcLineDecoder {
  private pending = "";

  constructor(private readonly maxFrameBytes = MAX_IPC_FRAME_BYTES) {}

  push(chunk: string | Uint8Array): string[] {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    this.pending += text;
    if (Buffer.byteLength(this.pending, "utf8") > this.maxFrameBytes && !this.pending.includes("\n")) {
      throw new IpcProtocolError("IPC line exceeds the frame limit", "IPC_FRAME_TOO_LARGE");
    }
    const lines: string[] = [];
    let newline = this.pending.indexOf("\n");
    while (newline >= 0) {
      const line = this.pending.slice(0, newline).replace(/\r$/, "");
      this.pending = this.pending.slice(newline + 1);
      if (Buffer.byteLength(line, "utf8") > this.maxFrameBytes) {
        throw new IpcProtocolError("IPC line exceeds the frame limit", "IPC_FRAME_TOO_LARGE");
      }
      if (line.trim().length > 0) lines.push(line);
      newline = this.pending.indexOf("\n");
    }
    if (Buffer.byteLength(this.pending, "utf8") > this.maxFrameBytes) {
      throw new IpcProtocolError("IPC line exceeds the frame limit", "IPC_FRAME_TOO_LARGE");
    }
    return lines;
  }

  finish(): void {
    if (this.pending.trim().length > 0) throw new IpcProtocolError("IPC stream ended with an incomplete line");
    this.pending = "";
  }
}

export interface WorkerIpcChannelOptions {
  input: Readable;
  output: Writable;
  maxFrameBytes?: number;
  hydrateOutbound?: (value: unknown) => unknown | Promise<unknown>;
  /** Return trusted resource names referenced by the raw frame for post-commit cleanup. */
  getOutboundSpoolFiles?: (value: unknown) => readonly string[];
  onMessage: (message: WorkerOutboundMessage, context: WorkerIpcMessageContext) => void | Promise<void>;
  onError?: (error: Error) => void;
}

export interface WorkerIpcMessageContext {
  /** Basenames only; the channel never accepts a path from the worker. */
  readonly outboundSpoolFiles: readonly string[];
}

/** Bidirectional newline-delimited channel used by WorkerManager and tests. */
export class WorkerIpcChannel {
  private readonly decoder: IpcLineDecoder;
  private readChain: Promise<void> = Promise.resolve();
  private readonly onData = (chunk: string | Uint8Array): void => {
    try {
      for (const line of this.decoder.push(chunk)) {
        this.readChain = this.readChain.then(async () => {
          const value = JSON.parse(line) as unknown;
          const hydrated = this.options.hydrateOutbound ? await this.options.hydrateOutbound(value) : value;
          const outboundSpoolFiles = this.options.getOutboundSpoolFiles?.(value) ?? [];
          await this.options.onMessage(decodeWorkerOutbound(hydrated), { outboundSpoolFiles });
        });
        void this.readChain.catch((error: unknown) => this.fail(error));
      }
    } catch (error) {
      this.fail(error);
    }
  };
  private readonly onEnd = (): void => {
    try {
      this.decoder.finish();
    } catch (error) {
      this.fail(error);
    }
  };
  private readonly onStreamError = (error: Error): void => this.fail(error);
  private closed = false;

  constructor(private readonly options: WorkerIpcChannelOptions) {
    this.decoder = new IpcLineDecoder(options.maxFrameBytes ?? MAX_IPC_FRAME_BYTES);
    options.input.setEncoding("utf8");
    options.input.on("data", this.onData);
    options.input.once("end", this.onEnd);
    options.input.once("close", this.onEnd);
    options.input.on("error", this.onStreamError);
    options.output.on("error", this.onStreamError);
  }

  send(message: WorkerInboundMessage): boolean {
    if (this.closed || this.options.output.destroyed) return false;
    try {
      return this.options.output.write(encodeIpcMessage(message) + "\n");
    } catch (error) {
      this.fail(error);
      return false;
    }
  }

  async drain(): Promise<void> {
    await this.readChain;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.options.input.removeListener("data", this.onData);
    this.options.input.removeListener("end", this.onEnd);
    this.options.input.removeListener("close", this.onEnd);
    this.options.input.removeListener("error", this.onStreamError);
    this.options.output.removeListener("error", this.onStreamError);
  }

  private fail(error: unknown): void {
    if (this.closed) return;
    this.closed = true;
    const normalized = error instanceof IpcProtocolError
      ? error
      : error instanceof Error ? error : new Error(String(error));
    this.options.onError?.(normalized);
  }
}

export function makeIpcEnvelope<TType extends string, TPayload>(
  sessionId: string,
  workerEpoch: string,
  type: TType,
  payload: TPayload
): IpcEnvelope<TType, TPayload> {
  return { ipcVersion: IPC_VERSION, sessionId, workerEpoch, type, payload };
}

export type { IpcEnvelope, ProtocolEvent };
