import { parseProtocolEvent, type ContentBlock, type LiveContentBlock, type ProtocolEvent } from "./events.js";
import type {
  CommandProjection,
  InputProjection,
  InteractionProjection,
  LiveItem,
  LiveMessageItem,
  LiveToolItem,
  MessageData,
  OperationProjection,
  ReducerState,
  RunProjection,
  TimelineItem,
  ToolData
} from "./state.js";
import { createInitialState } from "./state.js";

export class ReducerError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ReducerError";
    this.code = code;
  }
}

export class EventGapError extends ReducerError {
  readonly expectedSeq: number;
  readonly receivedSeq: number;

  constructor(expectedSeq: number, receivedSeq: number) {
    super("EVENT_GAP", `expected event seq ${expectedSeq}, received ${receivedSeq}`);
    this.name = "EventGapError";
    this.expectedSeq = expectedSeq;
    this.receivedSeq = receivedSeq;
  }
}

export class DuplicateEventConflictError extends ReducerError {
  readonly seq: number;

  constructor(seq: number) {
    super("EVENT_DUPLICATE_CONFLICT", `event seq ${seq} was already applied with different content`);
    this.name = "DuplicateEventConflictError";
    this.seq = seq;
  }
}

export class InvalidEventStateError extends ReducerError {
  constructor(message: string) {
    super("INVALID_EVENT_STATE", message);
    this.name = "InvalidEventStateError";
  }
}

