import { z } from "zod";
import {
  boundedTextSchema,
  idSchema,
  jsonObjectSchema,
  modelRefSchema,
  nonNegativeIntSchema,
  runtimeErrorSchema,
  uuidSchema
} from "./common.js";

export const commandKindSchema = z.enum([
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
]);
export type CommandKind = z.infer<typeof commandKindSchema>;

export const commandStateSchema = z.enum([
  "queued",
  "dispatching",
  "accepted",
  "completed",
  "failed",
  "cancelled",
  "unknown"
]);
export type CommandState = z.infer<typeof commandStateSchema>;

export const attachmentSchema = z
  .object({
    artifactId: idSchema,
    mimeType: z.string().min(1).max(255)
  })
  .strict();
export type Attachment = z.infer<typeof attachmentSchema>;

export const inputContentSchema = z
  .object({
    text: boundedTextSchema,
    attachments: z.array(attachmentSchema).max(32).optional()
  })
  .strict();
export type InputContent = z.infer<typeof inputContentSchema>;

const promptPayloadSchema = z
  .object({
    text: boundedTextSchema,
    attachments: z.array(attachmentSchema).max(32).optional(),
    streamingBehavior: z.enum(["steer", "followUp"]).optional()
  })
  .strict();

const extensionCommandPayloadSchema = z.object({ text: boundedTextSchema }).strict();
const bashPayloadSchema = z
  .object({
    command: boundedTextSchema,
    excludeFromContext: z.boolean().optional()
  })
  .strict();
const emptyPayloadSchema = z.object({}).strict();
const followUpPayloadSchema = z
  .object({ text: boundedTextSchema, attachments: z.array(attachmentSchema).max(32).optional() })
  .strict();
const steerPayloadSchema = z
  .object({
    targetRunId: idSchema,
    text: boundedTextSchema,
    attachments: z.array(attachmentSchema).max(32).optional()
  })
  .strict();
const abortPayloadSchema = z.object({ targetRunId: idSchema }).strict();
const cancelQueuedPayloadSchema = z.object({ targetCommandId: idSchema }).strict();
const resumeQueuePayloadSchema = z
  .object({
    expectedQueueVersion: nonNegativeIntSchema,
    afterRunId: idSchema
  })
  .strict();
const setModelPayloadSchema = z
  .object({
    expectedVersion: nonNegativeIntSchema,
    model: modelRefSchema,
    persist: z.boolean().optional()
  })
  .strict();
const setThinkingPayloadSchema = z
  .object({
    expectedVersion: nonNegativeIntSchema,
    level: z.string().min(1).max(64),
    persist: z.boolean().optional()
  })
  .strict();
const compactPayloadSchema = z
  .object({
    expectedVersion: nonNegativeIntSchema,
    instructions: boundedTextSchema.optional()
  })
  .strict();

export const interactionCancelResponseSchema = z.object({ cancelled: z.literal(true) }).strict();
export const interactionSelectResponseSchema = z.object({ value: z.string().min(1).max(32768) }).strict();
export const interactionConfirmResponseSchema = z.object({ confirmed: z.boolean() }).strict();
export const interactionValueResponseSchema = z.object({ value: z.string().max(32768) }).strict();
export const interactionResponseSchema = z.union([
  interactionCancelResponseSchema,
  interactionSelectResponseSchema,
  interactionConfirmResponseSchema,
  interactionValueResponseSchema
]);
export type InteractionResponse = z.infer<typeof interactionResponseSchema>;

const respondPayloadSchema = z
  .object({
    interactionId: idSchema,
    operationId: idSchema,
    response: interactionResponseSchema
  })
  .strict();

export const commandRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("prompt"), payload: promptPayloadSchema }).strict(),
  z.object({ kind: z.literal("extension_command"), payload: extensionCommandPayloadSchema }).strict(),
  z.object({ kind: z.literal("bash"), payload: bashPayloadSchema }).strict(),
  z.object({ kind: z.literal("abort_bash"), payload: emptyPayloadSchema }).strict(),
  z.object({ kind: z.literal("follow_up"), payload: followUpPayloadSchema }).strict(),
  z.object({ kind: z.literal("steer"), payload: steerPayloadSchema }).strict(),
  z.object({ kind: z.literal("abort"), payload: abortPayloadSchema }).strict(),
  z.object({ kind: z.literal("cancel_queued"), payload: cancelQueuedPayloadSchema }).strict(),
  z.object({ kind: z.literal("resume_queue"), payload: resumeQueuePayloadSchema }).strict(),
  z.object({ kind: z.literal("set_model"), payload: setModelPayloadSchema }).strict(),
  z.object({ kind: z.literal("set_thinking"), payload: setThinkingPayloadSchema }).strict(),
  z.object({ kind: z.literal("compact"), payload: compactPayloadSchema }).strict(),
  z.object({ kind: z.literal("respond"), payload: respondPayloadSchema }).strict()
]);
export type CommandRequest = z.infer<typeof commandRequestSchema>;

export const commandRunRefSchema = z
  .object({
    runId: idSchema,
    sessionId: idSchema
  })
  .strict();
export type CommandRunRef = z.infer<typeof commandRunRefSchema>;

export const commandResultSchema = jsonObjectSchema;

export const commandRecordSchema = z
  .object({
    commandId: idSchema,
    kind: commandKindSchema,
    state: commandStateSchema,
    targetRunId: idSchema.optional(),
    runs: z.array(commandRunRefSchema),
    error: runtimeErrorSchema.optional(),
    result: commandResultSchema.optional()
  })
  .passthrough();
export type CommandRecord = z.infer<typeof commandRecordSchema>;

export const commandReceiptSchema = z
  .object({
    commandId: idSchema,
    state: z.enum(["queued", "completed"]),
    runId: idSchema.optional(),
    result: commandResultSchema.optional()
  })
  .passthrough();
export type CommandReceipt = z.infer<typeof commandReceiptSchema>;

export const commandIdempotencyKeySchema = uuidSchema;

export const commandPayloadSchemas = {
  prompt: promptPayloadSchema,
  extension_command: extensionCommandPayloadSchema,
  bash: bashPayloadSchema,
  abort_bash: emptyPayloadSchema,
  follow_up: followUpPayloadSchema,
  steer: steerPayloadSchema,
  abort: abortPayloadSchema,
  cancel_queued: cancelQueuedPayloadSchema,
  resume_queue: resumeQueuePayloadSchema,
  set_model: setModelPayloadSchema,
  set_thinking: setThinkingPayloadSchema,
  compact: compactPayloadSchema,
  respond: respondPayloadSchema
} as const;
