import { z } from "zod";
import {
  boundedTextSchema,
  idSchema,
  jsonObjectSchema,
  jsonValueSchema,
  modelRefSchema,
  nonNegativeIntSchema,
  positiveIntSchema,
  runtimeErrorSchema,
  protocolVersionSchema,
  timestampSchema
} from "./common.js";
import {
  commandKindSchema,
  commandRunRefSchema,
  commandStateSchema,
  interactionResponseSchema,
  inputContentSchema
} from "./commands.js";

export const contentKindSchema = z.enum(["text", "thinking", "tool_call"]);
export type ContentKind = z.infer<typeof contentKindSchema>;

const contentIdentity = {
  id: idSchema,
  index: nonNegativeIntSchema
};

const contentStartedIdentity = {
  blockId: idSchema,
  index: nonNegativeIntSchema
};

export const textBlockSchema = z
  .object({
    ...contentIdentity,
    kind: z.literal("text"),
    text: z.string(),
    truncated: z.boolean().optional(),
    artifactId: idSchema.optional()
  })
  .strict();
export const thinkingBlockSchema = z
  .object({
    ...contentIdentity,
    kind: z.literal("thinking"),
    text: z.string(),
    redacted: z.boolean().optional(),
    truncated: z.boolean().optional(),
    artifactId: idSchema.optional()
  })
  .strict();
export const toolCallBlockSchema = z
  .object({
    ...contentIdentity,
    kind: z.literal("tool_call"),
    toolCallId: idSchema,
    toolName: idSchema,
    arguments: jsonObjectSchema,
    truncated: z.boolean().optional(),
    artifactId: idSchema.optional()
  })
  .strict();
export const contentBlockSchema = z.discriminatedUnion("kind", [
  textBlockSchema,
  thinkingBlockSchema,
  toolCallBlockSchema
]);
export type TextBlock = z.infer<typeof textBlockSchema>;
export type ThinkingBlock = z.infer<typeof thinkingBlockSchema>;
export type ToolCallBlock = z.infer<typeof toolCallBlockSchema>;
export type ContentBlock = z.infer<typeof contentBlockSchema>;

export const partialToolCallBlockSchema = z
  .object({
    ...contentIdentity,
    kind: z.literal("tool_call"),
    toolCallId: idSchema,
    toolName: idSchema,
    argumentsText: z.string(),
    argumentsIncomplete: z.literal(true)
  })
  .strict();
export type PartialToolCallBlock = z.infer<typeof partialToolCallBlockSchema>;
export const liveContentBlockSchema = z.union([contentBlockSchema, partialToolCallBlockSchema]);
export type LiveContentBlock = z.infer<typeof liveContentBlockSchema>;

export const terminalRendererProjectionSchema = z
  .object({
    lines: z.array(z.string().max(32768)).max(256),
    expanded: z.boolean(),
    width: z.literal(80),
    truncated: z.boolean().optional(),
    failed: z.boolean().optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.lines.reduce((total, line) => total + line.length, 0) > 32768) {
      context.addIssue({ code: "custom", path: ["lines"], message: "renderer text exceeds 32768 characters" });
    }
  });
export type TerminalRendererProjection = z.infer<typeof terminalRendererProjectionSchema>;

export const customMessageSchema = z
  .object({
    type: z.string().min(1).max(160),
    display: z.boolean(),
    details: jsonObjectSchema.optional(),
    renderer: terminalRendererProjectionSchema.optional()
  })
  .strict();
export type CustomMessage = z.infer<typeof customMessageSchema>;

export const customEntryAppendedPayloadSchema = z
  .object({
    entryId: idSchema,
    type: z.string().min(1).max(160),
    renderer: terminalRendererProjectionSchema
  })
  .strict();
export type CustomEntryAppendedPayload = z.infer<typeof customEntryAppendedPayloadSchema>;

export const bashOutcomeSchema = z.enum(["running", "succeeded", "failed", "aborted", "unknown"]);
export const bashMessageSchema = z
  .object({
    command: boundedTextSchema,
    excludeFromContext: z.boolean(),
    outcome: bashOutcomeSchema,
    exitCode: z.number().int().optional(),
    cancelled: z.boolean().optional(),
    truncated: z.boolean().optional(),
    artifactId: idSchema.optional()
  })
  .strict();
