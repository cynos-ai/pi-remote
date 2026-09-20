import { createReadStream } from "node:fs";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { getNativeCapabilities } from "@pi-remote/agent-pi";
import {
  capabilityResponseSchema,
  artifactSchema,
  commandRequestDtoSchema,
  devicesResponseSchema,
  errorResponseSchema,
  eventsQuerySchema,
  historyResponseSchema,
  idSchema,
  modelsResponseSchema,
  meResponseSchema,
  pairRequestSchema,
  pairResponseSchema,
  projectCreateRequestSchema,
  projectPatchRequestSchema,
  projectsResponseSchema,
  sessionCreateRequestSchema,
  sessionPatchRequestSchema,
  sessionsResponseSchema,
  snapshotResponseSchema,
  uuidSchema
} from "@pi-remote/protocol";
import {
  AuthError,
  FixedWindowRateLimiter,
  extractBearerToken,
  type AuthContext,
  type AuthService
} from "./auth.js";
import { ResourceServiceError } from "./services/resources.js";
import type { MutationResult, ResourceService } from "./services/resources.js";
import { CommandServiceError, SUPPORTED_COMMANDS, type CommandService } from "./services/commands.js";
import { WorkerManagerError } from "./runtime/manager.js";
import { type ServerEnv } from "./config.js";
import { MaintenanceError, assertWritable as assertDeploymentWritable } from "./maintenance.js";
import { ArtifactStoreError, RealtimeError, type RealtimeHub } from "./realtime/index.js";

const listQuerySchema = z.object({
  cursor: z.string().min(1).max(4096).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50)
}).strict();

const sessionsQuerySchema = listQuerySchema.extend({
  archived: z.enum(["exclude", "only", "all"]).default("exclude")
}).strict();

const idParamsSchema = z.object({ id: idSchema }).strict();

export interface RouteContext {
  env: ServerEnv;
  auth: AuthService;
  resources: ResourceService;
  commands: CommandService;
  realtime: RealtimeHub;
  pairingLimiter?: FixedWindowRateLimiter;
  deviceLimiter?: FixedWindowRateLimiter;
}

function requestId(request: FastifyRequest): string {
  return String(request.id);
}

function statusForError(error: AuthError | ResourceServiceError | CommandServiceError | WorkerManagerError | RealtimeError | MaintenanceError): number {
  if (error instanceof MaintenanceError) return 503;
  if (error instanceof AuthError) {
    if (error.code === "RATE_LIMITED") return 429;
    return error.code === "DEVICE_REVOKED" || error.code === "UNAUTHENTICATED" ? 401 : 400;
  }
  switch (error.code) {
    case "NOT_FOUND":
      return 404;
    case "IDEMPOTENCY_CONFLICT":
    case "VERSION_CONFLICT":
    case "STALE_RUN":
    case "INTERACTION_CLOSED":
    case "INTERACTION_MISMATCH":
      return 409;
    case "INVALID_CURSOR":
    case "INVALID_REQUEST":
      return 400;
    case "INVALID_PROJECT_PATH":
      return 422;
    case "ARTIFACT_UNAVAILABLE":
      return 503;
    case "QUEUE_FULL":
      return 429;
    default:
      return 503;
  }
}

export function sendProtocolError(
  request: FastifyRequest,
  reply: FastifyReply,
  code: string,
  status: number,
  message: string,
  details?: Record<string, unknown>,
  retryAfterSeconds?: number
): FastifyReply {
  if (retryAfterSeconds !== undefined) reply.header("Retry-After", String(retryAfterSeconds));
  const body = errorResponseSchema.parse({
    error: {
      code,
      message,
      requestId: requestId(request),
      ...(details === undefined ? {} : { details })
    }
  });
  return reply.code(status).send(body);
}

function idempotencyKey(request: FastifyRequest): string {
  const value = request.headers["idempotency-key"];
  if (typeof value !== "string" || !uuidSchema.safeParse(value).success) {
    throw new ResourceServiceError("INVALID_REQUEST", "Idempotency-Key must be a UUID");
  }
  return value;
}

function routeId(request: FastifyRequest): string {
  const parsed = idParamsSchema.parse(request.params);
  return parsed.id;
}

