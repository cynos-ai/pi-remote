import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { parseProtocolEvent } from "../../packages/protocol/src/index.js";
import { encodeSpooledOutbound } from "../../packages/agent-pi/src/outbound-spool.js";
import { hydrateSpooledOutbound } from "../../apps/server/src/runtime/outbound-hydration.js";
import { archiveEventOutputs } from "../../apps/server/src/runtime/output-archive.js";
import { ArtifactStore } from "../../apps/server/src/realtime/artifacts.js";
import { EventStore, ProjectRepository, SessionRepository, openServerDatabase } from "../../apps/server/src/storage/index.js";
import { AuthService } from "../../apps/server/src/auth.js";
import { buildServer } from "../../apps/server/src/index.js";
import { parseEnv } from "../../apps/server/src/config.js";

it("R14 >1MiB spooled completion retains one full artifact through HTTP history and WebSocket replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "r14-http-"));
  const database = await openServerDatabase({ filename: join(root, "state", "db.sqlite") });
  const env = parseEnv({ PI_REMOTE_STATE_DIR: join(root, "state"), PI_REMOTE_PI_DIR: join(root, "pi"), PI_REMOTE_WORKSPACE_ROOT: root,
    PI_REMOTE_OWNER_ID: "owner", PI_REMOTE_OWNER_NAME: "Owner", PI_REMOTE_CURSOR_SECRET: "r14-cursor-secret" });
  const app = buildServer({ database, env });
  let socket: WebSocket | undefined;
  try {
    const auth = new AuthService(database);
    new ProjectRepository(database).create({ id: "project", userId: "owner", name: "Test", rootPath: root, workspaceKey: "key", rootIdentity: "identity" });
    new SessionRepository(database).create({ id: "session", projectId: "project", title: "Test" });
    const pairing = auth.createPairingToken("owner", 600);
    const pair = await app.inject({ method: "POST", url: "/v1/pair", payload: { pairingToken: pairing.token, deviceName: "Test" } });
    expect(pair.statusCode).toBe(201);
    const headers = { authorization: `Bearer ${pair.json().deviceToken}` };
    const base = { schemaVersion: 1, sessionId: "session", seq: 1, runId: null, operationId: "op", timestamp: "2026-09-15T00:00:00.000Z" };
    const text = "漢😀".repeat(170000);
    const custom = { type: "test", display: true };
    const events = [
      { ...base, type: "operation.updated", payload: { operationId: "op", kind: "extension", status: "running" } },
      { ...base, type: "message.started", payload: { messageId: "message", role: "custom", custom } },
      { ...base, type: "message.completed", payload: { messageId: "message", role: "custom", custom, blocks: [{ id: "block", index: 0, kind: "text", text }] } }
    ].map(parseProtocolEvent);
    const identity = { sessionId: "session", workerEpoch: "epoch" }; const spoolDir = join(root, "spool");
    const line = encodeSpooledOutbound({ ipcVersion: 1, ...identity, type: "event_batch", payload: { batchNo: 1, events } }, { spoolDir });
    expect(Buffer.byteLength(line)).toBeLessThan(1024);
    const hydrated = hydrateSpooledOutbound(JSON.parse(line), { spoolDir, ...identity }) as { payload: { events: typeof events } };
    const artifacts = new ArtifactStore(database, { rootDir: join(root, "state", "outputs") });
    const archived = await archiveEventOutputs(hydrated.payload.events, artifacts);
    const store = new EventStore(database);
    store.appendBatch({ ...identity, batchNo: 1, events: archived });
    // Rehydration + archival must reproduce the exact durable batch hash.
    store.appendBatch({ ...identity, batchNo: 1, events: await archiveEventOutputs(hydrated.payload.events, artifacts) });
    const completed = archived[2]!;
    if (completed.type !== "message.completed") throw new Error("wrong event");
    const block = completed.payload.blocks[0]!;
    const artifactId = block.artifactId!;
    expect(block.truncated).toBe(true); expect(artifactId).toBeTruthy();
    const history = await app.inject({ method: "GET", url: "/v1/sessions/session/history", headers });
    expect(history.statusCode).toBe(200); expect(history.body).toContain(artifactId); expect(history.body).toContain('"truncated":true');
    const download = await app.inject({ method: "GET", url: `/v1/artifacts/${artifactId}`, headers });
    expect(download.statusCode).toBe(200); expect(download.body).toBe(text);
    const range = await app.inject({ method: "GET", url: `/v1/artifacts/${artifactId}`, headers: { ...headers, range: "bytes=0-6" } });
    expect(range.statusCode).toBe(206); expect(range.body).toBe("漢😀");
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address(); if (!address || typeof address === "string") throw new Error("missing address");
    const ticket = await app.inject({ method: "POST", url: "/v1/ws-tickets", headers });
    socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/ws`, "pi-remote.v1");
    const messages: Array<Record<string, unknown>> = [];
    socket.addEventListener("message", (message) => messages.push(JSON.parse(String(message.data))));
    await new Promise<void>((resolve, reject) => { socket!.addEventListener("open", () => resolve(), { once: true }); socket!.addEventListener("error", () => reject(new Error("socket failed")), { once: true }); });
    socket.send(JSON.stringify({ type: "authenticate", ticket: ticket.json().ticket }));
    await expect.poll(() => messages.some((message) => message.type === "authenticated")).toBe(true);
    socket.send(JSON.stringify({ type: "subscribe", sessionId: "session", afterSeq: 0 }));
    await expect.poll(() => messages.some((message) => message.type === "event" && JSON.stringify(message).includes(artifactId))).toBe(true);
    expect(messages.filter((message) => message.type === "event").every((message) => Buffer.byteLength(JSON.stringify(message)) < 1024 * 1024)).toBe(true);
  } finally {
    socket?.close(); await app.close(); database.close(); await rm(root, { recursive: true, force: true });
  }
}, 20000);