export type BashMessage = z.infer<typeof bashMessageSchema>;

const userMessageStartedSchema = z.object({ messageId: idSchema, role: z.literal("user") }).strict();
const assistantMessageStartedSchema = z.object({ messageId: idSchema, role: z.literal("assistant") }).strict();
const customMessageStartedSchema = z
  .object({ messageId: idSchema, role: z.literal("custom"), custom: customMessageSchema })
  .strict();
const bashMessageStartedSchema = z
  .object({ messageId: idSchema, role: z.literal("bash"), bash: bashMessageSchema })
  .strict();
export const messageStartedPayloadSchema = z.discriminatedUnion("role", [
  userMessageStartedSchema,
  assistantMessageStartedSchema,
  customMessageStartedSchema,
  bashMessageStartedSchema
]);
export type MessageStartedPayload = z.infer<typeof messageStartedPayloadSchema>;

const usageSchema = z
  .object({
    inputTokens: nonNegativeIntSchema.optional(),
    outputTokens: nonNegativeIntSchema.optional(),
    cacheReadTokens: nonNegativeIntSchema.optional(),
    cacheWriteTokens: nonNegativeIntSchema.optional(),
    totalTokens: nonNegativeIntSchema.optional()
  })
  .passthrough();

const userMessageCompletedSchema = z
  .object({ messageId: idSchema, role: z.literal("user"), blocks: z.array(contentBlockSchema) })
  .strict();
const assistantMessageCompletedSchema = z
  .object({
    messageId: idSchema,
    role: z.literal("assistant"),
    blocks: z.array(contentBlockSchema),
    stopReason: z.string().max(120).optional(),
    usage: usageSchema.optional()
  })
  .strict();
const customMessageCompletedSchema = z
  .object({ messageId: idSchema, role: z.literal("custom"), blocks: z.array(contentBlockSchema), custom: customMessageSchema })
  .strict();
const bashMessageCompletedSchema = z
  .object({ messageId: idSchema, role: z.literal("bash"), blocks: z.array(contentBlockSchema), bash: bashMessageSchema })
  .strict();
export const messageCompletedPayloadSchema = z.discriminatedUnion("role", [
  userMessageCompletedSchema,
  assistantMessageCompletedSchema,
  customMessageCompletedSchema,
  bashMessageCompletedSchema
]);
export type MessageCompletedPayload = z.infer<typeof messageCompletedPayloadSchema>;

const textContentStartedSchema = z
  .object({ messageId: idSchema, ...contentStartedIdentity, kind: z.literal("text") })
  .strict();
const thinkingContentStartedSchema = z
  .object({ messageId: idSchema, ...contentStartedIdentity, kind: z.literal("thinking") })
  .strict();
const toolCallContentStartedSchema = z
  .object({
    messageId: idSchema,
    ...contentStartedIdentity,
    kind: z.literal("tool_call"),
    toolCallId: idSchema,
    toolName: idSchema
  })
  .strict();
export const contentStartedPayloadSchema = z.discriminatedUnion("kind", [
  textContentStartedSchema,
  thinkingContentStartedSchema,
  toolCallContentStartedSchema
]);
export type ContentStartedPayload = z.infer<typeof contentStartedPayloadSchema>;

export const contentDeltaPayloadSchema = z
  .object({
    messageId: idSchema,
    blockId: idSchema,
    delta: z.string(),
    truncated: z.boolean().optional()
  })
  .strict();

export const contentEndedPayloadSchema = z
  .object({
    messageId: idSchema,
    block: contentBlockSchema
  })
  .strict();

export const toolOutputSnapshotSchema = z
  .object({
    text: z.string(),
    truncated: z.boolean(),
    artifactId: idSchema.optional()
  })
  .strict();
export type ToolOutputSnapshot = z.infer<typeof toolOutputSnapshotSchema>;

export const toolStartedPayloadSchema = z
  .object({
    toolCallId: idSchema,
    messageId: idSchema.optional(),
    toolName: idSchema,
    args: jsonObjectSchema,
    argsTruncated: z.boolean().optional(),
    artifactId: idSchema.optional()
  })
  .strict();