function runMutation(reply: FastifyReply, result: MutationResult): FastifyReply {
  return reply.code(result.status).send(result.body);
}

function authFor(
  request: FastifyRequest,
  context: RouteContext
): AuthContext {
  const limiter = context.deviceLimiter ?? new FixedWindowRateLimiter();
  const decision = limiter.check("device:" + request.ip, 240, 60_000);
  if (!decision.allowed) {
    throw new AuthError("RATE_LIMITED", "too many requests", decision.retryAfterSeconds);
  }
  return context.auth.authenticate(extractBearerToken(request.headers.authorization));
}

function assertWritable(context: RouteContext): void {
  assertDeploymentWritable(context.env.PI_REMOTE_STATE_DIR);
}

export function registerRoutes(app: FastifyInstance, context: RouteContext): void {
  const pairingLimiter = context.pairingLimiter ?? new FixedWindowRateLimiter();
  context.deviceLimiter ??= new FixedWindowRateLimiter();

  app.post("/v1/pair", async (request, reply) => {
    assertWritable(context);
    const decision = pairingLimiter.check("pair:" + request.ip, 20, 60_000);
    if (!decision.allowed) {
      throw new AuthError("RATE_LIMITED", "too many pairing attempts", decision.retryAfterSeconds);
    }
    const body = pairRequestSchema.parse(request.body);
    const response = pairResponseSchema.parse(context.auth.pair(body));
    return reply.code(201).send(response);
  });

  app.get("/v1/me", async (request, reply) => {
    const actor = authFor(request, context);
    return reply.send(meResponseSchema.parse(context.auth.getMe(actor)));
  });

  app.get("/v1/devices", async (request, reply) => {
    const actor = authFor(request, context);
    return reply.send(devicesResponseSchema.parse({ items: context.auth.listDevices(actor.userId) }));
  });

  app.delete("/v1/devices/:id", async (request, reply) => {
    const actor = authFor(request, context);
    assertWritable(context);
    const deviceId = routeId(request);
    const result = context.resources.revokeDevice(actor, deviceId, idempotencyKey(request));
    context.realtime.revokeDevice(deviceId);
    return runMutation(reply, result);
  });

  app.post("/v1/ws-tickets", async (request, reply) => {
    const actor = authFor(request, context);
    assertWritable(context);
    return reply.code(201).send(context.realtime.issueTicket(actor));
  });

  app.get("/v1/capabilities", async (request, reply) => {
    authFor(request, context);
    return reply.send(capabilityResponseSchema.parse({
      protocolVersion: 1,
      commands: [...SUPPORTED_COMMANDS],
      limits: { maxInputBytes: 64 * 1024 },
      features: {
        projects: true,
        sessions: true,
        execution: true,
        streaming: true,
        interactions: true,
        bash: true,
        extensions: true
      },
      nativeCapabilities: getNativeCapabilities()
    }));
  });

  app.post("/v1/sessions/:id/editor-state", async (request, reply) => {
    const actor = authFor(request, context);
    assertWritable(context);
    const body = z.object({ text: z.string() }).strict().parse(request.body);
    await context.resources.setEditorState(actor, routeId(request), body.text);
    return reply.code(204).send();
  });

  app.get("/v1/models", async (request, reply) => {
    const actor = authFor(request, context);
    const query = z.object({ sessionId: z.string().min(1).optional(), refresh: z.enum(["true", "false"]).optional() }).parse(request.query);
    return reply.send(modelsResponseSchema.parse(await context.resources.getModels(actor, query.sessionId, query.refresh === "true")));
  });

  app.get("/v1/projects", async (request, reply) => {
    const actor = authFor(request, context);
    const query = listQuerySchema.parse(request.query);
    return reply.send(projectsResponseSchema.parse(
      context.resources.listProjects(actor, query.cursor ?? null, query.limit)
    ));
  });

  app.post("/v1/projects", async (request, reply) => {
    const actor = authFor(request, context);
    assertWritable(context);
    const body = projectCreateRequestSchema.parse(request.body);
    const result = await context.resources.createProject(actor, body, idempotencyKey(request));
    return runMutation(reply, result);
  });

  app.get("/v1/projects/:id", async (request, reply) => {
    const actor = authFor(request, context);
    return reply.send(context.resources.getProject(actor, routeId(request)));
  });

  app.patch("/v1/projects/:id", async (request, reply) => {
    const actor = authFor(request, context);
    assertWritable(context);
    const body = projectPatchRequestSchema.parse(request.body);
    return runMutation(
      reply,
      context.resources.patchProject(actor, routeId(request), body, idempotencyKey(request))
    );
  });

  app.get("/v1/projects/:id/sessions", async (request, reply) => {
    const actor = authFor(request, context);
    const query = sessionsQuerySchema.parse(request.query);
    return reply.send(sessionsResponseSchema.parse(
      context.resources.listSessions(
        actor,
        routeId(request),
        query.archived,
        query.cursor ?? null,
        query.limit
      )
    ));
  });

  app.post("/v1/projects/:id/sessions", async (request, reply) => {
    const actor = authFor(request, context);
    assertWritable(context);
    const body = sessionCreateRequestSchema.parse(request.body);
    const result = await context.resources.createSession(
      actor,
      routeId(request),
      body,
      idempotencyKey(request)
    );
    return runMutation(reply, result);
  });

  app.get("/v1/projects/:id/recoverable-history", async (request, reply) => {
    return reply.send(await context.resources.listRecoverableHistory(authFor(request, context), routeId(request)));
  });
  app.post("/v1/projects/:id/history-imports", async (request, reply) => {
    const actor = authFor(request, context);
    assertWritable(context);
    return runMutation(reply, await context.resources.importHistory(actor, routeId(request), request.body, idempotencyKey(request)));
  });

  app.get("/v1/sessions/:id", async (request, reply) => {
    const actor = authFor(request, context);
    return reply.send(context.resources.getSession(actor, routeId(request)));
  });

  app.patch("/v1/sessions/:id", async (request, reply) => {
    const actor = authFor(request, context);
    assertWritable(context);
    const body = sessionPatchRequestSchema.parse(request.body);
    return runMutation(
      reply,
      context.resources.patchSession(actor, routeId(request), body, idempotencyKey(request))
    );
  });

  app.get("/v1/sessions/:id/snapshot", async (request, reply) => {
    const actor = authFor(request, context);
    return reply.send(snapshotResponseSchema.parse(await context.resources.getSnapshot(actor, routeId(request))));
  });

  app.post("/v1/sessions/:id/artifacts", async (request, reply) => {
    const actor = authFor(request, context);
    assertWritable(context);
    const sessionId = routeId(request);
    // This lookup enforces the actor → project → Session ownership chain
    // before accepting bytes. The route never accepts a client filesystem path.
    context.resources.getSession(actor, sessionId);
    if (!Buffer.isBuffer(request.body) || request.body.byteLength === 0) {
      throw new ResourceServiceError("INVALID_REQUEST", "artifact body must be non-empty binary data");
    }
    const contentType = typeof request.headers["content-type"] === "string"
      ? request.headers["content-type"].split(";", 1)[0]?.trim()
      : undefined;
    const artifact = await context.realtime.archiveBytes({
      sessionId,
      bytes: request.body,
      mimeType: contentType || "application/octet-stream"
    });
    if (!artifact) throw new ArtifactStoreError("ARTIFACT_STORAGE_LIMIT", "artifact exceeds the configured storage limit");
    const stored = context.realtime.getSessionAttachment(actor, sessionId, artifact.id);
    if (!stored) throw new ArtifactStoreError("ARTIFACT_UNAVAILABLE", "uploaded artifact could not be verified");
    return reply.code(201).send(artifactSchema.parse(stored.metadata));
  });

  app.post("/v1/sessions/:id/commands", async (request, reply) => {
    const actor = authFor(request, context);
    assertWritable(context);
    const sessionId = routeId(request);
    const body = commandRequestDtoSchema.parse(request.body);
    if ("attachments" in body.payload && body.payload.attachments) {
      context.realtime.validateAttachments(actor, sessionId, body.payload.attachments);
    }
    const result = await context.commands.submit(
      actor,
      sessionId,
      body,
      idempotencyKey(request)
    );
    return reply.code(result.status).send(result.body);
  });

  app.get("/v1/sessions/:id/history", async (request, reply) => {
    const actor = authFor(request, context);
    const query = z.object({
      cursor: z.string().min(1).max(4096).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50)
    }).strict().parse(request.query);
    return reply.send(historyResponseSchema.parse(
      context.resources.getHistory(actor, routeId(request), query.cursor ?? null, query.limit)
    ));
  });

  app.get("/v1/sessions/:id/events", async (request, reply) => {
    const actor = authFor(request, context);
    const query = eventsQuerySchema.parse(request.query);
    return reply.send(context.resources.getEvents(actor, routeId(request), query.afterSeq, query.limit));
  });

  app.get("/v1/commands/:id", async (request, reply) => {
    const actor = authFor(request, context);
    return reply.send(context.resources.getCommand(actor, routeId(request)));
  });

  app.get("/v1/artifacts/:id", async (request, reply) => {
    const actor = authFor(request, context);
    const artifact = context.realtime.getArtifact(actor, routeId(request));
    if (!artifact) throw new ResourceServiceError("NOT_FOUND", "artifact was not found");
    const range = parseByteRange(request.headers.range, artifact.record.sizeBytes);
    if (range === "invalid") {
      return reply
        .code(416)
        .header("Accept-Ranges", "bytes")
        .header("Content-Range", `bytes */${artifact.record.sizeBytes}`)
        .send();
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? Math.max(0, artifact.record.sizeBytes - 1);
    const contentLength = artifact.record.sizeBytes === 0 ? 0 : end - start + 1;
    reply
      .code(range ? 206 : 200)
      .header("Content-Type", artifact.record.mimeType)
      .header("Content-Length", String(contentLength))
      .header("Accept-Ranges", "bytes")
      .header("ETag", `"${artifact.record.sha256}"`)
      .header("Cache-Control", "private, no-store");
    if (range) reply.header("Content-Range", `bytes ${start}-${end}/${artifact.record.sizeBytes}`);
    return reply.send(createReadStream(artifact.filePath, range ? { start, end } : undefined));
  });
}

