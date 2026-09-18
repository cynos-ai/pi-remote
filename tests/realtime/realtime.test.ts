import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "../../apps/server/src/index.js";
import { AuthService } from "../../apps/server/src/auth.js";
import { parseEnv } from "../../apps/server/src/config.js";
import { RealtimeHub } from "../../apps/server/src/realtime/index.js";
import {
  EventStore,
  ProjectRepository,
  SessionRepository,
  openServerDatabase,
  type AppendEventBatchResult
} from "../../apps/server/src/storage/index.js";
import type { DatabaseSync } from "node:sqlite";

const OWNER = "s08-owner";
const WORKSPACE_NAME = "workspace";
const SESSION_ID = "s08-session";
const PROJECT_ID = "s08-project";
const FIXED_TIMESTAMP = "2026-09-13T00:00:00.000Z";
let nextBatchNo = 1;

interface WsMessage {
  type?: string;
  sessionId?: string;
  throughSeq?: number;
  code?: string;
  event?: { seq?: number; type?: string; payload?: Record<string, unknown> };
  reason?: string;
}

interface TestSocket {
  socket: WebSocket;
  messages: WsMessage[];
  waitFor(predicate: (message: WsMessage) => boolean, timeoutMs?: number): Promise<WsMessage>;
  close(): Promise<void>;
}

interface Fixture {
  root: string;
  workspace: string;
  database: DatabaseSync;
  app: ReturnType<typeof buildServer>;
  deviceToken: string;
  deviceId: string;
  sockets: TestSocket[];
}

const fixtures: Fixture[] = [];

function authHeaders(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

function json(response: { body: string }): Record<string, unknown> {
  return JSON.parse(response.body) as Record<string, unknown>;
}

async function makeSocket(url: string): Promise<TestSocket> {
  const socket = new WebSocket(url, "pi-remote.v1");
  const messages: WsMessage[] = [];
  let messageCursor = 0;
  let closed: { code: number; reason: string } | null = null;
  let closeResolve: ((value: { code: number; reason: string }) => void) | undefined;
  const closePromise = new Promise<{ code: number; reason: string }>((resolve) => { closeResolve = resolve; });
  socket.addEventListener("message", (event) => {
    const data = typeof event.data === "string" ? event.data : String(event.data);
    messages.push(JSON.parse(data) as WsMessage);
  });
  socket.addEventListener("close", (event) => {
    closed = { code: event.code, reason: event.reason };
    closeResolve?.(closed);
  });
  await new Promise<void>((resolve, reject) => {
    const onOpen = () => {
      socket.removeEventListener("error", onError);
      resolve();
    };
    const onError = () => {
      socket.removeEventListener("open", onOpen);
      reject(new Error("WebSocket connection failed"));
    };
    socket.addEventListener("open", onOpen, { once: true });
    socket.addEventListener("error", onError, { once: true });
  });
  return {
    socket,
    messages,
    waitFor(predicate, timeoutMs = 5_000) {
      const startedAt = Date.now();
      return new Promise<WsMessage>((resolve, reject) => {
        const check = () => {
          for (; messageCursor < messages.length; messageCursor += 1) {
            const candidate = messages[messageCursor];
            if (candidate && predicate(candidate)) {
              messageCursor += 1;
              resolve(candidate);
              return;
            }
          }
          if (Date.now() - startedAt >= timeoutMs) {
            reject(new Error(`timed out waiting for WebSocket message; received ${JSON.stringify(messages)}`));
            return;
          }
          setTimeout(check, 10);
        };
        check();
      });
    },
    async close() {
      if (closed) return;
      socket.close();
      await Promise.race([
        closePromise,
        new Promise<void>((resolve) => setTimeout(resolve, 1_000))
      ]);
    }
  };
}

async function createFixture(options: { maxBufferedBytes?: number } = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "pi-remote-s08-"));
  const workspace = join(root, WORKSPACE_NAME);
  await mkdir(workspace, { recursive: true });
  const database = await openServerDatabase({ filename: join(root, "state", "state.sqlite") });
  const bootstrapAuth = new AuthService(database);
  bootstrapAuth.ensureOwner({ id: OWNER, displayName: "S08 owner" });
  const project = new ProjectRepository(database).create({
    id: PROJECT_ID,
    userId: OWNER,
    name: "S08 project",
    rootPath: workspace,
    workspaceKey: "s08-workspace",
    rootIdentity: "s08-root-identity"
  });
  new SessionRepository(database).create({ id: SESSION_ID, projectId: project.id, title: "S08 session" });
  const env = parseEnv({
    PI_REMOTE_HOST: "127.0.0.1",
    PI_REMOTE_PORT: "0",
    PI_REMOTE_STATE_DIR: join(root, "state"),
    PI_REMOTE_PI_DIR: join(root, "pi"),
    PI_REMOTE_WORKSPACE_ROOT: workspace,
    PI_REMOTE_OWNER_ID: OWNER,
    PI_REMOTE_OWNER_NAME: "S08 owner",
    PI_REMOTE_PAIRING_TTL_SECONDS: "600",
    PI_REMOTE_CURSOR_SECRET: "s08-test-cursor-secret",
    PI_REMOTE_LIVE_TESTS: "0"
  });
  const realtime = new RealtimeHub(database, bootstrapAuth, {
    artifactRoot: join(root, "state", "outputs"),
    ...(options.maxBufferedBytes === undefined ? {} : { maxBufferedBytes: options.maxBufferedBytes }),
    pollIntervalMs: 10,
    heartbeatIntervalMs: 1_000,
    pongTimeoutMs: 10_000
  });
  const app = buildServer({ env, database, realtimeHub: realtime });
  const pairing = bootstrapAuth.createPairingToken(OWNER, 600);
  const response = await app.inject({
    method: "POST",
    url: "/v1/pair",
    payload: { pairingToken: pairing.token, deviceName: "S08 test device" }
  });
  expect(response.statusCode).toBe(201);
  const paired = json(response) as { deviceId: string; deviceToken: string };
  const fixture: Fixture = {
    root,
    workspace,
    database,
    app,
    deviceToken: paired.deviceToken,
    deviceId: paired.deviceId,
    sockets: []
  };
  await app.listen({ host: "127.0.0.1", port: 0 });
  fixtures.push(fixture);
  return fixture;
}

