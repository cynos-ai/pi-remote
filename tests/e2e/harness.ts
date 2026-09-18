import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { ProtocolEvent } from "../../packages/protocol/src/index.js";
import { MobileApiError, type DeviceCredentials, type FetchLike } from "../../apps/mobile/src/api/client";
import type { MobileWebSocket, WebSocketFactory } from "../../apps/mobile/src/realtime";
import { AuthService } from "../../apps/server/src/auth.js";
import { parseEnv } from "../../apps/server/src/config.js";
import { buildServer } from "../../apps/server/src/index.js";
import { RealtimeHub } from "../../apps/server/src/realtime/index.js";
import {
  DeviceRepository,
  EventStore,
  OwnerRepository,
  ProjectRepository,
  SessionRepository,
  openServerDatabase,
  type AppendEventBatchResult
} from "../../apps/server/src/storage/index.js";

interface FastifyAppLike {
  server: { address(): string | { port: number } | null };
  listen(options: { host: string; port: number }): Promise<unknown>;
  close(): Promise<unknown>;
  inject(options: {
    method: string;
    url: string;
    headers?: Record<string, string>;
    payload?: unknown;
  }): Promise<{ statusCode: number; body: string }>;
}

export const S11_OWNER_ID = "s11-owner";
export const S11_DEVICE_ID = "s11-device-a";
export const S11_PROJECT_ID = "s11-project";
export const S11_SESSION_ID = "s11-session";
export const S11_DEVICE_TOKEN = "s11-device-a-token";
export const S11_NOW = Date.parse("2026-09-13T00:00:00.000Z");

export interface S11Fixture {
  root: string;
  workspace: string;
  database: DatabaseSync;
  ownerId: string;
  deviceId: string;
  projectId: string;
  sessionId: string;
  close(): Promise<void>;
}

/**
 * A real temporary SQLite fixture. It deliberately does not expose a test
 * HTTP endpoint for killing workers or changing database state.
 */
