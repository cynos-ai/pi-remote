import { z } from "zod";
import {
  contentBlockSchema,
  customMessageSchema,
  terminalRendererProjectionSchema,
  type ContentBlock,
  type CustomMessage,
  type TerminalRendererProjection,
  type BashMessage,
  bashMessageSchema,
  toolOutputSnapshotSchema,
  type ToolOutputSnapshot,
  interactionKindSchema,
  interactionOriginSchema,
  interactionResolutionStatusSchema,
  operationKindSchema,
  operationStatusSchema,
  queueItemSchema,
  queuePauseSchema,
  queueStateSchema,
  runKindSchema,
  runSourceSchema,
  runStatusSchema,
  type InteractionKind,
  type InteractionOrigin,
  type InteractionResolutionStatus,
  type OperationKind,
  type OperationStatus,
  type QueueItem,
  type QueuePause,
  type QueueState,
  type RunKind,
  type RunSource,
  type RunStatus
} from "./events.js";
import {
  commandKindSchema,
  commandRunRefSchema,
  commandStateSchema,
  inputContentSchema,
  interactionResponseSchema,
  type CommandKind,
  type CommandRunRef,
  type CommandState,
  type InputContent,
  type InteractionResponse
} from "./commands.js";
import {
  idSchema,
  jsonObjectSchema,
  modelRefSchema,
  nonNegativeIntSchema,
  positiveIntSchema,
  runtimeErrorSchema,
  timestampSchema
} from "./common.js";

export const sessionStatusSchema = z.enum([
  "idle",
  "queued",
  "running",
  "waiting_input",
  "busy",
  "interrupted",
  "failed"
]);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

export const piPersistenceStateSchema = z.enum(["uninitialized", "unflushed", "persisted"]);
export type PiPersistenceState = z.infer<typeof piPersistenceStateSchema>;

export interface SessionProjection {
  id: string;
  projectId: string;
  title: string;
  version: number;
  status: SessionStatus;
  phase: string | null;
  activeRunId: string | null;
  queuedCount: number;
  queueState: QueueState;
  queueVersion: number;
  queuePause: QueuePause | null;
  piPersistenceState: PiPersistenceState;
  model: { provider: string; id: string } | null;
  thinkingLevel: string | null;
  historyErrorCode: string | null;
  lastActivityAt: string | null;
  lastMessagePreview: string | null;
  archivedAt: string | null;
  actualConfig?: Record<string, unknown>;
}

export interface OperationProjection {
  operationId: string;
  kind: OperationKind;
  status: OperationStatus;
  parentOperationId: string | null;
  commandId: string | null;
  runId: string | null;
  startedSeq: number;
  updatedSeq: number;
  error?: z.infer<typeof runtimeErrorSchema>;
}

export interface RunProjection {
  runId: string;
  operationId: string;
  kind: RunKind;
  status: RunStatus;
  phase: string | null;
  source: RunSource;
  commandId: string | null;
  startedSeq: number;
  updatedSeq: number;
  contentSealed: boolean;
  error?: z.infer<typeof runtimeErrorSchema>;
}

export interface CommandProjection {
  commandId: string;
  kind: CommandKind;
  state: CommandState;
  targetRunId: string | null;
  runs: CommandRunRef[];
  error?: z.infer<typeof runtimeErrorSchema>;
  result?: Record<string, unknown>;
}

export interface InteractionProjection {
  interactionId: string;
  operationId: string;
  origin: InteractionOrigin;
  kind: InteractionKind;
  title: string;
  options?: Array<{ value: string; label: string }>;
  message?: string;
  placeholder?: string;
  prefill?: string;
  sensitive?: true;
  expiresAt?: string;
  status: "pending" | InteractionResolutionStatus;
  response?: InteractionResponse;
  reason?: string;
  runId: string | null;
  commandId: string | null;
  updatedSeq: number;
}

