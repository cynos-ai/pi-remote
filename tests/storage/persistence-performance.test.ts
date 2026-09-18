import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { createInitialState, reduceEvent, reduceEvents } from "../../packages/protocol/src/index.js";
import {
  DeviceRepository, EventStore, OwnerRepository, ProjectRepository, SessionRepository,
  loadReducerState, openServerDatabase, readEvents, readSnapshot
} from "../../apps/server/src/storage/index.js";

const timestamp = "2026-09-12T08:00:00.000Z";
const resources: Array<{ database: DatabaseSync; directory: string }> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const { database, directory } of resources.splice(0)) {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function setup(sessionIds: string[] = ["short", "long"]) {
  const directory = await mkdtemp(join(tmpdir(), "pi-persistence-perf-"));
  const database = await openServerDatabase({ filename: join(directory, "state.sqlite") });
  resources.push({ database, directory });
  new OwnerRepository(database).ensure({ id: "owner", displayName: "owner" });
  new DeviceRepository(database).create({ id: "device", userId: "owner", name: "device", token: "synthetic-token" });
  new ProjectRepository(database).create({
    id: "project", userId: "owner", name: "project", rootPath: directory,
    workspaceKey: directory, rootIdentity: directory
  });
  for (const id of sessionIds) new SessionRepository(database).create({ id, projectId: "project", title: id });
  return { database, store: new EventStore(database) };
}
function event(type: string, payload: unknown, extra: Record<string, unknown> = {}) {
  return { schemaVersion: 1, sessionId: "short", seq: 1, operationId: null, runId: null, timestamp, type, payload, ...extra };
}
async function stream(sessionId: string) {
  const data = JSON.parse(await readFile("docs/examples/stream.json", "utf8"));
  return data.events.map((item: Record<string, unknown>) => ({
    schemaVersion: 1, timestamp, ...item, sessionId,
    operationId: data.operationId + sessionId, runId: data.runId + sessionId,
    payload: { ...(item.payload as object), ...((item.payload as Record<string, unknown>).operationId ? { operationId: data.operationId + sessionId } : {}), ...((item.payload as Record<string, unknown>).commandId ? { commandId: data.commandId + sessionId } : {}) }
  }));
}

it("keeps delta SQL work independent of finalized history and avoids unrelated projection writes", async () => {
  const { database, store } = await setup();
  for (const sessionId of ["short", "long"]) {
    const events = await stream(sessionId);
    store.appendBatch({ sessionId, workerEpoch: sessionId, batchNo: 1, events: events.slice(0, 10) });
  }
  // Populate a realistic-sized immutable payload corpus without timing fixture creation.
  const insert = database.prepare(`INSERT INTO timeline_items
    (session_id,item_id,operation_id,run_id,kind,completeness,ordinal_seq,finalized_seq,payload_json)
    VALUES ('long', ?, 'history-operation', NULL, 'message', 'complete', 1, 1, ?)`);
  database.exec("BEGIN");
  for (let i = 0; i < 2000; i++) insert.run(`history-${i}`, JSON.stringify({
    messageId: `history-${i}`, role: "assistant", blocks: [{ id: "text", index: 0, kind: "text", text: "x".repeat(8192) }]
  }));
  database.exec("COMMIT");
  for (const table of ["commands", "runs", "interactions"]) database.exec(`
    CREATE TEMP TRIGGER forbid_${table}_rewrite BEFORE UPDATE ON ${table}
    BEGIN SELECT RAISE(ABORT, 'unrelated projection rewrite'); END`);
  const originalPrepare = database.prepare.bind(database);
  let historicalPayloadReads = 0;
  const prepare = vi.spyOn(database, "prepare").mockImplementation((sql) => {
    if (/FROM\s+timeline_items/i.test(sql) && /payload_json/i.test(sql)) historicalPayloadReads++;
    return originalPrepare(sql);
  });
  const samples: Record<string, number[]> = { short: [], long: [] };
  const sqlCounts: Record<string, number> = {};
  const rssBefore = process.memoryUsage().rss;
  let peakRss = rssBefore;
  const eventLoopTurns: number[] = [];
  for (let batchNo = 2; batchNo <= 41; batchNo++) {
    const turnStarted = performance.now();
    const yielded = new Promise<void>((resolve) => setImmediate(() => {
      eventLoopTurns.push(performance.now() - turnStarted);
      resolve();
    }));
    for (const sessionId of ["short", "long"]) {
      const before = prepare.mock.calls.length;
      const started = performance.now();
      const result = store.appendBatch({ sessionId, workerEpoch: sessionId, batchNo, events: [event(
        "content.delta", { messageId: "assistant-1", blockId: "a0", delta: "token " },
        { sessionId, operationId: "34444444-4444-4444-8444-444444444444" + sessionId, runId: "22222222-2222-4222-8222-222222222222" + sessionId }
      )] });
      samples[sessionId]!.push(performance.now() - started);
      sqlCounts[sessionId] = prepare.mock.calls.length - before;
      expect(result.lastSeq).toBe(batchNo + 9);
    }
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    await yielded;
  }
  expect(historicalPayloadReads).toBe(0);
  expect(sqlCounts.long).toBe(sqlCounts.short);
  expect(sqlCounts.long).toBeLessThan(15);
  expect(loadReducerState(database, "long", { includeTimeline: false }).liveItems["assistant-1"]).toMatchObject({
    data: { blocks: [{ text: "token ".repeat(40) }] }
  });
  // The snapshot reads only its bounded tail, in the same order as full reconstruction.
  expect(readSnapshot(database, "long").items).toEqual(loadReducerState(database, "long").timelineItems.slice(-50));
  const p95 = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length * 0.95)];
  console.info("R15 persistence benchmark", { historyItems: 2000, historyTextBytes: 2000 * 8192,
    batchesPerSession: 40, eventLoopTurnP95Millis: p95(eventLoopTurns), rssGrowthBytes: peakRss - rssBefore, p95Millis: { short: p95(samples.short!), long: p95(samples.long!) }, sqlCounts });
});