function parseByteRange(
  header: string | undefined,
  size: number
): { start: number; end: number } | null | "invalid" {
  if (header === undefined) return null;
  if (size === 0) return "invalid";
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === "" && match[2] === "")) return "invalid";
  let start: number;
  let end: number;
  if (match[1] === "") {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return "invalid";
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Number(match[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) return "invalid";
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

export function installErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AuthError) {
      return sendProtocolError(
        request,
        reply,
        error.code,
        statusForError(error),
        error.message,
        undefined,
        error.retryAfterSeconds
      );
    }
    if (error instanceof ResourceServiceError) {
      return sendProtocolError(
        request,
        reply,
        error.code,
        statusForError(error),
        error.message,
        error.details
      );
    }
    if (error instanceof MaintenanceError) {
      return sendProtocolError(request, reply, error.code, statusForError(error), error.message);
    }
    if (error instanceof CommandServiceError || error instanceof WorkerManagerError || error instanceof RealtimeError) {
      return sendProtocolError(
        request,
        reply,
        error.code,
        statusForError(error),
        error.message,
        error instanceof CommandServiceError ? error.details : undefined
      );
    }
    if (error instanceof ArtifactStoreError) {
      return sendProtocolError(
        request,
        reply,
        error.code === "ARTIFACT_STORAGE_LIMIT" ? "STORAGE_LIMIT" : "STORAGE_UNAVAILABLE",
        error.code === "ARTIFACT_STORAGE_LIMIT" ? 413 : 503,
        error.message
      );
    }
    const statusCode = typeof error === "object" && error !== null && "statusCode" in error
      ? Number((error as { statusCode?: unknown }).statusCode)
      : 0;
    if (statusCode === 413) {
      return sendProtocolError(request, reply, "PAYLOAD_TOO_LARGE", 413, "request body is too large");
    }
    if (error instanceof z.ZodError || statusCode === 400) {
      return sendProtocolError(request, reply, "INVALID_REQUEST", 400, "request is invalid");
    }
    return sendProtocolError(request, reply, "STORAGE_UNAVAILABLE", 503, "service is temporarily unavailable");
  });
}