function serverUrl(fixture: Fixture): string {
  const address = fixture.app.server.address();
  if (!address || typeof address === "string") throw new Error("test server did not expose a TCP address");
  return `ws://127.0.0.1:${address.port}/v1/ws`;
}

function appendEvents(fixture: Fixture, events: Array<Record<string, unknown>>): AppendEventBatchResult {
  return new EventStore(fixture.database, {
    commandActor: { userId: OWNER, deviceId: fixture.deviceId },
    now: () => Date.parse(FIXED_TIMESTAMP)
  }).appendBatch({
    sessionId: SESSION_ID,
    workerEpoch: "s08-epoch",
    batchNo: nextBatchNo++,
    events: events.map((event) => ({
      schemaVersion: 1,
      sessionId: SESSION_ID,
      seq: 1,
      runId: null,
      operationId: null,
      timestamp: FIXED_TIMESTAMP,
      ...event
    }))
  });
}

function notice(message: string): Record<string, unknown> {
  return {
    type: "runtime.notice",
    payload: { kind: "generic", message }
  };
}

async function ticket(fixture: Fixture, token = fixture.deviceToken): Promise<string> {
  const response = await fixture.app.inject({ method: "POST", url: "/v1/ws-tickets", headers: authHeaders(token) });
  expect(response.statusCode).toBe(201);
  return (json(response).ticket as string);
}

async function authenticatedSocket(fixture: Fixture, afterSeq: number, token = fixture.deviceToken): Promise<TestSocket> {
  const socket = await makeSocket(serverUrl(fixture));
  fixture.sockets.push(socket);
  socket.socket.send(JSON.stringify({ type: "authenticate", ticket: await ticket(fixture, token) }));
  await socket.waitFor((message) => message.type === "authenticated");
  socket.socket.send(JSON.stringify({ type: "subscribe", sessionId: SESSION_ID, afterSeq }));
  return socket;
}