it("sustains bounded writes across multiple Sessions without starving the event loop", async () => {
  const sessionIds = Array.from({ length: 8 }, (_, index) => `stress-${index}`);
  const { database, store } = await setup(sessionIds);
  const seeds = new Map<string, { operationId: string; runId: string }>();
  for (const sessionId of sessionIds) {
    const events = await stream(sessionId);
    store.appendBatch({ sessionId, workerEpoch: `stress-${sessionId}`, batchNo: 1, events: events.slice(0, 10) });
    const operationId = String(events[1]!.operationId);
    const runId = String(events[2]!.runId);
    seeds.set(sessionId, { operationId, runId });
  }

  const eventLoopTurns: number[] = [];
  const rssBefore = process.memoryUsage().rss;
  let peakRss = rssBefore;
  const totalRounds = 120;
  for (let round = 2; round <= totalRounds + 1; round++) {
    const turnStarted = performance.now();
    const yielded = new Promise<void>((resolve) => setImmediate(() => {
      eventLoopTurns.push(performance.now() - turnStarted);
      resolve();
    }));
    for (const sessionId of sessionIds) {
      const seed = seeds.get(sessionId)!;
      store.appendBatch({
        sessionId,
        workerEpoch: `stress-${sessionId}`,
        batchNo: round,
        events: [event("content.delta", { messageId: "assistant-1", blockId: "a0", delta: "token " }, {
          sessionId,
          operationId: seed.operationId,
          runId: seed.runId
        })]
      });
    }
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    await yielded;
  }

  const p95 = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length * 0.95)]!;
  expect(p95(eventLoopTurns)).toBeLessThan(250);
  expect(peakRss - rssBefore).toBeLessThan(128 * 1024 * 1024);
  for (const sessionId of sessionIds) {
    const state = loadReducerState(database, sessionId, { includeTimeline: false });
    expect(state.lastSeq).toBe(totalRounds + 10);
    expect(state.liveItems["assistant-1"]?.data).toMatchObject({ blocks: [{ text: "token ".repeat(totalRounds) }] });
  }
  console.info("R15 multi-session stress", {
    sessions: sessionIds.length,
    roundsPerSession: totalRounds,
    appendedEvents: sessionIds.length * totalRounds,
    eventLoopTurnP95Millis: p95(eventLoopTurns),
    rssGrowthBytes: peakRss - rssBefore
  });
});

