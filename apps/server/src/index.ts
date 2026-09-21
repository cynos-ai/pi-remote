import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { ServerOptions as HttpsServerOptions } from "node:https";
import fastify, { type FastifyInstance } from "fastify";
import { PROTOCOL_VERSION, type HealthResponse } from "@pi-remote/protocol";
import { AuthService } from "./auth.js";
import { parseEnv, type ServerEnv } from "./config.js";
import { MaintenanceError, readMaintenanceState } from "./maintenance.js";
import { installErrorHandler, registerRoutes } from "./routes.js";
import { CommandService } from "./services/commands.js";
import { loadSecretFingerprintKey } from "./secret-fingerprint.js";
import { ResourceService } from "./services/resources.js";
import { openServerDatabaseSync } from "./storage/database.js";
import { WorkerManager } from "./runtime/manager.js";
import { DEFAULT_ARTIFACT_MAX_BYTES, RealtimeHub } from "./realtime/index.js";

const APP_VERSION = "0.1.0-s12";

export interface ServerOptions {
  env?: ServerEnv;
  logger?: boolean;
  database?: DatabaseSync;
  workerManager?: WorkerManager;
  https?: Pick<HttpsServerOptions, "key" | "cert">;
  realtimeHub?: RealtimeHub;
}

export function buildServer(options: ServerOptions = {}): FastifyInstance {
  const env = options.env ?? parseEnv();
  if (readMaintenanceState(env.PI_REMOTE_STATE_DIR) !== null) {
    throw new MaintenanceError("MAINTENANCE", "state volume is in maintenance mode; exit maintenance before starting the service");
  }
  const ownsDatabase = options.database === undefined;
  const database = options.database ?? openServerDatabaseSync({
    filename: env.PI_REMOTE_DATABASE_FILE ?? join(env.PI_REMOTE_STATE_DIR, "state.sqlite")
  });
  const auth = new AuthService(database, {
    pairingTtlSeconds: env.PI_REMOTE_PAIRING_TTL_SECONDS
  });
  auth.ensureOwner({ id: env.PI_REMOTE_OWNER_ID, displayName: env.PI_REMOTE_OWNER_NAME });
  const ownsWorkerManager = options.workerManager === undefined;
  const workerManager = options.workerManager ?? new WorkerManager(database, {
    stateDir: env.PI_REMOTE_STATE_DIR,
    piDir: env.PI_REMOTE_PI_DIR,
    agentDir: env.PI_REMOTE_PI_DIR,
    sessionDir: join(env.PI_REMOTE_PI_DIR, "sessions"),
    workerIdleMs: env.PI_REMOTE_WORKER_IDLE_SECONDS * 1000,
    schedulerOptions: {
      maxRuns: env.PI_REMOTE_MAX_ACTIVE_RUNS,
      maxWorkers: env.PI_REMOTE_MAX_LOADED_WORKERS,
      serializeWorkspace: env.PI_REMOTE_SERIALIZE_WORKSPACE === "1"
    }
  });
  if (ownsWorkerManager) workerManager.start();
  const realtime = options.realtimeHub ?? new RealtimeHub(database, auth, {
    artifactRoot: join(env.PI_REMOTE_STATE_DIR, "outputs"),
    now: () => Date.now()
  });
  const resources = new ResourceService(database, auth, {
    workspaceRoot: env.PI_REMOTE_WORKSPACE_ROOT,
    cursorSecret: env.PI_REMOTE_CURSOR_SECRET,
    nativeHistoryRoot: join(env.PI_REMOTE_PI_DIR, "sessions"),
    manager: workerManager
  });
  const commands = new CommandService(database, workerManager, {
    secretFingerprintKey: loadSecretFingerprintKey(env.PI_REMOTE_PI_DIR),
    maxQueuedCommands: env.PI_REMOTE_MAX_QUEUED_COMMANDS,
    resolveAttachmentFiles: (sessionId, attachments) => realtime.resolveAttachmentFiles(sessionId, attachments)
  });
  const app = fastify({
    logger: options.logger ?? false,
    // Command payloads are still constrained by their protocol schemas. The
    // larger HTTP limit is only needed for the bounded binary artifact route.
    bodyLimit: DEFAULT_ARTIFACT_MAX_BYTES,
    ...(options.https ? { https: options.https } : {})
  });
  app.addContentTypeParser(
    /^(?:application\/octet-stream|application\/pdf|image\/[^;]+|audio\/[^;]+|video\/[^;]+|text\/[^;]+)(?:;|$)/i,
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body)
  );
  realtime.attach(app.server);

  app.get<{ Reply: HealthResponse }>("/healthz", async () => ({
    status: "ok",
    version: `${APP_VERSION};protocol=${PROTOCOL_VERSION}`
  }));

  app.get("/readyz", async (_request, reply) => {
    return reply.send({ status: "ok", version: APP_VERSION });
  });

  registerRoutes(app, { env, auth, resources, commands, realtime });
  installErrorHandler(app);

  app.addHook("onClose", async () => {
    commands.dispose();
    realtime.close();
    if (ownsWorkerManager) await workerManager.stop();
    if (ownsDatabase) database.close();
  });

  return app;
}

export async function startServer(options: ServerOptions = {}): Promise<FastifyInstance> {
  const env = options.env ?? parseEnv();
  const app = buildServer({ ...options, env });
  await app.listen({ host: env.PI_REMOTE_HOST, port: env.PI_REMOTE_PORT });
  return app;
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  startServer({ logger: true }).catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