function fail(message: string): never {
  throw new InvalidEventStateError(message);
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

function signature(event: ProtocolEvent): string {
  return JSON.stringify(canonicalize(event));
}

function cloneState(state: ReducerState): ReducerState {
  // Finalized content is immutable. Copy its container, never its payloads.
  const { timelineItems, eventSignatures, ...mutable } = state;
  return { ...structuredClone(mutable), timelineItems: [...timelineItems], eventSignatures: { ...eventSignatures } };
}

function operationIdOf(event: ProtocolEvent): string {
  if (event.operationId === null) fail(`${event.type} has no operationId`);
  return event.operationId;
}

function runIdOf(event: ProtocolEvent): string {
  if (event.runId === null) fail(`${event.type} has no runId`);
  return event.runId;
}

function operationFor(state: ReducerState, operationId: string): OperationProjection {
  const operation = state.operations[operationId];
  if (!operation) fail(`operation ${operationId} does not exist`);
  return operation;
}

function runFor(state: ReducerState, runId: string): RunProjection {
  const run = state.runs[runId];
  if (!run) fail(`run ${runId} does not exist`);
  return run;
}

function liveFor(state: ReducerState, itemId: string): LiveItem {
  const item = state.liveItems[itemId];
  if (!item) fail(`live item ${itemId} does not exist`);
  return item;
}

function isTerminalOperation(status: OperationProjection["status"]): boolean {
  return status === "completed" || status === "failed" || status === "interrupted" || status === "cancelled";
}

function isTerminalRun(status: RunProjection["status"]): boolean {
  return status === "completed" || status === "failed" || status === "aborted" || status === "interrupted" || status === "cancelled";
}

/** A queued Run belongs to the durable follow-up queue and is not executing. */
function isActiveRun(status: RunProjection["status"]): boolean {
  return status === "running" || status === "stopping";
}

function ensureOperationOpen(state: ReducerState, operationId: string, type: string): OperationProjection {
  const operation = operationFor(state, operationId);
  if (isTerminalOperation(operation.status)) fail(`${type} arrived after operation ${operationId} was ${operation.status}`);
  return operation;
}

function ensureRunOpen(state: ReducerState, runId: string, type: string): RunProjection {
  const run = runFor(state, runId);
  if (isTerminalRun(run.status) || run.contentSealed) fail(`${type} arrived after run ${runId} was closed`);
  return run;
}

function ensureEnvelopeOwnership(state: ReducerState, operationId: string, runId: string | null): void {
  const operation = operationFor(state, operationId);
  if (runId !== null && operation.runId !== null && operation.runId !== runId) {
    fail(`run ${runId} does not belong to operation ${operationId}`);
  }
}

function addTimelineItem(state: ReducerState, item: TimelineItem): void {
  if (state.timelineItems.some((existing) => existing.itemId === item.itemId)) {
    fail(`timeline item ${item.itemId} was finalized more than once`);
  }
  state.timelineItems.push(item);
  state.timelineItems.sort((left, right) =>
    left.ordinalSeq - right.ordinalSeq || left.itemId.localeCompare(right.itemId)
  );
}

function messageText(data: MessageData): string {
  return data.blocks
    .filter((block): block is ContentBlock & { kind: "text" } => block.kind === "text")
    .map((block) => block.text)
    .join("");
}

function finalizeLiveItem(
  state: ReducerState,
  item: LiveItem,
  finalizedSeq: number,
  completeness: "complete" | "partial",
  endReason?: "failed" | "aborted" | "interrupted"
): void {
  const timelineItem: TimelineItem = {
    ...item,
    finalizedSeq,
    completeness,
    ...(endReason ? { endReason } : {})
  } as TimelineItem;
  addTimelineItem(state, timelineItem);
  delete state.liveItems[item.itemId];
  if (item.kind === "message" && completeness === "complete") {
    state.session.lastMessagePreview = messageText(item.data).slice(-240) || state.session.lastMessagePreview;
  }
}

function partialMessageData(data: MessageData): MessageData {
  const blocks = data.blocks.map((block) => {
    if (block.kind !== "tool_call" || !("argumentsIncomplete" in block)) return block;
    return {
      id: block.id,
      index: block.index,
      kind: "tool_call" as const,
      toolCallId: block.toolCallId,
      toolName: block.toolName,
      argumentsText: block.argumentsText,
      argumentsIncomplete: true as const
    };
  });
  if (data.role !== "bash" || data.bash === undefined) return { ...data, blocks };
  const { exitCode: _exitCode, cancelled: _cancelled, ...bashWithoutTerminalFields } = data.bash;
  void _exitCode;
  void _cancelled;
  return {
    ...data,
    blocks,
    bash: { ...bashWithoutTerminalFields, outcome: "unknown" }
  };
}

function partialToolData(data: ToolData): ToolData {
  return {
    toolCallId: data.toolCallId,
    messageId: data.messageId,
    toolName: data.toolName,
    args: structuredClone(data.args),
    ...(data.output ? { output: structuredClone(data.output) } : {}),
    outcome: "unknown"
  };
}

function sealItems(
  state: ReducerState,
  predicate: (item: LiveItem) => boolean,
  seq: number,
  reason: "failed" | "aborted" | "interrupted"
): void {
  const matching = Object.values(state.liveItems).filter(predicate);
  for (const item of matching) {
    const data = item.kind === "message" ? partialMessageData(item.data) : partialToolData(item.data);
    finalizeLiveItem(state, { ...item, data } as LiveItem, seq, "partial", reason);
  }
}

function setSessionRunStatus(state: ReducerState, run: RunProjection): void {
  if (isActiveRun(run.status)) {
    state.session.activeRunId = run.runId;
    state.session.status = run.status === "stopping" ? "busy" : "running";
    state.session.phase = run.phase;
    return;
  }
  // Queued Runs are represented by queue.items and may coexist with the
  // currently executing Run. They must not replace activeRunId or make a
  // second queued follow-up look like a concurrent model execution.
  if (run.status === "queued") {
    if (state.session.activeRunId === null) {
      state.session.status = "queued";
      state.session.phase = run.phase;
    }
    return;
  }
  if (state.session.activeRunId === run.runId) {
    state.session.activeRunId = null;
    state.session.phase = null;
    if (run.status === "failed") state.session.status = "failed";
    else if (run.status === "aborted" || run.status === "interrupted") state.session.status = "interrupted";
    else if (run.status === "cancelled") state.session.status = "idle";
    else state.session.status = state.queue.items.length > 0 ? "queued" : "idle";
  }
}

function refreshQueueProjection(state: ReducerState): void {
  state.session.queuedCount = state.queue.items.length;
  state.session.queueState = state.queue.state;
  state.session.queueVersion = state.queue.version;
  state.session.queuePause = structuredClone(state.queue.pause);
  if (state.session.activeRunId === null && state.queue.items.length > 0 && state.session.status === "idle") {
    state.session.status = "queued";
  }
}

function refreshSessionStatus(state: ReducerState): void {
  const activeRun = Object.values(state.runs).find((run) => isActiveRun(run.status));
  if (activeRun) {
    setSessionRunStatus(state, activeRun);
    return;
  }
  const waitingOperation = Object.values(state.operations).find((operation) => operation.status === "waiting_input");
  if (waitingOperation) {
    state.session.status = "waiting_input";
    return;
  }
  if (state.queue.items.length > 0) {
    state.session.status = "queued";
    return;
  }
  if (["queued", "running", "busy", "waiting_input"].includes(state.session.status)) {
    state.session.status = "idle";
  }
}

function handleCommandUpdated(state: ReducerState, event: Extract<ProtocolEvent, { type: "command.updated" }>): void {
  const payload = event.payload;
  const existing = state.commands[payload.commandId];
  const command: CommandProjection = existing
    ? existing
    : {
        commandId: payload.commandId,
        kind: payload.kind,
        state: payload.state,
        targetRunId: payload.targetRunId ?? null,
        runs: []
      };
  if (command.kind !== payload.kind) fail(`command ${payload.commandId} changed kind`);
  if (existing && isTerminalCommand(existing.state) && existing.state !== payload.state) {
    fail(`command ${payload.commandId} changed after terminal state ${existing.state}`);
  }
  command.state = payload.state;
  if (payload.targetRunId !== undefined) command.targetRunId = payload.targetRunId;
  if (payload.runs !== undefined) {
    const refs = payload.runs;
    if (new Set(refs.map((ref) => `${ref.sessionId}:${ref.runId}`)).size !== refs.length) {
      fail(`command ${payload.commandId} contains duplicate run references`);
    }
    command.runs = structuredClone(refs);
  }
  if (payload.error !== undefined) command.error = structuredClone(payload.error);
  if (payload.result !== undefined) command.result = structuredClone(payload.result);
  state.commands[payload.commandId] = command;
}

function isTerminalCommand(state: CommandProjection["state"]): boolean {
  return state === "completed" || state === "failed" || state === "cancelled" || state === "unknown";
}

function handleOperationUpdated(state: ReducerState, event: Extract<ProtocolEvent, { type: "operation.updated" }>): void {
  const payload = event.payload;
  const operationId = operationIdOf(event);
  const existing = state.operations[operationId];
  if (existing && existing.kind !== payload.kind) fail(`operation ${operationId} changed kind`);
  if (existing && isTerminalOperation(existing.status) && existing.status !== payload.status) {
    fail(`operation ${operationId} changed after terminal state ${existing.status}`);
  }
  if (payload.parentOperationId === operationId) fail(`operation ${operationId} cannot be its own parent`);
  if (payload.parentOperationId !== undefined && !state.operations[payload.parentOperationId]) {
    fail(`parent operation ${payload.parentOperationId} does not exist`);
  }
  const runId = event.runId ?? payload.runId ?? null;
  if (payload.runId !== undefined && event.runId !== null && payload.runId !== event.runId) {
    fail(`operation ${operationId} payload runId does not match envelope`);
  }
  if (payload.kind === "run" && runId === null) fail(`run operation ${operationId} requires runId`);
  const operation: OperationProjection = existing
    ? existing
    : {
        operationId,
        kind: payload.kind,
        status: payload.status,
        parentOperationId: payload.parentOperationId ?? null,
        commandId: payload.commandId ?? null,
        runId,
        startedSeq: event.seq,
        updatedSeq: event.seq
      };
  operation.status = payload.status;
  operation.updatedSeq = event.seq;
  if (payload.parentOperationId !== undefined) operation.parentOperationId = payload.parentOperationId;
  if (payload.commandId !== undefined) operation.commandId = payload.commandId;
  if (runId !== null) operation.runId = runId;
  if (payload.error !== undefined) operation.error = structuredClone(payload.error);
  if (isTerminalOperation(payload.status)) {
    const openItems = Object.values(state.liveItems).filter((item) => item.operationId === operationId);
    if (openItems.length > 0) fail(`operation ${operationId} ended with open content`);
    for (const interaction of Object.values(state.interactions)) {
      if (interaction.operationId === operationId && interaction.status === "pending") {
        interaction.status = "cancelled";
        interaction.reason = "operation_ended";
        interaction.updatedSeq = event.seq;
      }
    }
    if (payload.status === "failed") state.session.status = "failed";
    if (payload.status === "interrupted") state.session.status = "interrupted";
  }
  state.operations[operationId] = operation;
  if (payload.status === "waiting_input") state.session.status = "waiting_input";
}

function handleRunUpdated(state: ReducerState, event: Extract<ProtocolEvent, { type: "run.updated" }>): void {
  const payload = event.payload;
  const runId = runIdOf(event);
  const operationId = operationIdOf(event);
  const operation = operationFor(state, operationId);
  if (operation.kind !== "run") fail(`run ${runId} references non-run operation ${operationId}`);
  const existing = state.runs[runId];
  if (existing && existing.operationId !== operationId) fail(`run ${runId} changed operation`);
  if (existing && isTerminalRun(existing.status) && existing.status !== payload.status) {
    fail(`run ${runId} changed after terminal state ${existing.status}`);
  }
  if (existing && existing.kind !== payload.kind) fail(`run ${runId} changed kind`);
  if (!existing && payload.source === undefined) fail(`first run.updated for ${runId} must include source`);
  const activeOtherRun = Object.values(state.runs).find((run) => run.runId !== runId && isActiveRun(run.status));
  if (!existing && activeOtherRun && isActiveRun(payload.status)) {
    fail(`session already has active run ${activeOtherRun.runId}`);
  }
  const run: RunProjection = existing
    ? existing
    : {
        runId,
        operationId,
        kind: payload.kind,
        status: payload.status,
        phase: payload.phase,
        source: payload.source ?? "runtime",
        commandId: payload.commandId ?? null,
        startedSeq: event.seq,
        updatedSeq: event.seq,
        contentSealed: false
      };
  run.status = payload.status;
  run.phase = payload.phase;
  run.updatedSeq = event.seq;
  if (payload.source !== undefined) run.source = payload.source;
  if (payload.commandId !== undefined) run.commandId = payload.commandId;
  if (payload.error !== undefined) run.error = structuredClone(payload.error);
  if (isTerminalRun(payload.status)) {
    const openItems = Object.values(state.liveItems).filter((item) => item.runId === runId);
    if (openItems.length > 0) fail(`run ${runId} ended with open content; seal it first`);
  }
  state.runs[runId] = run;
  operation.runId = runId;
  setSessionRunStatus(state, run);
}

function makeMessageData(
  messageId: string,
  payload: Extract<ProtocolEvent, { type: "message.started" }>["payload"]
): MessageData {
  if (payload.role === "custom") return { messageId, role: payload.role, blocks: [], custom: structuredClone(payload.custom) };
  if (payload.role === "bash") {
    if (payload.bash.outcome !== "running") fail(`new Bash message ${messageId} must start with outcome=running`);
    return { messageId, role: payload.role, blocks: [], bash: structuredClone(payload.bash) };
  }
  return { messageId, role: payload.role, blocks: [] };
}

function handleContentStarted(state: ReducerState, event: Extract<ProtocolEvent, { type: "content.started" }>): void {
  const operationId = operationIdOf(event);
  ensureOperationOpen(state, operationId, event.type);
  ensureEnvelopeOwnership(state, operationId, event.runId);
  const message = liveFor(state, event.payload.messageId);
  if (message.kind !== "message") fail(`content.started message ${event.payload.messageId} is not a message`);
  if (message.operationId !== operationId || message.runId !== event.runId) fail(`content.started ownership mismatch for ${event.payload.messageId}`);
  if (message.data.blocks.some((block) => block.id === event.payload.blockId)) fail(`block ${event.payload.blockId} already exists`);
  const payload = event.payload;
  let block: LiveContentBlock;
  if (payload.kind === "tool_call") {
    block = {
      id: payload.blockId,
      index: payload.index,
      kind: "tool_call",
      toolCallId: payload.toolCallId,
      toolName: payload.toolName,
      argumentsText: "",
      argumentsIncomplete: true
    };
  } else {
    block = { id: payload.blockId, index: payload.index, kind: payload.kind, text: "" };
  }
  message.data.blocks.push(block);
}

function handleMessageStartedWithId(state: ReducerState, event: Extract<ProtocolEvent, { type: "message.started" }>): void {
  const operationId = operationIdOf(event);
  ensureOperationOpen(state, operationId, event.type);
  ensureEnvelopeOwnership(state, operationId, event.runId);
  const messageId = event.payload.messageId;
  if (state.liveItems[messageId] || state.timelineItems.some((item) => item.itemId === messageId)) {
    fail(`message ${messageId} already exists`);
  }
  const item: LiveMessageItem = {
    itemId: messageId,
    kind: "message",
    operationId,
    runId: event.runId,
    ordinalSeq: event.seq,
    data: makeMessageData(messageId, event.payload)
  };
  state.liveItems[messageId] = item;
}

function handleContentDelta(state: ReducerState, event: Extract<ProtocolEvent, { type: "content.delta" }>): void {
  const operationId = operationIdOf(event);
  ensureOperationOpen(state, operationId, event.type);
  ensureEnvelopeOwnership(state, operationId, event.runId);
  const message = liveFor(state, event.payload.messageId);
  if (message.kind !== "message") fail(`content.delta message ${event.payload.messageId} is not a message`);
  if (message.operationId !== operationId || message.runId !== event.runId) fail(`content.delta ownership mismatch`);
  const block = message.data.blocks.find((candidate) => candidate.id === event.payload.blockId);
  if (!block) fail(`block ${event.payload.blockId} does not exist`);
  if (block.kind === "tool_call") {
    if (!("argumentsIncomplete" in block)) fail(`content.delta arrived after block ${block.id} ended`);
    block.argumentsText += event.payload.delta;
  } else {
    block.text += event.payload.delta;
  }
}

function handleContentEnded(state: ReducerState, event: Extract<ProtocolEvent, { type: "content.ended" }>): void {
  const operationId = operationIdOf(event);
  ensureOperationOpen(state, operationId, event.type);
  ensureEnvelopeOwnership(state, operationId, event.runId);
  const message = liveFor(state, event.payload.messageId);
  if (message.kind !== "message") fail(`content.ended message ${event.payload.messageId} is not a message`);
  if (message.operationId !== operationId || message.runId !== event.runId) fail(`content.ended ownership mismatch`);
  const index = message.data.blocks.findIndex((candidate) => candidate.id === event.payload.block.id);
  if (index < 0) fail(`block ${event.payload.block.id} does not exist`);
  const current = message.data.blocks[index]!;
  if (current.kind !== event.payload.block.kind || current.index !== event.payload.block.index) {
    fail(`content.ended block ${event.payload.block.id} changed identity`);
  }
  message.data.blocks[index] = structuredClone(event.payload.block);
}

function handleMessageCompleted(state: ReducerState, event: Extract<ProtocolEvent, { type: "message.completed" }>): void {
  const operationId = operationIdOf(event);
  ensureOperationOpen(state, operationId, event.type);
  ensureEnvelopeOwnership(state, operationId, event.runId);
  const item = liveFor(state, event.payload.messageId);
  if (item.kind !== "message") fail(`message.completed ${event.payload.messageId} is not a message`);
  if (item.operationId !== operationId || item.runId !== event.runId) fail(`message.completed ownership mismatch`);
  if (item.data.role !== event.payload.role) fail(`message ${event.payload.messageId} changed role`);
  const blocks = event.payload.blocks;
  const indices = new Set(blocks.map((block) => block.index));
  if (indices.size !== blocks.length) fail(`message ${event.payload.messageId} has duplicate block indexes`);
  const data: MessageData = {
    messageId: event.payload.messageId,
    role: event.payload.role,
    blocks: structuredClone(blocks),
    ...(event.payload.role === "custom" ? { custom: structuredClone(event.payload.custom) } : {}),
    ...(event.payload.role === "bash" ? { bash: structuredClone(event.payload.bash) } : {}),
    ...(event.payload.role === "assistant" && event.payload.stopReason !== undefined ? { stopReason: event.payload.stopReason } : {}),
    ...(event.payload.role === "assistant" && event.payload.usage !== undefined ? { usage: structuredClone(event.payload.usage) } : {})
  };
  if (data.role === "bash" && (data.bash?.outcome === "running" || data.bash?.outcome === "unknown")) {
    fail(`completed Bash message ${event.payload.messageId} has non-terminal outcome`);
  }
  finalizeLiveItem(state, { ...item, data }, event.seq, "complete");
}

function handleToolStarted(state: ReducerState, event: Extract<ProtocolEvent, { type: "tool.started" }>): void {
  const operationId = operationIdOf(event);
  ensureOperationOpen(state, operationId, event.type);
  ensureEnvelopeOwnership(state, operationId, event.runId);
  const toolCallId = event.payload.toolCallId;
  if (state.liveItems[toolCallId] || state.timelineItems.some((item) => item.itemId === toolCallId)) {
    fail(`tool ${toolCallId} already exists`);
  }
  const item: LiveToolItem = {
    itemId: toolCallId,
    kind: "tool",
    operationId,
    runId: event.runId,
    ordinalSeq: event.seq,
    data: {
      toolCallId,
      messageId: event.payload.messageId ?? null,
      toolName: event.payload.toolName,
      args: structuredClone(event.payload.args)
    }
  };
  state.liveItems[toolCallId] = item;
}

function handleToolUpdated(state: ReducerState, event: Extract<ProtocolEvent, { type: "tool.updated" }>): void {
  const operationId = operationIdOf(event);
  ensureOperationOpen(state, operationId, event.type);
  ensureEnvelopeOwnership(state, operationId, event.runId);
  const item = liveFor(state, event.payload.toolCallId);
  if (item.kind !== "tool") fail(`tool.updated ${event.payload.toolCallId} is not a tool`);
  if (item.operationId !== operationId || item.runId !== event.runId) fail(`tool.updated ownership mismatch`);
  item.data.output = structuredClone(event.payload.output);
}

function handleToolFinished(state: ReducerState, event: Extract<ProtocolEvent, { type: "tool.finished" }>): void {
  const operationId = operationIdOf(event);
  ensureOperationOpen(state, operationId, event.type);
  ensureEnvelopeOwnership(state, operationId, event.runId);
  const item = liveFor(state, event.payload.toolCallId);
  if (item.kind !== "tool") fail(`tool.finished ${event.payload.toolCallId} is not a tool`);
  if (item.operationId !== operationId || item.runId !== event.runId) fail(`tool.finished ownership mismatch`);
  const payload = event.payload;
  const data: ToolData = {
    ...item.data,
    output: structuredClone(payload.output),
    isError: payload.isError,
    ...(payload.exitCode !== undefined ? { exitCode: payload.exitCode } : {}),
    ...(payload.durationMs !== undefined ? { durationMs: payload.durationMs } : {}),
    ...(payload.patch !== undefined ? { patch: structuredClone(payload.patch) } : {}),
    outcome: payload.isError ? "failed" : "succeeded"
  };
  finalizeLiveItem(state, { ...item, data }, event.seq, "complete");
}

function handleInputUpdated(state: ReducerState, event: Extract<ProtocolEvent, { type: "input.updated" }>): void {
  const operationId = operationIdOf(event);
  ensureOperationOpen(state, operationId, event.type);
  ensureEnvelopeOwnership(state, operationId, event.runId);
  const payload = event.payload;
  const existing = state.inputs[payload.inputId];
  if (!existing && payload.content === undefined) fail(`first input.updated for ${payload.inputId} needs content`);
  if (existing && (existing.operationId !== operationId || existing.runId !== event.runId || existing.delivery !== payload.delivery)) {
    fail(`input ${payload.inputId} changed ownership or delivery`);
  }
  if (existing && payload.content !== undefined && JSON.stringify(existing.content) !== JSON.stringify(payload.content)) {
    fail(`input ${payload.inputId} changed content`);
  }
  if (existing && existing.state !== "queued" && existing.state !== payload.state) {
    fail(`input ${payload.inputId} changed after ${existing.state}`);
  }
  const input: InputProjection = existing ?? {
    inputId: payload.inputId,
    operationId,
    runId: event.runId,
    delivery: payload.delivery,
    state: payload.state,
    commandId: payload.commandId ?? null,
    content: structuredClone(payload.content!) as InputProjection["content"],
    updatedSeq: event.seq
  };
  input.state = payload.state;
  input.updatedSeq = event.seq;
  if (payload.commandId !== undefined) input.commandId = payload.commandId;
  if (payload.content !== undefined) input.content = structuredClone(payload.content);
  state.inputs[payload.inputId] = input;
}

function handleInteractionRequested(state: ReducerState, event: Extract<ProtocolEvent, { type: "interaction.requested" }>): void {
  const operationId = operationIdOf(event);
  const operation = ensureOperationOpen(state, operationId, event.type);
  ensureEnvelopeOwnership(state, operationId, event.runId);
  const payload = event.payload;
  if (payload.operationId !== operationId) fail(`interaction ${payload.interactionId} operation mismatch`);
  if (payload.sensitive && (payload.kind !== "input" || payload.prefill !== undefined)) fail("sensitive interactions require input without prefill");
  if (payload.origin !== operation.kind) fail(`interaction ${payload.interactionId} origin does not match operation kind`);
  if (state.interactions[payload.interactionId]) fail(`interaction ${payload.interactionId} already exists`);
  const interaction: InteractionProjection = {
    interactionId: payload.interactionId,
    operationId,
    origin: payload.origin,
    kind: payload.kind,
    title: payload.title,
    ...(payload.sensitive ? { sensitive: true as const } : {}),
    ...(payload.options !== undefined ? { options: structuredClone(payload.options) } : {}),
    ...(payload.message !== undefined ? { message: payload.message } : {}),
    ...(payload.placeholder !== undefined ? { placeholder: payload.placeholder } : {}),
    ...(payload.prefill !== undefined ? { prefill: payload.prefill } : {}),
    ...(payload.expiresAt !== undefined ? { expiresAt: payload.expiresAt } : {}),
    status: "pending",
    runId: event.runId,
    commandId: operation.commandId,
    updatedSeq: event.seq
  };
  state.interactions[payload.interactionId] = interaction;
  state.session.status = "waiting_input";
}

function handleInteractionResolved(state: ReducerState, event: Extract<ProtocolEvent, { type: "interaction.resolved" }>): void {
  const operationId = operationIdOf(event);
  ensureEnvelopeOwnership(state, operationId, event.runId);
  const interaction = state.interactions[event.payload.interactionId];
  if (!interaction) fail(`interaction ${event.payload.interactionId} does not exist`);
  if (interaction.operationId !== operationId || interaction.runId !== event.runId) fail(`interaction resolution ownership mismatch`);
  if (interaction.status !== "pending") fail(`interaction ${interaction.interactionId} was already ${interaction.status}`);
  if (interaction.sensitive && (event.payload.response !== undefined || (event.payload.status === "resolved" && !event.payload.redacted))) {
    fail("sensitive interaction resolution must be redacted");
  }
  if (!interaction.sensitive && event.payload.redacted) fail("ordinary interaction cannot have a redacted response");
  if (!interaction.sensitive && event.payload.status === "resolved" && event.payload.response === undefined) {
    fail(`resolved interaction ${interaction.interactionId} needs a response`);
  }
  interaction.status = event.payload.status;
  interaction.response = event.payload.response;
  interaction.reason = event.payload.reason;
  interaction.updatedSeq = event.seq;
  if (state.session.status === "waiting_input") state.session.status = "busy";
}

function handleQueueUpdated(state: ReducerState, event: Extract<ProtocolEvent, { type: "queue.updated" }>): void {
  const payload = event.payload;
  if (payload.version <= state.queue.version) fail(`queue version ${payload.version} is not newer than ${state.queue.version}`);
  const positions = payload.items.map((item) => item.position);
  if (new Set(positions).size !== positions.length || positions.some((position, index) => position !== index)) {
    fail("queue positions must be unique and contiguous from zero");
  }
  const refs = payload.items.map((item) => `${item.commandId}:${item.runId}`);
  if (new Set(refs).size !== refs.length) fail("queue contains duplicate command/run references");
  state.queue = {
    state: payload.state,
    version: payload.version,
    pause: structuredClone(payload.pause),
    items: structuredClone(payload.items)
  };
  refreshQueueProjection(state);
}

function handleSessionUpdated(state: ReducerState, event: Extract<ProtocolEvent, { type: "session.updated" }>): void {
  const changes = event.payload.changes;
  if (changes.version !== undefined && changes.version <= state.session.version) {
    fail(`session version ${changes.version} is not newer than ${state.session.version}`);
  }
  if (changes.title !== undefined) state.session.title = changes.title;
  if (changes.version !== undefined) state.session.version = changes.version;
  if (changes.model !== undefined) state.session.model = structuredClone(changes.model);
  if (changes.thinkingLevel !== undefined) state.session.thinkingLevel = changes.thinkingLevel;
  if (changes.archived !== undefined) {
    if (changes.archived) {
      state.session.archivedAt = changes.archivedAt ?? event.timestamp;
    } else {
      state.session.archivedAt = null;
    }
  }
  if (changes.archivedAt !== undefined) state.session.archivedAt = changes.archivedAt;
  if (changes.actualConfig !== undefined) state.session.actualConfig = structuredClone(changes.actualConfig);
  if (changes.title !== undefined || changes.version !== undefined) {
    const pending = state.metadataSync.pendingTitle;
    const isEcho = pending !== null &&
      pending.value === state.session.title &&
      pending.version === state.session.version;
    state.metadataSync.title = {
      value: state.session.title,
      version: state.session.version,
      source: isEcho ? pending.source : "unknown",
      eventSeq: event.seq
    };
    if (isEcho) {
      state.metadataSync.pendingTitle = null;
      state.metadataSync.lastEchoSeq = event.seq;
    }
  }
}

function handleContentSealed(state: ReducerState, event: Extract<ProtocolEvent, { type: "run.content_sealed" }>): void {
  const operationId = operationIdOf(event);
  const runId = runIdOf(event);
  const run = ensureRunOpen(state, runId, event.type);
  if (run.operationId !== operationId) fail(`run content seal operation mismatch`);
  sealItems(state, (item) => item.runId === runId, event.seq, event.payload.reason);
  run.contentSealed = true;
}

function handleOperationContentSealed(state: ReducerState, event: Extract<ProtocolEvent, { type: "operation.content_sealed" }>): void {
  const operationId = operationIdOf(event);
  ensureOperationOpen(state, operationId, event.type);
  sealItems(state, (item) => item.operationId === operationId && item.runId === null, event.seq, event.payload.reason);
}

function handleRuntimeNotice(state: ReducerState, event: Extract<ProtocolEvent, { type: "runtime.notice" }>): void {
  state.notices.push({
    seq: event.seq,
    kind: event.payload.kind,
    message: event.payload.message,
    ...(event.payload.details !== undefined ? { details: structuredClone(event.payload.details) } : {})
  });
}

function reduceParsedEvent(state: ReducerState, event: ProtocolEvent): void {
  switch (event.type) {
    case "command.updated":
      handleCommandUpdated(state, event);
      break;
    case "operation.updated":
      handleOperationUpdated(state, event);
      break;
    case "run.updated":
      handleRunUpdated(state, event);
      break;
    case "run.content_sealed":
      handleContentSealed(state, event);
      break;
    case "operation.content_sealed":
      handleOperationContentSealed(state, event);
      break;
    case "input.updated":
      handleInputUpdated(state, event);
      break;
    case "message.started":
      handleMessageStartedWithId(state, event);
      break;
    case "content.started":
      handleContentStarted(state, event);
      break;
    case "content.delta":
      handleContentDelta(state, event);
      break;
    case "content.ended":
      handleContentEnded(state, event);
      break;
    case "message.completed":
      handleMessageCompleted(state, event);
      break;
    case "tool.started":
      handleToolStarted(state, event);
      break;
    case "tool.updated":
      handleToolUpdated(state, event);
      break;
    case "tool.finished":
      handleToolFinished(state, event);
      break;
    case "interaction.requested":
      handleInteractionRequested(state, event);
      break;
    case "interaction.resolved":
      handleInteractionResolved(state, event);
      break;
    case "queue.updated":
      handleQueueUpdated(state, event);
      break;
    case "session.updated":
      handleSessionUpdated(state, event);
      break;
    case "runtime.notice":
      handleRuntimeNotice(state, event);
      break;
  }
}

/** Apply one validated event without mutating the caller's state. */
function applyEvent(state: ReducerState, input: unknown, copy: boolean): ReducerState {
  const event = parseProtocolEvent(input);
  if (event.sessionId !== state.sessionId) {
    throw new ReducerError("SESSION_MISMATCH", `event belongs to ${event.sessionId}, reducer belongs to ${state.sessionId}`);
  }
  const eventSignature = signature(event);
  if (event.seq <= state.lastSeq) {
    if (state.eventSignatures[String(event.seq)] === eventSignature) return state;
    throw new DuplicateEventConflictError(event.seq);
  }
  if (event.seq !== state.lastSeq + 1) throw new EventGapError(state.lastSeq + 1, event.seq);
  const next = copy ? cloneState(state) : state;
  reduceParsedEvent(next, event);
  next.lastSeq = event.seq;
  next.eventSignatures[String(event.seq)] = eventSignature;
  next.session.lastActivityAt = event.timestamp;
  refreshQueueProjection(next);
  refreshSessionStatus(next);
  return next;
}

export function reduceEvent(state: ReducerState, input: unknown): ReducerState {
  return applyEvent(state, input, true);
}

/** Validate and reduce a batch atomically with one copy of mutable projections. */
export function reduceEvents(state: ReducerState, events: readonly unknown[]): ReducerState {
  let next = state;
  for (const event of events) {
    // Duplicate prefixes retain the original reference; copy on the first new event.
    next = applyEvent(next, event, next === state);
  }
  return next;
}

export function replayEvents(
  sessionId: string,
  events: readonly unknown[],
  options: Parameters<typeof createInitialState>[1] = {}
): ReducerState {
  return reduceEvents(createInitialState(sessionId, options), events);
}

export function validateEventStream(events: readonly unknown[], sessionId?: string): void {
  if (events.length === 0) return;
  const parsed = events.map(parseProtocolEvent);
  const targetSessionId = sessionId ?? parsed[0]!.sessionId;
  reduceEvents(createInitialState(targetSessionId), parsed);
}