it("rejects historical message/tool ID reuse and rolls back failed mixed batches, including outer transactions", async () => {
  const { database, store } = await setup();
  const events = await stream("short");
  store.appendBatch({ sessionId: "short", workerEpoch: "epoch", batchNo: 1, events: events.slice(0, 19) });
  const snapshot = readSnapshot(database, "short");
  for (const type of ["message.started", "tool.started"]) {
    const payload = type === "message.started" ? { messageId: "user-1", role: "user" } : { toolCallId: "user-1", toolName: "bash", args: {} };
    expect(() => store.appendBatch({ sessionId: "short", workerEpoch: "epoch", batchNo: 2, events: [
      event("session.updated", { changes: { title: "must roll back" } }),
      { ...events[3], type, payload }
    ] })).toThrow(/already exists/);
  }
  expect(readSnapshot(database, "short")).toEqual(snapshot);
  database.exec("BEGIN");
  store.appendBatchWithinTransaction({ sessionId: "short", workerEpoch: "epoch", batchNo: 2,
    events: [event("session.updated", { changes: { title: "outer rollback" } })] });
  database.exec("ROLLBACK");
  const retry = new EventStore(database).appendBatch({ sessionId: "short", workerEpoch: "epoch", batchNo: 2,
    events: [event("session.updated", { changes: { title: "after rollback" } })] });
  expect(retry).toMatchObject({ duplicate: false, firstSeq: 20 });
  expect(readSnapshot(database, "short").session).toMatchObject({ title: "after rollback", version: 2 });
});

it("stamps effective native changes once, preserving explicit versions, no-op echoes and retry identity", async () => {
  const { database, store } = await setup();
  const update = (changes: unknown) => event("session.updated", { changes });
  const input = { sessionId: "short", workerEpoch: "native", batchNo: 1, events: [
    update({ title: "native" }), update({ title: "native" }), update({ thinkingLevel: "high" }),
    update({ model: { provider: "test", id: "test-model" }, version: 7 }),
    update({ title: "latest" })
  ] };
  const committed = store.appendBatch(input);
  expect(committed.events.map((item) => (item.payload as { changes: { version?: number } }).changes.version)).toEqual([2, undefined, 3, 7, 8]);
  expect(new EventStore(database).appendBatch(input)).toEqual({ ...committed, duplicate: true });
  expect(readEvents(database, "short", 0).events).toEqual(committed.events);
  expect(readSnapshot(database, "short").session.version).toBe(8);
  expect(() => store.appendBatch({ ...input, batchNo: 2, events: [update({ title: "stale", version: 7 })] })).toThrow(/not newer/);
  expect(readSnapshot(database, "short").session.version).toBe(8);
});

it("copies mutable projections once per batch, shares finalized payloads, and preserves caller state on failure", async () => {
  const events = await stream("short");
  const state = reduceEvents(createInitialState("short"), events.slice(0, 10));
  const before = structuredClone(state);
  const clone = vi.spyOn(globalThis, "structuredClone");
  const delta = { ...events[10], seq: 11 };
  const deltas = Array.from({ length: 100 }, (_, index) => ({ ...delta, seq: index + 11 }));
  const batched = reduceEvents(state, deltas);
  const stateClones = clone.mock.calls.filter(([value]) => value && typeof value === "object" && "liveItems" in value);
  expect(stateClones).toHaveLength(1);
  expect(batched.timelineItems[0]).toBe(state.timelineItems[0]);
  expect(state).toEqual(before);
  expect(batched).toEqual(deltas.reduce((current, input) => reduceEvent(current, input), state));
  expect(() => reduceEvents(state, [...deltas, { ...delta, seq: 999 }])).toThrow();
  expect(state).toEqual(before);
  expect(reduceEvents(batched, deltas)).toBe(batched);
});

