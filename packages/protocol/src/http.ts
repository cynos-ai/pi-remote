import { z } from "zod";
import {
  cursorSchema,
  idSchema,
  modelRefSchema,
  nameSchema,
  nonNegativeIntSchema,
  protocolVersionSchema,
  timestampSchema,
  type ModelRef
} from "./common.js";
import {
  commandIdempotencyKeySchema,
  commandKindSchema,
  commandRecordSchema,
  commandReceiptSchema,
  commandRequestSchema,
  type CommandRequest,
  type CommandRecord,
  type CommandReceipt
} from "./commands.js";
import { eventSchemaUnion, type ProtocolEvent } from "./events.js";
import {
  piPersistenceStateSchema,
  sessionProjectionSchema,
  sessionStatusSchema,
  snapshotSchema,
  timelineItemSchema,
  type SessionProjection,
  type Snapshot
} from "./state.js";

export const healthResponseSchema = z
  .object({
    status: z.literal("ok"),
    version: z.string().min(1)
  })
  .strict();
export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const userSchema = z
  .object({
    id: idSchema,
    displayName: z.string().min(1).max(120)
  })
  .strict();
export type User = z.infer<typeof userSchema>;
export const deviceSchema = z
  .object({
    id: idSchema,
    name: z.string().min(1).max(120),
    createdAt: timestampSchema,
    revokedAt: timestampSchema.nullable()
  })
  .strict();
export type Device = z.infer<typeof deviceSchema>;
export const pairRequestSchema = z
  .object({
    pairingToken: z.string().min(1).max(512),
    deviceName: z.string().min(1).max(120)
  })
  .strict();
export const pairResponseSchema = z
  .object({
    deviceId: idSchema,
    deviceToken: z.string().min(1),
    user: userSchema
  })
  .strict();
export type PairResponse = z.infer<typeof pairResponseSchema>;
export const meResponseSchema = z
  .object({
    user: userSchema,
    device: deviceSchema
  })
  .strict();
export type MeResponse = z.infer<typeof meResponseSchema>;
export const devicesResponseSchema = z.object({ items: z.array(deviceSchema) }).strict();
export const deviceRevocationResponseSchema = z
  .object({
    id: idSchema,
    revokedAt: timestampSchema
  })
  .strict();
export type DeviceRevocationResponse = z.infer<typeof deviceRevocationResponseSchema>;

export const nativeCapabilitySchema = z
  .object({
    id: idSchema,
    area: z.enum(["session", "streaming", "model", "input", "extension", "resources", "bash", "ui"]),
    status: z.enum(["available", "needs_adapter", "disabled_by_owner", "upstream_unavailable"]),
    evidence: z.enum(["sdk_api", "contract_smoke", "live_not_run"]),
    sdkEntryPoints: z.array(z.string().min(1)),
    adapterPlan: z.string().min(1),
    notes: z.string().min(1)
  })
  .strict();
export const capabilityResponseSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    commands: z.array(commandKindSchema),
    limits: z.record(z.string(), z.number().nonnegative()).default({}),
    features: z.record(z.string(), z.boolean()).default({}),
    nativeCapabilities: z.array(nativeCapabilitySchema)
  })
  .strict();
export type CapabilityResponse = z.infer<typeof capabilityResponseSchema>;

export const modelInfoSchema = z
  .object({
    model: modelRefSchema,
    name: z.string().min(1).max(240),
    thinkingLevels: z.array(z.string().min(1).max(64)),
    contextWindow: nonNegativeIntSchema
  })
  .strict();
export const modelsResponseSchema = z.object({ items: z.array(modelInfoSchema) }).strict();
export type ModelInfo = z.infer<typeof modelInfoSchema>;

export const projectSummarySchema = z
  .object({
    id: idSchema,
    name: nameSchema,
    version: nonNegativeIntSchema,
    lastActivityAt: timestampSchema.nullable(),
    runningCount: nonNegativeIntSchema,
    waitingInputCount: nonNegativeIntSchema,
    blockedReason: z.string().max(240).nullable().optional()
  })
  .strict();
export type ProjectSummary = z.infer<typeof projectSummarySchema>;

export const projectSchema = z
  .object({
    ...projectSummarySchema.shape,
    rootPath: z.string().min(1),
    workspaceKey: z.string().min(1),
    rootIdentity: z.string().min(1),
    gitCommonDir: z.string().min(1).nullable(),
    defaultModel: modelRefSchema.nullable(),
    defaultThinkingLevel: z.string().min(1).max(64).nullable()
  })
  .strict();
export type Project = z.infer<typeof projectSchema>;

export const projectsResponseSchema = z
  .object({ items: z.array(projectSummarySchema), nextCursor: cursorSchema.nullable() })
  .strict();
export const projectCreateRequestSchema = z
  .object({
    name: nameSchema,
    rootPath: z.string().min(1).max(4096),
    defaultModel: modelRefSchema.optional(),
    defaultThinkingLevel: z.string().min(1).max(64).optional()
  })
  .strict();
export const projectPatchRequestSchema = z
  .object({
    expectedVersion: nonNegativeIntSchema,
    name: nameSchema.optional(),
    defaultModel: modelRefSchema.nullable().optional(),
    defaultThinkingLevel: z.string().min(1).max(64).nullable().optional()
  })
  .strict();