export async function createS11Fixture(): Promise<S11Fixture> {
  const root = await mkdtemp(join(tmpdir(), "pi-remote-s11-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const database = await openServerDatabase({
    filename: join(root, "state", "state.sqlite"),
    now: S11_NOW
  });
  new OwnerRepository(database).ensure({ id: S11_OWNER_ID, displayName: "S11 owner", now: S11_NOW });
  new DeviceRepository(database).create({
    id: S11_DEVICE_ID,
    userId: S11_OWNER_ID,
    name: "S11 device A",
    token: S11_DEVICE_TOKEN,
    now: S11_NOW
  });
  new ProjectRepository(database).create({
    id: S11_PROJECT_ID,
    userId: S11_OWNER_ID,
    name: "S11 project",
    rootPath: workspace,
    workspaceKey: "s11-workspace",
    rootIdentity: "s11-root-identity",
    now: S11_NOW
  });
  new SessionRepository(database).create({
    id: S11_SESSION_ID,
    projectId: S11_PROJECT_ID,
    title: "S11 session",
    now: S11_NOW
  });

  let closed = false;
  return {
    root,
    workspace,
    database,
    ownerId: S11_OWNER_ID,
    deviceId: S11_DEVICE_ID,
    projectId: S11_PROJECT_ID,
    sessionId: S11_SESSION_ID,
    async close() {
      if (closed) return;
      closed = true;
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  };
}

export interface FixtureEvent {
  type: ProtocolEvent["type"];
  payload: unknown;
  seq?: number;
  runId?: string | null;
  operationId?: string | null;
  timestamp?: string;
}

let nextBatchNo = 1;

/** Append events through the same durable EventStore used by the server. */
export function appendS11Events(
  fixture: Pick<S11Fixture, "database" | "sessionId" | "ownerId" | "deviceId">,
  events: readonly FixtureEvent[],
  workerEpoch = "s11-fixture-epoch"
): AppendEventBatchResult {
  return new EventStore(fixture.database, {
    commandActor: { userId: fixture.ownerId, deviceId: fixture.deviceId },
    now: () => S11_NOW
  }).appendBatch({
    sessionId: fixture.sessionId,
    workerEpoch,
    batchNo: nextBatchNo++,
    events: events.map((event) => ({
      schemaVersion: 1,
      sessionId: fixture.sessionId,
      seq: event.seq ?? 1,
      runId: event.runId ?? null,
      operationId: event.operationId ?? null,
      timestamp: event.timestamp ?? new Date(S11_NOW).toISOString(),
      type: event.type,
      payload: event.payload
    }))
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** A deterministic timer makes reconnect and AppState transitions observable. */
export class DeterministicTimer {
  private nextId = 1;
  private readonly callbacks = new Map<number, { callback: () => void; delayMs: number }>();

  readonly adapter = {
    set: (callback: () => void, delayMs: number): number => {
      const id = this.nextId++;
      this.callbacks.set(id, { callback, delayMs });
      return id;
    },
    clear: (handle: unknown): void => {
      if (typeof handle === "number") this.callbacks.delete(handle);
    }
  };

  get size(): number {
    return this.callbacks.size;
  }

  get delays(): number[] {
    return [...this.callbacks.values()].map((entry) => entry.delayMs);
  }

  fireNext(): void {
    const entry = this.callbacks.entries().next().value as [number, { callback: () => void; delayMs: number }] | undefined;
    if (!entry) throw new Error("S11 timer has no pending callback");
    this.callbacks.delete(entry[0]);
    entry[1].callback();
  }
}

export class ScriptedSocket implements MobileWebSocket {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;
  readonly sent: string[] = [];

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  receive(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

export class ScriptedSocketNetwork {
  readonly sockets: ScriptedSocket[] = [];

  readonly factory: WebSocketFactory = (url, protocols) => {
    void url;
    void protocols;
    const socket = new ScriptedSocket();
    this.sockets.push(socket);
    return socket;
  };
}

export class MemoryMobileSqlite {
  private readonly rows = new Map<string, { account: string; resource: string; payload: string; cursor: string | null; updatedAt: number }>();

  async execAsync(source: string): Promise<void> {
    void source;
  }

  async runAsync(source: string, ...params: unknown[]): Promise<unknown> {
    if (source.includes("INSERT INTO mobile_cache")) {
      const [account, resource, payload, cursor, updatedAt] = params;
      if (typeof account !== "string" || typeof resource !== "string" || typeof payload !== "string") {
        throw new Error("invalid mobile cache write");
      }
      this.rows.set(`${account}\u001f${resource}`, {
        account,
        resource,
        payload,
        cursor: typeof cursor === "string" ? cursor : null,
        updatedAt: Number(updatedAt)
      });
    } else if (source.includes("DELETE FROM mobile_cache")) {
      const account = params[0];
      if (typeof account === "string") {
        for (const [key, row] of this.rows) if (row.account === account) this.rows.delete(key);
      }
    }
    return undefined;
  }

  async getFirstAsync<T>(source: string, ...params: unknown[]): Promise<T | null> {
    if (!source.includes("FROM mobile_cache")) return null;
    const account = params[0];
    const resource = params[1];
    if (typeof account !== "string" || typeof resource !== "string") return null;
    const row = this.rows.get(`${account}\u001f${resource}`);
    if (!row) return null;
    return { payload_json: row.payload, cursor: row.cursor, updated_at: row.updatedAt } as T;
  }

  async getAllAsync<T>(source: string, ...params: unknown[]): Promise<T[]> {
    void source;
    void params;
    return [];
  }

  async withTransactionAsync(task: () => Promise<void>): Promise<void> {
    await task();
  }
}

/** Make a Fastify inject adapter usable by the mobile API client. */
export function fastifyFetch(app: FastifyAppLike): FetchLike {
  return async (input, init = {}) => {
    const url = new URL(input);
    const headers = new Headers(init.headers);
    const response = await app.inject({
      method: init.method ?? "GET",
      url: `${url.pathname}${url.search}`,
      headers: Object.fromEntries(headers.entries()),
      ...(init.body === undefined ? {} : { payload: typeof init.body === "string" ? init.body : String(init.body) })
    });
    return new Response(response.body, { status: response.statusCode });
  };
}

export interface S11ServerFixture extends S11Fixture {
  app: FastifyAppLike;
  auth: AuthService;
  realtime: RealtimeHub;
  httpBaseUrl: string;
  websocketUrl: string;
  pairDevice(name: string): Promise<DeviceCredentials>;
  connectSessionSocket(token: string, afterSeq?: number): Promise<SessionSocket>;
  fetch: FetchLike;
}

export interface SessionSocket {
  readonly socket: WebSocket;
  readonly messages: Array<Record<string, unknown>>;
  waitFor(predicate: (message: Record<string, unknown>) => boolean, timeoutMs?: number): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

/** A real HTTP/WebSocket server fixture for S11's two-device contract. */
export async function createS11ServerFixture(): Promise<S11ServerFixture> {
  const base = await createS11Fixture();
  // Pairing expiry is wall-clock based. The fixture's event timestamps remain
  // deterministic, while auth/ticket lifetimes use the runner's current time.
  const auth = new AuthService(base.database, { pairingTtlSeconds: 600 });
  const realtime = new RealtimeHub(base.database, auth, {
    artifactRoot: join(base.root, "state", "outputs"),
    pollIntervalMs: 10,
    heartbeatIntervalMs: 1_000,
    pongTimeoutMs: 10_000,
    now: () => S11_NOW
  });
  const env = parseEnv({
    PI_REMOTE_HOST: "127.0.0.1",
    PI_REMOTE_PORT: "0",
    PI_REMOTE_STATE_DIR: join(base.root, "state"),
    PI_REMOTE_PI_DIR: join(base.root, "pi"),
    PI_REMOTE_WORKSPACE_ROOT: base.workspace,
    PI_REMOTE_OWNER_ID: S11_OWNER_ID,
    PI_REMOTE_OWNER_NAME: "S11 owner",
    PI_REMOTE_PAIRING_TTL_SECONDS: "600",
    PI_REMOTE_CURSOR_SECRET: "s11-test-cursor-secret",
    PI_REMOTE_LIVE_TESTS: "0"
  });
  const app = buildServer({ env, database: base.database, realtimeHub: realtime });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") {
    await app.close();
    await base.close();
    throw new Error("S11 server did not expose a TCP address");
  }
  const port = address.port;
  const httpBaseUrl = `https://s11.test:${port}`;
  const websocketUrl = `ws://127.0.0.1:${port}/v1/ws`;
  const fixture: S11ServerFixture = {
    ...base,
    app,
    auth,
    realtime,
    httpBaseUrl,
    websocketUrl,
    fetch: fastifyFetch(app),
    async pairDevice(name) {
      const pairing = auth.createPairingToken(S11_OWNER_ID, 600);
      const response = await app.inject({
        method: "POST",
        url: "/v1/pair",
        payload: { pairingToken: pairing.token, deviceName: name }
      });
      if (response.statusCode !== 201) throw new Error(`S11 pairing failed: ${response.statusCode} ${response.body}`);
      return { baseUrl: httpBaseUrl, ...(JSON.parse(response.body) as Omit<DeviceCredentials, "baseUrl">) };
    },
    async connectSessionSocket(token, afterSeq = 0) {
      const ticketResponse = await app.inject({
        method: "POST",
        url: "/v1/ws-tickets",
        headers: { authorization: `Bearer ${token}` }
      });
      if (ticketResponse.statusCode !== 201) throw new Error(`S11 ticket failed: ${ticketResponse.statusCode}`);
      const ticket = (JSON.parse(ticketResponse.body) as { ticket?: unknown }).ticket;
      if (typeof ticket !== "string") throw new Error("S11 ticket response is invalid");
      return connectSessionSocket(websocketUrl, ticket, base.sessionId, afterSeq);
    },
    async close() {
      await app.close();
      await base.close();
    }
  };
  return fixture;
}

async function connectSessionSocket(url: string, ticket: string, sessionId: string, afterSeq: number): Promise<SessionSocket> {
  const socket = new WebSocket(url, "pi-remote.v1");
  const messages: Array<Record<string, unknown>> = [];
  let cursor = 0;
  let closed = false;
  let closeResolve!: () => void;
  const closePromise = new Promise<void>((resolve) => { closeResolve = resolve; });
  socket.addEventListener("message", (event) => {
    const data = typeof event.data === "string" ? event.data : String(event.data);
    messages.push(JSON.parse(data) as Record<string, unknown>);
  });
  socket.addEventListener("error", () => undefined);
  socket.addEventListener("close", () => {
    closed = true;
    closeResolve();
  });
  await new Promise<void>((resolve, reject) => {
    const onOpen = () => {
      socket.removeEventListener("error", onError);
      resolve();
    };
    const onError = () => {
      socket.removeEventListener("open", onOpen);
      reject(new Error("S11 WebSocket connection failed"));
    };
    socket.addEventListener("open", onOpen, { once: true });
    socket.addEventListener("error", onError, { once: true });
  });
  socket.send(JSON.stringify({ type: "authenticate", ticket }));
  await waitForMessage(messages, () => true, () => cursor++);
  socket.send(JSON.stringify({ type: "subscribe", sessionId, afterSeq }));
  return {
    socket,
    messages,
    waitFor(predicate, timeoutMs = 5_000) {
      return waitForMessage(messages, predicate, () => cursor++, timeoutMs, cursor);
    },
    async close() {
      if (closed) return;
      socket.close();
      await Promise.race([closePromise, delay(1_000)]);
    }
  };
}

async function waitForMessage(
  messages: Array<Record<string, unknown>>,
  predicate: (message: Record<string, unknown>) => boolean,
  advance: () => number,
  timeoutMs = 5_000,
  startIndex = 0
): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  let index = startIndex;
  while (Date.now() - startedAt < timeoutMs) {
    while (index < messages.length) {
      const message = messages[index++];
      advance();
      if (message && predicate(message)) return message;
    }
    await delay(10);
  }
  throw new Error(`timed out waiting for S11 WebSocket message; received ${JSON.stringify(messages)}`);
}

export function credentialErrorCode(error: unknown): string | null {
  return error instanceof MobileApiError ? error.code : null;
}

export async function flushMicrotasks(count = 8): Promise<void> {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
}