it("syncs implicit interaction cancellation without rewriting an unrelated pending interaction", async () => {
  const { database, store } = await setup();
  for (const operationId of ["ending", "waiting"]) {
    store.appendBatch({ sessionId: "short", workerEpoch: operationId, batchNo: 1, events: [
      event("operation.updated", { operationId, kind: "initialize", status: "running" }, { operationId }),
      event("interaction.requested", { interactionId: operationId, operationId, origin: "initialize", kind: "confirm", title: "Synthetic confirmation" }, { operationId })
    ] });
  }
  database.exec(`CREATE TEMP TRIGGER unchanged_interaction BEFORE UPDATE ON interactions
    WHEN OLD.id = 'waiting' BEGIN SELECT RAISE(ABORT, 'unrelated interaction rewrite'); END`);
  store.appendBatch({ sessionId: "short", workerEpoch: "ending", batchNo: 2, events: [
    event("operation.updated", { operationId: "ending", kind: "initialize", status: "completed" }, { operationId: "ending" })
  ] });
  expect(database.prepare("SELECT id, status FROM interactions ORDER BY id").all()).toEqual([
    { id: "ending", status: "cancelled" }, { id: "waiting", status: "pending" }
  ]);
});


it("R09 cross-session causal projections cannot overwrite a command's owning-session target, including after rehoming", async () => {
  const { database, store } = await setup();
  const events = await stream("short");
  const commandId = "33333333-3333-4333-8333-333333333333short";
  const sourceRun = "22222222-2222-4222-8222-222222222222short";
  store.appendBatch({ sessionId: "short", workerEpoch: "source", batchNo: 1, events: events.slice(0, 3) });
  store.appendBatch({ sessionId: "short", workerEpoch: "source", batchNo: 2, events: [
    event("command.updated", { commandId, kind: "prompt", state: "queued", targetRunId: sourceRun })
  ] });
  const target = () => database.prepare("SELECT session_id, target_run_id FROM commands WHERE id = ?").get(commandId);
  const destination = { sessionId: "long", operationId: "destination-op", runId: "destination-run" };
  store.appendBatch({ sessionId: "long", workerEpoch: "destination", batchNo: 1, events: [
    event("command.updated", { commandId, kind: "prompt", state: "accepted" }, { sessionId: "long" }),
    event("operation.updated", { operationId: "destination-op", kind: "run", status: "running", commandId }, destination),
    event("run.updated", { kind: "prompt", status: "running", phase: "thinking", source: "command", commandId }, destination)
  ] });
  expect(target()).toEqual({ session_id: "short", target_run_id: sourceRun });
  store.appendBatch({ sessionId: "long", workerEpoch: "destination", batchNo: 2, events: [
    event("command.updated", { commandId, kind: "prompt", state: "accepted", targetRunId: "destination-run" }, { sessionId: "long" })
  ] });
  expect(target()).toEqual({ session_id: "short", target_run_id: sourceRun });
  // Runtime replacement can rehome a command before dispatch; its old Session
  // still contains a causal mirror whose old target must no longer write SQL.
  database.prepare("UPDATE commands SET session_id = ?, target_run_id = ? WHERE id = ?").run("long", "destination-run", commandId);
  store.appendBatch({ sessionId: "short", workerEpoch: "source", batchNo: 3, events: [
    event("command.updated", { commandId, kind: "prompt", state: "accepted", targetRunId: sourceRun })
  ] });
  expect(target()).toEqual({ session_id: "long", target_run_id: "destination-run" });
  database.prepare("UPDATE commands SET target_run_id = NULL WHERE id = ?").run(commandId);
  store.appendBatch({ sessionId: "long", workerEpoch: "destination", batchNo: 3, events: [
    event("command.updated", { commandId, kind: "prompt", state: "accepted", targetRunId: "destination-run" }, { sessionId: "long" })
  ] });
  expect(target()).toEqual({ session_id: "long", target_run_id: "destination-run" });
});