export const toolUpdatedPayloadSchema = z
  .object({
    toolCallId: idSchema,
    output: toolOutputSnapshotSchema
  })
  .strict();

export const toolFinishedPayloadSchema = z
  .object({
    toolCallId: idSchema,
    output: toolOutputSnapshotSchema,
    isError: z.boolean(),
    exitCode: z.number().int().optional(),
    durationMs: nonNegativeIntSchema.optional(),
    patch: jsonValueSchema.optional()
  })
  .strict();

export const operationKindSchema = z.enum(["initialize", "configure", "run", "bash", "extension"]);
export type OperationKind = z.infer<typeof operationKindSchema>;
export const operationStatusSchema = z.enum([
  "running",
  "waiting_input",
  "completed",
  "failed",
  "interrupted",
  "cancelled"
]);
export type OperationStatus = z.infer<typeof operationStatusSchema>;

export const operationUpdatedPayloadSchema = z
  .object({
    operationId: idSchema,
    kind: operationKindSchema,
    status: operationStatusSchema,
    parentOperationId: idSchema.optional(),
    commandId: idSchema.optional(),
    runId: idSchema.optional(),
    error: runtimeErrorSchema.optional()
  })
  .strict();

export const runKindSchema = z.enum(["prompt", "compact"]);
export type RunKind = z.infer<typeof runKindSchema>;
export const runStatusSchema = z.enum([
  "queued",
  "running",
  "stopping",
  "completed",
  "failed",
  "aborted",
  "interrupted",
  "cancelled"
]);
export type RunStatus = z.infer<typeof runStatusSchema>;
export const runSourceSchema = z.enum(["command", "extension", "runtime"]);
export type RunSource = z.infer<typeof runSourceSchema>;

export const runUpdatedPayloadSchema = z
  .object({
    kind: runKindSchema,
    status: runStatusSchema,
    phase: z.string().max(120).nullable(),
    source: runSourceSchema.optional(),
    commandId: idSchema.optional(),
    error: runtimeErrorSchema.optional()
  })
  .strict();

export const contentSealedReasonSchema = z.enum(["failed", "aborted", "interrupted"]);
export type ContentSealedReason = z.infer<typeof contentSealedReasonSchema>;
export const contentSealedPayloadSchema = z.object({ reason: contentSealedReasonSchema }).strict();

export const inputDeliverySchema = z.enum(["steer", "followUp"]);
export type InputDelivery = z.infer<typeof inputDeliverySchema>;
export const inputStateSchema = z.enum(["queued", "consumed", "returned", "unknown"]);
export type InputState = z.infer<typeof inputStateSchema>;
export const inputUpdatedPayloadSchema = z
  .object({
    inputId: idSchema,
    delivery: inputDeliverySchema,
    state: inputStateSchema,
    commandId: idSchema.optional(),
    content: inputContentSchema.optional()
  })
  .strict();

export const interactionOriginSchema = operationKindSchema;
export type InteractionOrigin = z.infer<typeof interactionOriginSchema>;
export const interactionKindSchema = z.enum(["select", "confirm", "input", "editor", "image"]);
export type InteractionKind = z.infer<typeof interactionKindSchema>;
export const interactionOptionSchema = z
  .object({
    value: z.string().min(1).max(32768),
    label: z.string().min(1).max(32768)
  })
  .strict();
export const interactionRequestedPayloadSchema = z
  .object({
    interactionId: idSchema,
    operationId: idSchema,
    origin: interactionOriginSchema,
    kind: interactionKindSchema,
    title: z.string().min(1).max(120),
    options: z.array(interactionOptionSchema).max(256).optional(),
    message: boundedTextSchema.optional(),
    placeholder: z.string().max(32768).optional(),
    prefill: z.string().max(32768).optional(),
    sensitive: z.literal(true).optional(),
    expiresAt: timestampSchema.optional()
  })
  .strict()
  .refine(value => !value.sensitive || (value.kind === "input" && value.prefill === undefined), "Sensitive input cannot have prefill")
  .refine(value => value.kind !== "image" || (value.options === undefined && value.prefill === undefined && value.placeholder === undefined), "Image interactions cannot contain text input fields");