afterEach(async () => {
  while (fixtures.length > 0) {
    const fixture = fixtures.pop();
    if (!fixture) continue;
    for (const socket of fixture.sockets) await socket.close();
    await fixture.app.close();
    fixture.database.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

describe("S08 realtime event delivery", () => {
  it("authenticates one-shot device tickets and closes existing connections on revocation", async () => {
    const fixture = await createFixture();
    const oneShot = await ticket(fixture);
    const first = await makeSocket(serverUrl(fixture));
    fixture.sockets.push(first);
    first.socket.send(JSON.stringify({ type: "authenticate", ticket: oneShot }));
    await first.waitFor((message) => message.type === "authenticated");

    const reused = await makeSocket(serverUrl(fixture));
    fixture.sockets.push(reused);
    const reusedClosed = new Promise<number>((resolve) => reused.socket.addEventListener("close", (event) => resolve(event.code), { once: true }));
    reused.socket.send(JSON.stringify({ type: "authenticate", ticket: oneShot }));
    await expect(reusedClosed).resolves.toBe(4401);

    const secondPairing = new AuthService(fixture.database).createPairingToken(OWNER, 600);
    const secondPair = await fixture.app.inject({
      method: "POST",
      url: "/v1/pair",
      payload: { pairingToken: secondPairing.token, deviceName: "S08 revocation device" }
    });
    expect(secondPair.statusCode).toBe(201);
    const secondDeviceToken = (json(secondPair).deviceToken as string);
    const firstClosed = new Promise<number>((resolve) => first.socket.addEventListener("close", (event) => resolve(event.code), { once: true }));
    const revoked = await fixture.app.inject({
      method: "DELETE",
      url: `/v1/devices/${fixture.deviceId}`,
      headers: { ...authHeaders(secondDeviceToken), "idempotency-key": "b8f3a8f1-1a7f-4d6c-a180-f30c5cbf0c01" }
    });
    expect(revoked.statusCode).toBe(200);
    await expect(firstClosed).resolves.toBe(4401);
    const ticketAfterRevoke = await fixture.app.inject({ method: "POST", url: "/v1/ws-tickets", headers: authHeaders(fixture.deviceToken) });
    expect(ticketAfterRevoke.statusCode).toBe(401);
  });

  it("replays committed events without a handoff gap and validates Session authorization", async () => {
    const fixture = await createFixture();
    appendEvents(fixture, [notice("before subscribe")]);
    const first = await authenticatedSocket(fixture, 0);
    const firstEvent = await first.waitFor((message) => message.type === "event");
    expect(firstEvent.event?.seq).toBe(1);
    await expect(first.waitFor((message) => message.type === "subscription.ready")).resolves.toMatchObject({ throughSeq: 1 });

    appendEvents(fixture, [notice("after subscribe"), notice("second after subscribe")]);
    const liveOne = await first.waitFor((message) => message.type === "event" && message.event?.seq === 2);
    const liveTwo = await first.waitFor((message) => message.type === "event" && message.event?.seq === 3);
    expect([liveOne.event?.seq, liveTwo.event?.seq]).toEqual([2, 3]);
    await first.close();

    const second = await authenticatedSocket(fixture, 1);
    const replayed = [
      await second.waitFor((message) => message.type === "event"),
      await second.waitFor((message) => message.type === "event")
    ];
    expect(replayed.map((message) => message.event?.seq)).toEqual([2, 3]);
    await expect(second.waitFor((message) => message.type === "subscription.ready")).resolves.toMatchObject({ throughSeq: 3 });

    const unauthorizedTicket = await ticket(fixture);
    const unauthorized = await makeSocket(serverUrl(fixture));
    fixture.sockets.push(unauthorized);
    unauthorized.socket.send(JSON.stringify({ type: "authenticate", ticket: unauthorizedTicket }));
    await unauthorized.waitFor((message) => message.type === "authenticated");
    unauthorized.socket.send(JSON.stringify({ type: "subscribe", sessionId: "missing-session", afterSeq: 0 }));
    await expect(unauthorized.waitFor((message) => message.type === "error")).resolves.toMatchObject({ code: "NOT_FOUND" });
  });

  it("replaces oversized display output, keeps a downloadable artifact, and resyncs a slow consumer", async () => {
    const fixture = await createFixture();
    const runId = "s08-run";
    const operationId = "s08-operation";
    const fullOutput = "0123456789abcdef".repeat(150_000);
    appendEvents(fixture, [
      {
        runId,
        operationId,
        type: "operation.updated",
        payload: { operationId, kind: "run", status: "running", runId }
      },
      {
        runId,
        operationId,
        type: "run.updated",
        payload: { kind: "prompt", status: "running", phase: "tool", source: "runtime" }
      },
      {
        runId,
        operationId,
        type: "tool.started",
        payload: { toolCallId: "s08-tool", toolName: "shell", args: {} }
      },
      {
        runId,
        operationId,
        type: "tool.updated",
        payload: { toolCallId: "s08-tool", output: { text: fullOutput, truncated: false } }
      }
    ]);
    const socket = await authenticatedSocket(fixture, 0);
    const oversized = await socket.waitFor((message) => message.type === "event" && message.event?.type === "tool.updated");
    const output = oversized.event?.payload?.output as Record<string, unknown> | undefined;
    expect(output?.truncated).toBe(true);
    expect(typeof output?.artifactId).toBe("string");
    expect(Buffer.byteLength(JSON.stringify(oversized))).toBeLessThanOrEqual(1024 * 1024);
    const artifactId = output?.artifactId as string;
    const full = await fixture.app.inject({
      method: "GET",
      url: `/v1/artifacts/${artifactId}`,
      headers: authHeaders(fixture.deviceToken)
    });
    expect(full.statusCode).toBe(200);
    expect(Buffer.byteLength(full.body, "utf8")).toBe(Buffer.byteLength(fullOutput, "utf8"));
    const range = await fixture.app.inject({
      method: "GET",
      url: `/v1/artifacts/${artifactId}`,
      headers: { ...authHeaders(fixture.deviceToken), range: "bytes=10-19" }
    });
    expect(range.statusCode).toBe(206);
    expect(range.body).toBe(fullOutput.slice(10, 20));

    const slowFixture = await createFixture({ maxBufferedBytes: 1 });
    appendEvents(slowFixture, [notice("slow client")]);
    const slow = await authenticatedSocket(slowFixture, 0);
    const slowClose = new Promise<number>((resolve) => slow.socket.addEventListener("close", (event) => resolve(event.code), { once: true }));
    await expect(slow.waitFor((message) => message.type === "resync_required")).resolves.toMatchObject({ reason: "slow_consumer" });
    await expect(slowClose).resolves.toBe(4408);
  });
});