export interface InputProjection {
  inputId: string;
  operationId: string;
  runId: string | null;
  delivery: "steer" | "followUp";
  state: "queued" | "consumed" | "returned" | "unknown";
  commandId: string | null;
  content: InputContent;
  updatedSeq: number;
}

export interface MessageData {
  messageId: string;
  role: "user" | "assistant" | "custom" | "bash";
  blocks: Array<ContentBlock | PartialToolCallData>;
  custom?: CustomMessage;
  bash?: BashMessage;
  stopReason?: string;
  usage?: Record<string, unknown>;
}

export interface PartialToolCallData {
  id: string;
  index: number;
  kind: "tool_call";
  toolCallId: string;
  toolName: string;
  argumentsText: string;
  argumentsIncomplete: true;
}

export interface ToolData {
  toolCallId: string;
  messageId: string | null;
  toolName: string;
  args: Record<string, unknown>;
  output?: ToolOutputSnapshot;
  isError?: boolean;
  exitCode?: number;
  durationMs?: number;
  patch?: unknown;
  outcome?: "succeeded" | "failed" | "unknown";
}

export interface CustomEntryData {
  entryId: string;
  type: string;
  renderer: TerminalRendererProjection;
}

export type TimelineItemData = MessageData | ToolData | CustomEntryData;

export interface LiveMessageItem {
  itemId: string;
  kind: "message";
  operationId: string;
  runId: string | null;
  ordinalSeq: number;
  data: MessageData;
}

export interface LiveToolItem {
  itemId: string;
  kind: "tool";
  operationId: string;
  runId: string | null;
  ordinalSeq: number;
  data: ToolData;
}

export type LiveItem = LiveMessageItem | LiveToolItem;

export interface CustomEntryTimelineItem {
  itemId: string;
  kind: "custom_entry";
  operationId: string;
  runId: string | null;
  ordinalSeq: number;
  finalizedSeq: number;
  completeness: "complete";
  data: CustomEntryData;
}

export type TimelineItem = ((LiveMessageItem | LiveToolItem) & {
  finalizedSeq: number;
  completeness: "complete" | "partial";
  endReason?: "failed" | "aborted" | "interrupted";
}) | CustomEntryTimelineItem;

export interface QueueProjection {
  state: QueueState;
  version: number;
  pause: QueuePause | null;
  items: QueueItem[];
}

/** Internal durable metadata watermarks; it is not part of the public Snapshot DTO. */
export const metadataSyncProjectionSchema = z.object({
  title: z.object({
    value: z.string().max(120),
    version: nonNegativeIntSchema,
    source: z.enum(["unknown", "mobile", "pi", "server"]),
    eventSeq: nonNegativeIntSchema
  }).strict(),
  pendingTitle: z.object({
    intentId: idSchema,
    value: z.string().max(120),
    version: nonNegativeIntSchema,
    source: z.enum(["mobile", "pi", "server"]),
    requestedSeq: nonNegativeIntSchema
  }).strict().nullable(),
  lastEchoSeq: nonNegativeIntSchema.nullable()
}).strict();
export type MetadataSyncProjection = z.infer<typeof metadataSyncProjectionSchema>;

export interface ReducerState {
  schemaVersion: 1;
  sessionId: string;
  lastSeq: number;
  session: SessionProjection;
  operations: Record<string, OperationProjection>;
  runs: Record<string, RunProjection>;
  commands: Record<string, CommandProjection>;
  interactions: Record<string, InteractionProjection>;
  inputs: Record<string, InputProjection>;
  liveItems: Record<string, LiveItem>;
  timelineItems: TimelineItem[];
  queue: QueueProjection;
  metadataSync: MetadataSyncProjection;
  notices: Array<{ seq: number; kind: string; message: string; details?: Record<string, unknown> }>;
  eventSignatures: Record<string, string>;
}