export const projectMutationResponseSchema = z
  .object({ project: projectSchema, commandId: idSchema })
  .strict();

export const sessionSummarySchema = sessionProjectionSchema;
export type SessionSummary = SessionProjection;
export const archivedFilterSchema = z.enum(["exclude", "only", "all"]);
export const sessionsResponseSchema = z
  .object({ items: z.array(sessionSummarySchema), nextCursor: cursorSchema.nullable() })
  .strict();
export const sessionCreateRequestSchema = z
  .object({
    title: nameSchema.optional(),
    model: modelRefSchema.optional(),
    thinkingLevel: z.string().min(1).max(64).optional()
  })
  .strict();
export const sessionPatchRequestSchema = z
  .object({
    expectedVersion: nonNegativeIntSchema,
    title: nameSchema.optional(),
    archived: z.boolean().optional()
  })
  .strict();
export const sessionMutationResponseSchema = z
  .object({ session: sessionSummarySchema, commandId: idSchema })
  .strict();

export const historyQuerySchema = z
  .object({ cursor: cursorSchema, limit: z.coerce.number().int().min(1).max(200).default(50) })
  .strict();
export const eventsQuerySchema = z
  .object({ afterSeq: z.coerce.number().int().nonnegative(), limit: z.coerce.number().int().min(1).max(500).default(500) })
  .strict();

export const historyResponseSchema = z
  .object({
    items: z.array(timelineItemSchema),
    nextCursor: cursorSchema.nullable(),
    atSeq: nonNegativeIntSchema
  })
  .strict();
export type HistoryResponse = z.infer<typeof historyResponseSchema>;

export const eventEnvelopeSchema = eventSchemaUnion;
export const eventsResponseSchema = z
  .object({
    events: z.array(eventSchemaUnion),
    throughSeq: nonNegativeIntSchema,
    hasMore: z.boolean()
  })
  .strict();

export const snapshotResponseSchema = snapshotSchema;

export const commandRequestDtoSchema = commandRequestSchema;
export const commandReceiptDtoSchema = commandReceiptSchema;
export const commandDetailResponseSchema = commandRecordSchema;
export type { CommandRequest, CommandRecord, CommandReceipt, ModelRef, ProtocolEvent, Snapshot };
export { commandIdempotencyKeySchema };

export const wsTicketResponseSchema = z
  .object({
    ticket: z.string().min(1),
    expiresAt: timestampSchema
  })
  .strict();
export type WsTicketResponse = z.infer<typeof wsTicketResponseSchema>;
export const wsAuthenticateSchema = z.object({ type: z.literal("authenticate"), ticket: z.string().min(1) }).strict();
export const wsSubscribeSchema = z
  .object({
    type: z.literal("subscribe"),
    sessionId: idSchema,
    afterSeq: nonNegativeIntSchema
  })
  .strict();
export const wsUnsubscribeSchema = z.object({ type: z.literal("unsubscribe"), sessionId: idSchema }).strict();
export const wsControlFrameSchema = z.discriminatedUnion("type", [
  wsAuthenticateSchema,
  wsSubscribeSchema,
  wsUnsubscribeSchema
]);
export type WsControlFrame = z.infer<typeof wsControlFrameSchema>;

export const wsAuthenticatedFrameSchema = z
  .object({ type: z.literal("authenticated"), protocolVersion: protocolVersionSchema })
  .strict();
export const wsSubscriptionReadySchema = z
  .object({
    type: z.literal("subscription.ready"),
    sessionId: idSchema,
    throughSeq: nonNegativeIntSchema
  })
  .strict();
export const wsEventFrameSchema = z
  .object({ type: z.literal("event"), sessionId: idSchema, event: eventSchemaUnion })
  .strict()
  .superRefine((value, context) => {
    if (value.event.sessionId !== value.sessionId) {
      context.addIssue({ code: "custom", path: ["event", "sessionId"], message: "event Session does not match the frame" });
    }
  });
export const wsErrorFrameSchema = z
  .object({ type: z.literal("error"), code: z.string().regex(/^[A-Z][A-Z0-9_.-]*$/), message: z.string().min(1).max(1000) })
  .strict();
export const wsResyncRequiredFrameSchema = z
  .object({
    type: z.literal("resync_required"),
    sessionId: idSchema.optional(),
    reason: z.enum(["slow_consumer", "event_too_large", "snapshot_required"])
  })
  .strict();
export const wsServerFrameSchema = z.discriminatedUnion("type", [
  wsAuthenticatedFrameSchema,
  wsSubscriptionReadySchema,
  wsEventFrameSchema,
  wsErrorFrameSchema,
  wsResyncRequiredFrameSchema
]);
export type WsServerFrame = z.infer<typeof wsServerFrameSchema>;

export const artifactSchema = z
  .object({
    id: idSchema,
    sessionId: idSchema,
    mimeType: z.string().min(1).max(255),
    byteLength: nonNegativeIntSchema,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: timestampSchema
  })
  .strict();
export type Artifact = z.infer<typeof artifactSchema>;

export { piPersistenceStateSchema, sessionStatusSchema };