export const interactionResolutionStatusSchema = z.enum(["resolved", "cancelled", "expired"]);
export type InteractionResolutionStatus = z.infer<typeof interactionResolutionStatusSchema>;
export const interactionResolvedPayloadSchema = z
  .object({
    interactionId: idSchema,
    status: interactionResolutionStatusSchema,
    redacted: z.literal(true).optional(),
    response: interactionResponseSchema.optional(),
    reason: z.string().max(200).optional()
  })
  .strict().refine(value => !value.redacted || value.response === undefined, "Redacted resolution cannot contain a response");

export const queueStateSchema = z.enum(["ready", "paused"]);
export type QueueState = z.infer<typeof queueStateSchema>;
export const queuePauseSchema = z
  .object({
    runId: idSchema,
    reason: z.enum(["failed", "aborted", "interrupted"])
  })
  .strict();
export type QueuePause = z.infer<typeof queuePauseSchema>;
export const queueItemSchema = z
  .object({
    commandId: idSchema,
    runId: idSchema,
    kind: z.enum(["prompt", "follow_up", "compact"]),
    position: nonNegativeIntSchema
  })
  .strict();
export type QueueItem = z.infer<typeof queueItemSchema>;
export const queueUpdatedPayloadSchema = z
  .object({
    state: queueStateSchema,
    version: nonNegativeIntSchema,
    pause: queuePauseSchema.nullable(),
    items: z.array(queueItemSchema)
  })
  .strict()
  .superRefine((value, context) => {
    if (value.state === "ready" && value.pause !== null) {
      context.addIssue({ code: "custom", path: ["pause"], message: "ready queues cannot have a pause" });
    }
    if (value.state === "paused" && (value.pause === null || value.items.length === 0)) {
      context.addIssue({ code: "custom", path: ["pause"], message: "paused queues need a non-empty pause and item list" });
    }
  });

export const sessionChangesSchema = z
  .object({
    title: z.string().min(1).max(120).optional(),
    version: nonNegativeIntSchema.optional(),
    model: modelRefSchema.nullable().optional(),
    thinkingLevel: z.string().min(1).max(64).nullable().optional(),
    archived: z.boolean().optional(),
    archivedAt: timestampSchema.nullable().optional(),
    actualConfig: jsonObjectSchema.optional()
  })
  .strict();
export const sessionUpdatedPayloadSchema = z.object({ changes: sessionChangesSchema }).strict();

export const runtimeNoticeKindSchema = z.enum([
  "compaction",
  "retry",
  "output_truncated",
  "extension_notify",
  "extension_ui",
  "interrupted",
  "context_not_persisted",
  "generic"
]);
export const runtimeNoticePayloadSchema = z
  .object({
    kind: runtimeNoticeKindSchema,
    message: boundedTextSchema,
    details: jsonObjectSchema.optional()
  })
  .strict();

const eventBase = {
  schemaVersion: protocolVersionSchema,
  sessionId: idSchema,
  seq: positiveIntSchema,
  runId: idSchema.nullable(),
  operationId: idSchema.nullable(),
  timestamp: timestampSchema
};

function eventSchema<T extends z.ZodType<unknown>, K extends string>(type: K, payload: T) {
  return z
    .object({ ...eventBase, type: z.literal(type), payload })
    .strict();
}

export const commandUpdatedEventSchema = eventSchema("command.updated", z
  .object({
    commandId: idSchema,
    kind: commandKindSchema,
    state: commandStateSchema,
    targetRunId: idSchema.optional(),
    runs: z.array(commandRunRefSchema).optional(),
    error: runtimeErrorSchema.optional(),
    result: jsonObjectSchema.optional()
  })
  .strict());