export interface Snapshot {
  /** Persisted runtime/extension UI state, including events missed while offline. */
  notices?: ReducerState["notices"];
  session: SessionProjection;
  snapshotSeq: number;
  activeRun: RunProjection | null;
  activeOperations: OperationProjection[];
  pendingInputs: InputProjection[];
  recoveredInputs: InputProjection[];
  queue: QueueProjection;
  pendingInteractions: InteractionProjection[];
  items: TimelineItem[];
  liveItems: LiveItem[];
  historyCursor: string | null;
  availableThinkingLevels: string[];
  allowedCommands: CommandKind[];
}

const partialToolCallDataSchema = z
  .object({
    id: idSchema,
    index: nonNegativeIntSchema,
    kind: z.literal("tool_call"),
    toolCallId: idSchema,
    toolName: idSchema,
    argumentsText: z.string(),
    argumentsIncomplete: z.literal(true)
  })
  .strict();

const stateMessageDataSchema = z
  .object({
    messageId: idSchema,
    role: z.enum(["user", "assistant", "custom", "bash"]),
    blocks: z.array(z.union([contentBlockSchema, partialToolCallDataSchema])),
    custom: customMessageSchema.optional(),
    bash: bashMessageSchema.optional(),
    stopReason: z.string().max(120).optional(),
    usage: jsonObjectSchema.optional()
  })
  .passthrough();

export const toolDataSchema = z
  .object({
    toolCallId: idSchema,
    messageId: idSchema.nullable(),
    toolName: idSchema,
    args: jsonObjectSchema,
    output: toolOutputSnapshotSchema.optional(),
    isError: z.boolean().optional(),
    exitCode: z.number().int().optional(),
    durationMs: nonNegativeIntSchema.optional(),
    patch: z.unknown().optional(),
    outcome: z.enum(["succeeded", "failed", "unknown"]).optional()
  })
  .passthrough();

export const customEntryDataSchema = z
  .object({
    entryId: idSchema,
    type: z.string().min(1).max(160),
    renderer: terminalRendererProjectionSchema
  })
  .strict();

const liveItemSchema = z.discriminatedUnion("kind", [
  z.object({ itemId: idSchema, kind: z.literal("message"), operationId: idSchema, runId: idSchema.nullable(), ordinalSeq: positiveIntSchema, data: stateMessageDataSchema }).strict(),
  z.object({ itemId: idSchema, kind: z.literal("tool"), operationId: idSchema, runId: idSchema.nullable(), ordinalSeq: positiveIntSchema, data: toolDataSchema }).strict()
]);

// `kind` is not sufficient to discriminate complete vs partial items; both
// message and tool items can have either completeness state.
export const timelineItemSchema = z.union([
  z.object({
    itemId: idSchema,
    kind: z.literal("message"),
    operationId: idSchema,
    runId: idSchema.nullable(),
    ordinalSeq: positiveIntSchema,
    finalizedSeq: positiveIntSchema,
    completeness: z.literal("complete"),
    data: stateMessageDataSchema
  }).strict(),
  z.object({
    itemId: idSchema,
    kind: z.literal("message"),
    operationId: idSchema,
    runId: idSchema.nullable(),
    ordinalSeq: positiveIntSchema,
    finalizedSeq: positiveIntSchema,
    completeness: z.literal("partial"),
    endReason: z.enum(["failed", "aborted", "interrupted"]),
    data: stateMessageDataSchema
  }).strict(),
  z.object({
    itemId: idSchema,
    kind: z.literal("tool"),
    operationId: idSchema,
    runId: idSchema.nullable(),
    ordinalSeq: positiveIntSchema,
    finalizedSeq: positiveIntSchema,
    completeness: z.literal("complete"),
    data: toolDataSchema
  }).strict(),
  z.object({
    itemId: idSchema,
    kind: z.literal("tool"),
    operationId: idSchema,
    runId: idSchema.nullable(),
    ordinalSeq: positiveIntSchema,
    finalizedSeq: positiveIntSchema,
    completeness: z.literal("partial"),
    endReason: z.enum(["failed", "aborted", "interrupted"]),
    data: toolDataSchema
  }).strict(),
  z.object({
    itemId: idSchema,
    kind: z.literal("custom_entry"),
    operationId: idSchema,
    runId: idSchema.nullable(),
    ordinalSeq: positiveIntSchema,
    finalizedSeq: positiveIntSchema,
    completeness: z.literal("complete"),
    data: customEntryDataSchema
  }).strict()
]);

