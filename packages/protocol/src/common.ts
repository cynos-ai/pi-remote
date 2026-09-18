import { z } from "zod";

export const PROTOCOL_VERSION = 1 as const;
export const protocolVersionSchema = z.literal(PROTOCOL_VERSION);

/**
 * IDs are opaque at the protocol boundary.  The server generates UUIDs for
 * business resources, while SDK references (message/block/tool IDs) may use
 * another stable representation.  UUID enforcement belongs to the storage
 * layer, not to the client reducer.
 */
export const idSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => value.trim() === value, "IDs must not have surrounding whitespace");

export const uuidSchema = z.string().uuid();
export const cursorSchema = z.string().min(1).max(4096);
export const nonNegativeIntSchema = z.number().int().nonnegative().safe();
export const positiveIntSchema = z.number().int().positive().safe();
export const boundedTextSchema = z.string().min(1).max(32768);
export const nameSchema = z.string().min(1).max(120);

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema)
  ])
);

export const jsonObjectSchema: z.ZodType<JsonObject> = z.record(z.string(), jsonValueSchema);

/** RFC3339 with an explicit UTC offset, including the usual `Z` form. */
export const timestampSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      /(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
      !Number.isNaN(Date.parse(value)) &&
      value.includes("T"),
    "expected an RFC3339 timestamp with an explicit offset"
  );

export const modelRefSchema = z
  .object({
    provider: z.string().min(1).max(120),
    id: z.string().min(1).max(240)
  })
  .strict();
export type ModelRef = z.infer<typeof modelRefSchema>;

export const protocolErrorCodeSchema = z.enum([
  "INVALID_REQUEST",
  "INVALID_CURSOR",
  "UNAUTHENTICATED",
  "DEVICE_REVOKED",
  "NOT_FOUND",
  "IDEMPOTENCY_CONFLICT",
  "VERSION_CONFLICT",
  "SESSION_BUSY",
  "STALE_RUN",
  "INTERACTION_CLOSED",
  "PAYLOAD_TOO_LARGE",
  "MODEL_UNAVAILABLE",
  "NOTHING_TO_COMPACT",
  "INVALID_PROJECT_PATH",
  "RATE_LIMITED",
  "QUEUE_FULL",
  "STORAGE_UNAVAILABLE",
  "INSTANCE_RECOVERING",
  "WORKSPACE_BLOCKED",
  "HISTORY_UNAVAILABLE"
]);

export const protocolErrorSchema = z
  .object({
    code: protocolErrorCodeSchema.or(z.string().regex(/^[A-Z][A-Z0-9_]*$/)),
    message: z.string().min(1).max(1000),
    requestId: idSchema,
    details: jsonObjectSchema.optional()
  })
  .strict();

export const errorResponseSchema = z.object({ error: protocolErrorSchema }).strict();
export type ProtocolError = z.infer<typeof protocolErrorSchema>;
export type ErrorResponse = z.infer<typeof errorResponseSchema>;

/** Errors emitted after an asynchronous command was accepted. */
export const runtimeErrorSchema = z
  .object({
    code: z.string().min(1).max(120),
    message: z.string().max(1000).optional(),
    requestId: idSchema.optional(),
    details: jsonObjectSchema.optional()
  })
  .strict();
export type RuntimeError = z.infer<typeof runtimeErrorSchema>;

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