export const operationUpdatedEventSchema = eventSchema("operation.updated", operationUpdatedPayloadSchema);
export const runUpdatedEventSchema = eventSchema("run.updated", runUpdatedPayloadSchema);
export const runContentSealedEventSchema = eventSchema("run.content_sealed", contentSealedPayloadSchema);
export const operationContentSealedEventSchema = eventSchema(
  "operation.content_sealed",
  contentSealedPayloadSchema
);
export const inputUpdatedEventSchema = eventSchema("input.updated", inputUpdatedPayloadSchema);
export const messageStartedEventSchema = eventSchema(
  "message.started",
  messageStartedPayloadSchema
);
export const contentStartedEventSchema = eventSchema("content.started", contentStartedPayloadSchema);
export const contentDeltaEventSchema = eventSchema("content.delta", contentDeltaPayloadSchema);
export const contentEndedEventSchema = eventSchema("content.ended", contentEndedPayloadSchema);
export const messageCompletedEventSchema = eventSchema(
  "message.completed",
  messageCompletedPayloadSchema
);
export const customEntryAppendedEventSchema = eventSchema(
  "custom_entry.appended",
  customEntryAppendedPayloadSchema
);
export const toolStartedEventSchema = eventSchema("tool.started", toolStartedPayloadSchema);
export const toolUpdatedEventSchema = eventSchema("tool.updated", toolUpdatedPayloadSchema);
export const toolFinishedEventSchema = eventSchema("tool.finished", toolFinishedPayloadSchema);
export const interactionRequestedEventSchema = eventSchema("interaction.requested", interactionRequestedPayloadSchema);
export const interactionResolvedEventSchema = eventSchema("interaction.resolved", interactionResolvedPayloadSchema);
export const queueUpdatedEventSchema = eventSchema("queue.updated", queueUpdatedPayloadSchema);
export const sessionUpdatedEventSchema = eventSchema("session.updated", sessionUpdatedPayloadSchema);
export const runtimeNoticeEventSchema = eventSchema("runtime.notice", runtimeNoticePayloadSchema);

export const eventSchemaUnion = z.discriminatedUnion("type", [
  commandUpdatedEventSchema,
  operationUpdatedEventSchema,
  runUpdatedEventSchema,
  runContentSealedEventSchema,
  operationContentSealedEventSchema,
  inputUpdatedEventSchema,
  messageStartedEventSchema,
  contentStartedEventSchema,
  contentDeltaEventSchema,
  contentEndedEventSchema,
  messageCompletedEventSchema,
  customEntryAppendedEventSchema,
  toolStartedEventSchema,
  toolUpdatedEventSchema,
  toolFinishedEventSchema,
  interactionRequestedEventSchema,
  interactionResolvedEventSchema,
  queueUpdatedEventSchema,
  sessionUpdatedEventSchema,
  runtimeNoticeEventSchema
]);

export type ProtocolEvent = z.infer<typeof eventSchemaUnion>;
export type EventType = ProtocolEvent["type"];

const eventsRequiringOperation = new Set<EventType>([
  "operation.updated",
  "run.updated",
  "run.content_sealed",
  "operation.content_sealed",
  "input.updated",
  "message.started",
  "content.started",
  "content.delta",
  "content.ended",
  "message.completed",
  "custom_entry.appended",
  "tool.started",
  "tool.updated",
  "tool.finished",
  "interaction.requested",
  "interaction.resolved"
]);

const eventsRequiringRun = new Set<EventType>(["run.updated", "run.content_sealed"]);

/** Parse and apply envelope-level ownership invariants shared by all events. */
export function parseProtocolEvent(input: unknown): ProtocolEvent {
  const event = eventSchemaUnion.parse(input);
  if (eventsRequiringOperation.has(event.type) && event.operationId === null) {
    throw new Error(`${event.type} requires operationId`);
  }
  if (eventsRequiringRun.has(event.type) && event.runId === null) {
    throw new Error(`${event.type} requires runId`);
  }
  if (event.type === "operation.updated" && event.payload.operationId !== event.operationId) {
    throw new Error("operation.updated payload.operationId must match its envelope");
  }
  if (event.type === "interaction.requested" && event.payload.operationId !== event.operationId) {
    throw new Error("interaction.requested payload.operationId must match its envelope");
  }
  if (event.type === "operation.content_sealed" && event.runId !== null) {
    throw new Error("operation.content_sealed cannot carry a runId");
  }
  return event;
}

export function isProtocolEvent(input: unknown): input is ProtocolEvent {
  try {
    parseProtocolEvent(input);
    return true;
  } catch {
    return false;
  }
}