export const sessionProjectionSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  title: z.string().max(120),
  version: nonNegativeIntSchema,
  status: sessionStatusSchema,
  phase: z.string().max(120).nullable(),
  activeRunId: idSchema.nullable(),
  queuedCount: nonNegativeIntSchema,
  queueState: queueStateSchema,
  queueVersion: nonNegativeIntSchema,
  queuePause: queuePauseSchema.nullable(),
  piPersistenceState: piPersistenceStateSchema,
  model: modelRefSchema.nullable(),
  thinkingLevel: z.string().max(64).nullable(),
  historyErrorCode: z.string().max(120).nullable(),
  lastActivityAt: timestampSchema.nullable(),
  lastMessagePreview: z.string().nullable(),
  archivedAt: timestampSchema.nullable(),
  actualConfig: jsonObjectSchema.optional()
}).strict();

export const operationProjectionSchema = z.object({
  operationId: idSchema,
  kind: operationKindSchema,
  status: operationStatusSchema,
  parentOperationId: idSchema.nullable(),
  commandId: idSchema.nullable(),
  runId: idSchema.nullable(),
  startedSeq: positiveIntSchema,
  updatedSeq: positiveIntSchema,
  error: runtimeErrorSchema.optional()
}).strict();

export const runProjectionSchema = z.object({
  runId: idSchema,
  operationId: idSchema,
  kind: runKindSchema,
  status: runStatusSchema,
  phase: z.string().max(120).nullable(),
  source: runSourceSchema,
  commandId: idSchema.nullable(),
  startedSeq: positiveIntSchema,
  updatedSeq: positiveIntSchema,
  contentSealed: z.boolean(),
  error: runtimeErrorSchema.optional()
}).strict();

export const commandProjectionSchema = z.object({
  commandId: idSchema,
  kind: commandKindSchema,
  state: commandStateSchema,
  targetRunId: idSchema.nullable(),
  runs: z.array(commandRunRefSchema),
  error: runtimeErrorSchema.optional(),
  result: jsonObjectSchema.optional()
}).strict();

export const interactionProjectionSchema = z.object({
  interactionId: idSchema,
  operationId: idSchema,
  origin: interactionOriginSchema,
  kind: interactionKindSchema,
  title: z.string().min(1).max(120),
  options: z.array(z.object({ value: z.string(), label: z.string() }).strict()).optional(),
  message: z.string().optional(),
  placeholder: z.string().optional(),
  prefill: z.string().optional(),
  sensitive: z.literal(true).optional(),
  expiresAt: timestampSchema.optional(),
  status: z.union([z.literal("pending"), interactionResolutionStatusSchema]),
  response: interactionResponseSchema.optional(),
  reason: z.string().optional(),
  runId: idSchema.nullable(),
  commandId: idSchema.nullable(),
  updatedSeq: positiveIntSchema
}).strict().refine(value => !value.sensitive || (value.kind === "input" && value.prefill === undefined && value.response === undefined), "Sensitive snapshot cannot contain an answer or prefill");

export const inputProjectionSchema = z.object({
  inputId: idSchema,
  operationId: idSchema,
  runId: idSchema.nullable(),
  delivery: z.enum(["steer", "followUp"]),
  state: z.enum(["queued", "consumed", "returned", "unknown"]),
  commandId: idSchema.nullable(),
  content: inputContentSchema,
  updatedSeq: positiveIntSchema
}).strict();

export const queueProjectionSchema = z.object({
  state: queueStateSchema,
  version: nonNegativeIntSchema,
  pause: queuePauseSchema.nullable(),
  items: z.array(queueItemSchema)
}).strict();

export const snapshotSchema = z.object({
  notices: z.array(z.object({ seq: positiveIntSchema, kind: z.string(), message: z.string(), details: jsonObjectSchema.optional() }).strict()).default([]),
  session: sessionProjectionSchema,
  snapshotSeq: nonNegativeIntSchema,
  activeRun: runProjectionSchema.nullable(),
  activeOperations: z.array(operationProjectionSchema),
  pendingInputs: z.array(inputProjectionSchema),
  recoveredInputs: z.array(inputProjectionSchema),
  queue: queueProjectionSchema,
  pendingInteractions: z.array(interactionProjectionSchema),
  items: z.array(timelineItemSchema).max(50),
  liveItems: z.array(liveItemSchema),
  historyCursor: z.string().nullable(),
  availableThinkingLevels: z.array(z.string()),
  allowedCommands: z.array(commandKindSchema)
}).strict();

export function createInitialState(
  sessionId: string,
  options: Partial<Pick<SessionProjection, "projectId" | "title" | "version" | "model" | "thinkingLevel" | "piPersistenceState">> = {}
): ReducerState {
  const session: SessionProjection = {
    id: sessionId,
    projectId: options.projectId ?? "unassigned-project",
    title: options.title ?? "新会话",
    version: options.version ?? 0,
    status: "idle",
    phase: null,
    activeRunId: null,
    queuedCount: 0,
    queueState: "ready",
    queueVersion: 0,
    queuePause: null,
    piPersistenceState: options.piPersistenceState ?? "uninitialized",
    model: options.model ?? null,
    thinkingLevel: options.thinkingLevel ?? null,
    historyErrorCode: null,
    lastActivityAt: null,
    lastMessagePreview: null,
    archivedAt: null
  };
  return {
    schemaVersion: 1,
    sessionId,
    lastSeq: 0,
    session,
    operations: {},
    runs: {},
    commands: {},
    interactions: {},
    inputs: {},
    liveItems: {},
    timelineItems: [],
    queue: { state: "ready", version: 0, pause: null, items: [] },
    metadataSync: {
      title: {
        value: session.title,
        version: session.version,
        source: "server",
        eventSeq: 0
      },
      pendingTitle: null,
      lastEchoSeq: null
    },
    notices: [],
    eventSignatures: {}
  };
}

export function toSnapshot(
  state: ReducerState,
  options: Pick<Snapshot, "historyCursor" | "availableThinkingLevels" | "allowedCommands"> = {
    historyCursor: null,
    availableThinkingLevels: [],
    allowedCommands: ["prompt", "follow_up"]
  }
): Snapshot {
  // Queued follow-ups are listed separately below; activeRun is the Run that
  // is actually executing in the Session's SDK worker.
  const activeRun = Object.values(state.runs).find((run) =>
    run.status === "running" || run.status === "stopping"
  ) ?? null;
  const activeOperations = Object.values(state.operations).filter((operation) =>
    operation.status === "running" || operation.status === "waiting_input"
  );
  const pendingInputs = Object.values(state.inputs).filter((input) => input.state === "queued");
  const recoveredInputs = Object.values(state.inputs).filter((input) => input.state === "returned" || input.state === "unknown");
  const pendingInteractions = Object.values(state.interactions).filter((interaction) => interaction.status === "pending");
  return {
    session: structuredClone(state.session),
    snapshotSeq: state.lastSeq,
    notices: structuredClone(state.notices),
    activeRun: activeRun ? structuredClone(activeRun) : null,
    activeOperations: structuredClone(activeOperations),
    pendingInputs: structuredClone(pendingInputs),
    recoveredInputs: structuredClone(recoveredInputs),
    queue: structuredClone(state.queue),
    pendingInteractions: structuredClone(pendingInteractions),
    items: structuredClone(state.timelineItems.slice(-50)),
    liveItems: structuredClone(Object.values(state.liveItems)),
    historyCursor: options.historyCursor,
    availableThinkingLevels: [...options.availableThinkingLevels],
    allowedCommands: [...options.allowedCommands]
  };
}
