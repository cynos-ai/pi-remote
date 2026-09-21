import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  EventStore,
  IpcBatchConflictError,
  CommandRepository,
  OwnerRepository,
  DeviceRepository,
  ProjectRepository,
  SessionRepository,
  decodeHistoryCursor,
  loadReducerState,
  migrateDatabase,
  openServerDatabase,
  readEvents,
  readHistory,
  readSnapshot,
  validateArtifactRelativePath
} from "../../apps/server/src/storage/index.js";

const OWNER_A = "owner-a";
const DEVICE_A = "device-a";
const PROJECT_A = "project-a";
const SESSION_A = "11111111-1111-4111-8111-111111111111";
const SESSION_A2 = "session-a2";
const SESSION_INIT_FAILURE = "session-init-failure";
const SESSION_INPUT = "session-input";
const SESSION_NATIVE = "session-native";
const OWNER_B = "owner-b";
const DEVICE_B = "device-b";
const PROJECT_B = "project-b";
const SESSION_B = "session-b";
const FIXED_NOW = Date.parse("2026-09-12T08:00:00.000Z");
const CURSOR_SECRET = "s04-test-cursor-secret";

interface FixtureData {
  timestamp: string;
  sessionId?: string;
  runId?: string | null;
  operationId?: string | null;
  envelopeDefaults?: Record<string, unknown>;
  events?: Array<Record<string, unknown>>;
  scenarios?: Array<{
    sessionId: string;
    runId?: string | null;
    operationId?: string | null;
    events: Array<Record<string, unknown>>;
  }>;
}

interface TestDatabase {
  database: DatabaseSync;
  directory: string;
  filename: string;
}

const openTestDatabase = async (): Promise<TestDatabase> => {
  const directory = await mkdtemp(join(tmpdir(), "pi-remote-s04-"));
  const filename = join(directory, "state.sqlite");
  const database = await openServerDatabase({ filename, now: FIXED_NOW });
  return { database, directory, filename };
};

const closeTestDatabase = async ({ database, directory }: TestDatabase): Promise<void> => {
  database.close();
  await rm(directory, { recursive: true, force: true });
};

const seedOwner = (
  database: DatabaseSync,
  input: {
    ownerId: string;
    deviceId: string;
    projectId: string;
    sessionIds: string[];
    rootSuffix: string;
  }
): void => {
  new OwnerRepository(database).ensure({ id: input.ownerId, displayName: input.ownerId, now: FIXED_NOW });
  new DeviceRepository(database).create({
    id: input.deviceId,
    userId: input.ownerId,
    name: input.deviceId,
    token: `${input.ownerId}-token`,
    now: FIXED_NOW
  });
  new ProjectRepository(database).create({
    id: input.projectId,
    userId: input.ownerId,
    name: input.projectId,
    rootPath: `/tmp/pi-remote-s04/${input.rootSuffix}`,
    workspaceKey: `workspace:${input.rootSuffix}`,
    rootIdentity: `identity:${input.rootSuffix}`,
    now: FIXED_NOW - 1000
  });
  const sessions = new SessionRepository(database);
  for (const sessionId of input.sessionIds) {
    sessions.create({ id: sessionId, projectId: input.projectId, title: sessionId, now: FIXED_NOW - 1000 });
  }
};

const expandEvents = (
  fixture: FixtureData,
  events: Array<Record<string, unknown>>,
  context: { sessionId?: string; runId?: string | null; operationId?: string | null } = {}
): Array<Record<string, unknown>> => {
  const defaults = fixture.envelopeDefaults ?? {};
  return events.map((event) => ({
    ...event,
    schemaVersion: event.schemaVersion ?? defaults.schemaVersion ?? 1,
    sessionId: event.sessionId ?? context.sessionId ?? fixture.sessionId,
    runId: Object.hasOwn(event, "runId")
      ? event.runId
      : context.runId ?? fixture.runId ?? defaults.runId ?? null,
    operationId: Object.hasOwn(event, "operationId")
      ? event.operationId
      : context.operationId ?? fixture.operationId ?? defaults.operationId ?? null,
    timestamp: event.timestamp ?? fixture.timestamp
  }));
};

const loadFixture = async (name: string): Promise<FixtureData> =>
  JSON.parse(await readFile(resolve("docs/examples", name), "utf8")) as FixtureData;

const count = (database: DatabaseSync, table: string): number => {
  const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number | bigint };
  return Number(row.count);
};

describe("S04 SQLite storage contract", () => {
  const databases: TestDatabase[] = [];

  it("relocates an imported ID only with the expected old path, without relaxing startup mapping", async () => {
    const fixture = await openTestDatabase(); databases.push(fixture);
    seedOwner(fixture.database, { ownerId: OWNER_A, deviceId: DEVICE_A, projectId: PROJECT_A, sessionIds: [SESSION_A], rootSuffix: "import-cas" });
    const sessions = new SessionRepository(fixture.database);
    sessions.setPiMapping({ id: SESSION_A, piSessionId: "native-id", piSessionFile: "/old.jsonl", persistenceState: "persisted" });
    expect(() => sessions.setPiMapping({ id: SESSION_A, piSessionId: "native-id", piSessionFile: "/new.jsonl", persistenceState: "persisted" })).toThrow(/different pi mapping/);
    expect(() => sessions.rebindImportedHistory({ id: SESSION_A, piSessionId: "other-id", previousFile: "/old.jsonl", piSessionFile: "/new.jsonl" })).toThrow(/changed/);
    sessions.rebindImportedHistory({ id: SESSION_A, piSessionId: "native-id", previousFile: "/old.jsonl", piSessionFile: "/new.jsonl" });
    expect(sessions.getRow(SESSION_A)?.pi_session_file).toBe("/new.jsonl");
    expect(() => sessions.rebindImportedHistory({ id: SESSION_A, piSessionId: "native-id", previousFile: "/old.jsonl", piSessionFile: "/stale.jsonl" })).toThrow(/changed/);
  });

  afterEach(async () => {
    while (databases.length > 0) {
      const database = databases.pop();
      if (database) await closeTestDatabase(database);
    }
  });

  it("installs the versioned schema with durable connection settings and idempotent owner setup", async () => {
    const first = await openTestDatabase();
    databases.push(first);
    const database = first.database;

    expect(database.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 1 });
    expect(database.prepare("PRAGMA foreign_keys").get()).toMatchObject({ foreign_keys: 1 });
    expect(database.prepare("PRAGMA journal_mode").get()).toMatchObject({ journal_mode: "wal" });
    expect(database.prepare("PRAGMA synchronous").get()).toMatchObject({ synchronous: 2 });
    expect(database.prepare("PRAGMA busy_timeout").get()).toMatchObject({ timeout: 5000 });
    expect(count(database, "schema_migrations")).toBe(1);

    const owners = new OwnerRepository(database);
    expect(owners.ensure({ id: OWNER_A, displayName: "Owner A", now: FIXED_NOW })).toMatchObject({ id: OWNER_A });
    expect(owners.ensure({ id: OWNER_A, displayName: "changed", now: FIXED_NOW + 1 })).toMatchObject({
      id: OWNER_A,
      displayName: "Owner A",
      createdAt: FIXED_NOW
    });
    expect(count(database, "users")).toBe(1);

    database.close();
    databases.pop();
    const reopened = await openServerDatabase({ filename: first.filename, now: FIXED_NOW + 1 });
    databases.push({ ...first, database: reopened });
    expect(reopened.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 1 });
    expect(count(reopened, "schema_migrations")).toBe(1);
    expect(count(reopened, "users")).toBe(1);
    expect(new OwnerRepository(reopened).get(OWNER_A)).toMatchObject({ id: OWNER_A, displayName: "Owner A" });
  });

  it("upgrades the stable v1 timeline constraint for custom renderer entries without losing history", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(`
        CREATE TABLE projects(id TEXT PRIMARY KEY) STRICT;
        CREATE TABLE sessions(id TEXT PRIMARY KEY) STRICT;
        CREATE TABLE runs(id TEXT NOT NULL, session_id TEXT NOT NULL, UNIQUE(id, session_id)) STRICT;
        CREATE TABLE events(session_id TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY(session_id, seq)) STRICT;
        INSERT INTO sessions VALUES ('session');
        INSERT INTO events VALUES ('session', 1), ('session', 2), ('session', 3);
        CREATE TABLE timeline_items (
          session_id TEXT NOT NULL,
          item_id TEXT NOT NULL,
          operation_id TEXT NOT NULL,
          run_id TEXT,
          kind TEXT NOT NULL CHECK(kind IN ('message','tool')),
          completeness TEXT NOT NULL CHECK(completeness IN ('complete','partial')),
          end_reason TEXT CHECK(end_reason IN ('failed','aborted','interrupted')),
          ordinal_seq INTEGER NOT NULL,
          finalized_seq INTEGER NOT NULL CHECK(finalized_seq >= ordinal_seq),
          payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
          PRIMARY KEY(session_id, item_id),
          CHECK ((completeness = 'complete' AND end_reason IS NULL)
            OR (completeness = 'partial' AND end_reason IS NOT NULL))
        ) STRICT;
        CREATE INDEX timeline_page_idx ON timeline_items(session_id, ordinal_seq DESC, item_id);
        INSERT INTO timeline_items VALUES ('session', 'old-message', 'operation', NULL, 'message', 'complete', NULL, 1, 2, '{}');
        PRAGMA foreign_keys = ON;
        PRAGMA user_version = 1;
      `);
      migrateDatabase(database, FIXED_NOW);
      const table = database.prepare("SELECT sql FROM sqlite_master WHERE name = 'timeline_items'").get() as { sql: string };
      expect(table.sql).toContain("custom_entry");
      expect(count(database, "timeline_items")).toBe(1);
      database.prepare("INSERT INTO timeline_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        "session", "entry", "operation", null, "custom_entry", "complete", null, 3, 3, "{}"
      );
      expect(count(database, "timeline_items")).toBe(2);
      expect(database.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 1 });
    } finally {
      database.close();
    }
  });

  it("assigns per-session sequence numbers, stores projections, and deduplicates IPC batches", async () => {
    const testDatabase = await openTestDatabase();
    databases.push(testDatabase);
    const { database } = testDatabase;
    seedOwner(database, {
      ownerId: OWNER_A,
      deviceId: DEVICE_A,
      projectId: PROJECT_A,
      sessionIds: [SESSION_A],
      rootSuffix: "a"
    });
    const fixture = await loadFixture("stream.json");
    const events = expandEvents(fixture, fixture.events ?? [], { sessionId: SESSION_A });
    const store = new EventStore(database, {
      commandActor: { userId: OWNER_A, deviceId: DEVICE_A },
      now: () => FIXED_NOW
    });

    const first = store.appendBatch({ sessionId: SESSION_A, workerEpoch: "epoch-a", batchNo: 1, events: events.slice(0, 19) });
    expect(first).toMatchObject({ duplicate: false, firstSeq: 1, lastSeq: 19 });
    const snapshotAt16 = readSnapshot(database, SESSION_A, {
      historyCursor: null,
      availableThinkingLevels: [],
      allowedCommands: ["prompt"]
    });
    expect(snapshotAt16.snapshotSeq).toBe(19);
    expect(snapshotAt16.activeRun?.status).toBe("running");
    expect(snapshotAt16.liveItems.map((item) => item.itemId)).toEqual(["tool-1"]);
    expect(new SessionRepository(database).get(SESSION_A)).toMatchObject({
      status: "running",
      activeRunId: "22222222-2222-4222-8222-222222222222"
    });
    const historyAt16 = readHistory(database, SESSION_A, null, 1, CURSOR_SECRET);
    expect(historyAt16.atSeq).toBe(19);
    expect(historyAt16.items.map((item) => item.itemId)).toEqual(["assistant-1"]);
    const frozenCursor = historyAt16.nextCursor;
    if (!frozenCursor) throw new Error("expected a frozen history cursor");
    const second = store.appendBatch({ sessionId: SESSION_A, workerEpoch: "epoch-a", batchNo: 2, events: events.slice(19) });
    expect(second).toMatchObject({ duplicate: false, firstSeq: 20, lastSeq: 28 });
    const duplicate = store.appendBatch({ sessionId: SESSION_A, workerEpoch: "epoch-a", batchNo: 2, events: events.slice(19) });
    expect(duplicate).toMatchObject({ duplicate: true, firstSeq: 20, lastSeq: 28 });
    expect(duplicate.events).toEqual(second.events);
    expect(count(database, "events")).toBe(28);
    expect(count(database, "ipc_batches")).toBe(2);
    expect(() => store.appendBatch({
      sessionId: SESSION_A,
      workerEpoch: "epoch-a",
      batchNo: 2,
      events: events.slice(19).map((event, index) => index === 0
        ? { ...event, type: "runtime.notice", payload: { kind: "generic", message: "different batch" } }
        : event)
    })).toThrow(IpcBatchConflictError);
    expect(count(database, "events")).toBe(28);

    const projection = loadReducerState(database, SESSION_A);
    expect(projection.lastSeq).toBe(28);
    expect(projection.runs["22222222-2222-4222-8222-222222222222"]?.status).toBe("completed");
    expect(projection.timelineItems).toHaveLength(4);
    expect(projection.liveItems).toEqual({});
    const liveState = JSON.parse(String((database.prepare("SELECT live_state_json FROM sessions WHERE id = ?").get(SESSION_A) as { live_state_json: string }).live_state_json)) as Record<string, unknown>;
    expect(liveState.timelineItems).toBeUndefined();
    expect(liveState.metadataSync).toBeDefined();
    expect(projection.metadataSync).toMatchObject({
      title: { value: SESSION_A, version: 1, source: "server", eventSeq: 0 },
      pendingTitle: null,
      lastEchoSeq: null
    });
    expect(new SessionRepository(database).get(SESSION_A)).toMatchObject({
      status: "idle",
      activeRunId: null,
      lastMessagePreview: "两项检查完成。"
    });
    expect(database.prepare("SELECT state, target_run_id FROM commands WHERE id = ?").get(
      "33333333-3333-4333-8333-333333333333"
    )).toMatchObject({ state: "completed", target_run_id: null });
    expect(database.prepare("SELECT status, operation_id FROM runs WHERE id = ?").get(
      "22222222-2222-4222-8222-222222222222"
    )).toMatchObject({ status: "completed", operation_id: "34444444-4444-4444-8444-444444444444" });
    expect(database.prepare("SELECT last_activity_at FROM projects WHERE id = ?").get(PROJECT_A)).toMatchObject({
      last_activity_at: FIXED_NOW
    });

    const page = readEvents(database, SESSION_A, 0, 5);
    expect(page.events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(page.throughSeq).toBe(5);
    expect(page.hasMore).toBe(true);
    const snapshot = readSnapshot(database, SESSION_A, {
      historyCursor: null,
      availableThinkingLevels: ["low", "high"],
      allowedCommands: ["prompt", "follow_up"]
    });
    expect(snapshot.snapshotSeq).toBe(28);
    expect(snapshot.activeRun).toBeNull();
    expect(snapshot.activeOperations).toEqual([]);
    expect(snapshot.items).toHaveLength(4);
    expect(snapshot.items.find((item) => item.itemId === "tool-1")).toMatchObject({ completeness: "complete" });
    expect(snapshot.availableThinkingLevels).toEqual(["low", "high"]);
    const frozenSecondPage = readHistory(database, SESSION_A, frozenCursor, 10, CURSOR_SECRET);
    expect(frozenSecondPage.atSeq).toBe(19);
    expect(frozenSecondPage.items.map((item) => item.itemId)).toEqual(["user-1"]);
    expect(frozenSecondPage.items.some((item) => item.itemId === "tool-1" || item.itemId === "assistant-2")).toBe(false);

    database.close();
    databases.pop();
    const reopened = await openServerDatabase({ filename: testDatabase.filename, now: FIXED_NOW + 1 });
    databases.push({ ...testDatabase, database: reopened });
    expect(readSnapshot(reopened, SESSION_A, {
      historyCursor: null,
      availableThinkingLevels: ["low", "high"],
      allowedCommands: ["prompt", "follow_up"]
    })).toEqual(snapshot);
  });

  it("stores partial history, no-run content, input recovery, and fixed-boundary pages", async () => {
    const testDatabase = await openTestDatabase();
    databases.push(testDatabase);
    const { database } = testDatabase;
    seedOwner(database, {
      ownerId: OWNER_A,
      deviceId: DEVICE_A,
      projectId: PROJECT_A,
      sessionIds: [SESSION_A, SESSION_A2, SESSION_INIT_FAILURE, SESSION_INPUT, SESSION_NATIVE],
      rootSuffix: "a"
    });
    const store = new EventStore(database, {
      commandActor: { userId: OWNER_A, deviceId: DEVICE_A },
      now: () => FIXED_NOW
    });
    const interrupted = await loadFixture("interrupted.json");
    const interruptedScenario = interrupted.scenarios?.[0];
    if (!interruptedScenario) throw new Error("missing interrupted fixture scenario");
    const interruptedEvents = expandEvents(interrupted, interruptedScenario.events, {
      ...interruptedScenario,
      sessionId: SESSION_A
    });
    await store.appendBatch({ sessionId: SESSION_A, workerEpoch: "epoch-partial", batchNo: 1, events: interruptedEvents });
    const partialSnapshot = readSnapshot(database, SESSION_A);
    expect(partialSnapshot.snapshotSeq).toBe(12);
    expect(partialSnapshot.queue.state).toBe("paused");
    expect(partialSnapshot.queue.items).toHaveLength(1);
    expect(partialSnapshot.items).toHaveLength(2);
    expect(partialSnapshot.items.find((item) => item.itemId === "long-tool")).toMatchObject({
      completeness: "partial",
      endReason: "interrupted"
    });
    expect(partialSnapshot.liveItems).toEqual([]);
    expect(database.prepare("SELECT status, error_code FROM runs WHERE id = ?").get(
      "42222222-2222-4222-8222-222222222222"
    )).toMatchObject({ status: "interrupted", error_code: "WORKER_EXITED" });

    const initialization = await loadFixture("initialization-dialog.json");
    await store.appendBatch({
      sessionId: SESSION_A2,
      workerEpoch: "epoch-initialize",
      batchNo: 1,
      events: expandEvents(initialization, initialization.events ?? [], { sessionId: SESSION_A2 })
    });
    const initializationSnapshot = readSnapshot(database, SESSION_A2);
    expect(initializationSnapshot.activeRun).toBeNull();
    expect(initializationSnapshot.pendingInteractions).toEqual([]);
    expect(database.prepare("SELECT run_id, status, response_json FROM interactions WHERE id = ?").get(
      "63333333-3333-4333-8333-333333333333"
    )).toMatchObject({ run_id: null, status: "resolved", response_json: JSON.stringify({ confirmed: true }) });

    await store.appendBatch({
      sessionId: SESSION_INIT_FAILURE,
      workerEpoch: "epoch-initialize-failure",
      batchNo: 1,
      events: [
        {
          schemaVersion: 1,
          sessionId: SESSION_INIT_FAILURE,
          seq: 1,
          runId: null,
          operationId: "initialize-failure-operation",
          type: "operation.updated",
          timestamp: "2026-09-12T08:00:00.000Z",
          payload: { operationId: "initialize-failure-operation", kind: "configure", status: "running" }
        },
        {
          schemaVersion: 1,
          sessionId: SESSION_INIT_FAILURE,
          seq: 2,
          runId: null,
          operationId: "initialize-failure-operation",
          type: "interaction.requested",
          timestamp: "2026-09-12T08:00:00.000Z",
          payload: {
            interactionId: "initialize-failure-interaction",
            operationId: "initialize-failure-operation",
            origin: "configure",
            kind: "input",
            title: "configuration"
          }
        },
        {
          schemaVersion: 1,
          sessionId: SESSION_INIT_FAILURE,
          seq: 3,
          runId: null,
          operationId: "initialize-failure-operation",
          type: "operation.updated",
          timestamp: "2026-09-12T08:00:01.000Z",
          payload: {
            operationId: "initialize-failure-operation",
            kind: "configure",
            status: "failed",
            error: { code: "CONFIGURATION_FAILED" }
          }
        },
        {
          schemaVersion: 1,
          sessionId: SESSION_INIT_FAILURE,
          seq: 4,
          runId: null,
          operationId: null,
          type: "session.updated",
          timestamp: "2026-09-12T08:00:02.000Z",
          payload: { changes: { title: "renamed after failure", version: 2 } }
        }
      ]
    });
    expect(database.prepare("SELECT status, response_json FROM interactions WHERE id = ?").get(
      "initialize-failure-interaction"
    )).toMatchObject({ status: "cancelled", response_json: null });
    expect(readSnapshot(database, SESSION_INIT_FAILURE).pendingInteractions).toEqual([]);
    expect(loadReducerState(database, SESSION_INIT_FAILURE).metadataSync.title).toEqual({
      value: "renamed after failure",
      version: 2,
      source: "unknown",
      eventSeq: 4
    });
    expect(new SessionRepository(database).get(SESSION_INIT_FAILURE)).toMatchObject({
      title: "renamed after failure",
      version: 2,
      status: "failed"
    });

    const native = await loadFixture("native-runtime.json");
    const inputScenario = native.scenarios?.[2];
    const independentScenario = native.scenarios?.[0];
    if (!inputScenario || !independentScenario) throw new Error("missing native runtime fixture scenarios");
    await store.appendBatch({
      sessionId: SESSION_INPUT,
      workerEpoch: "epoch-input",
      batchNo: 1,
      events: expandEvents(native, inputScenario.events, { ...inputScenario, sessionId: SESSION_INPUT })
    });
    const inputSnapshot = readSnapshot(database, SESSION_INPUT);
    expect(inputSnapshot.recoveredInputs).toHaveLength(2);
    expect(inputSnapshot.recoveredInputs[0]?.content.attachments).toEqual([
      { artifactId: "55b3b5f9-c573-5f83-bad9-fea2707025a4", mimeType: "image/png" }
    ]);
    await store.appendBatch({
      sessionId: SESSION_NATIVE,
      workerEpoch: "epoch-native",
      batchNo: 1,
      events: expandEvents(native, independentScenario.events, { ...independentScenario, sessionId: SESSION_NATIVE })
    });
    const nativeSnapshot = readSnapshot(database, SESSION_NATIVE);
    expect(nativeSnapshot.activeRun).toBeNull();
    expect(nativeSnapshot.items.map((item) => item.itemId)).toEqual([
      "custom-delayed",
      "bash-complete",
      "bash-partial",
      "custom-partial",
      "parallel-assistant"
    ]);
    expect(Object.values(nativeSnapshot.items).filter((item) => item.runId === null)).toHaveLength(4);

    const stream = await loadFixture("stream.json");
    const streamEvents = expandEvents(stream, stream.events ?? [], { sessionId: SESSION_A2 });
    await store.appendBatch({ sessionId: SESSION_A2, workerEpoch: "epoch-history", batchNo: 2, events: streamEvents });
    const firstPage = readHistory(database, SESSION_A2, null, 2, CURSOR_SECRET);
    expect(firstPage.atSeq).toBe(34);
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.nextCursor).toBeTypeOf("string");
    const cursor = firstPage.nextCursor;
    if (!cursor) throw new Error("expected a history cursor");

    await store.appendBatch({
      sessionId: SESSION_A2,
      workerEpoch: "epoch-history",
      batchNo: 3,
      events: [{
        schemaVersion: 1,
        sessionId: SESSION_A2,
        seq: 999,
        runId: null,
        operationId: null,
        type: "runtime.notice",
        timestamp: "2026-09-12T08:01:00.000Z",
        payload: { kind: "generic", message: "after snapshot" }
      }]
    });
    const secondPage = readHistory(database, SESSION_A2, cursor, 2, CURSOR_SECRET);
    expect(secondPage.atSeq).toBe(34);
    expect(new Set(secondPage.items.map((item) => item.itemId)).size).toBe(secondPage.items.length);
    expect(secondPage.items.every((item) => item.finalizedSeq <= 34)).toBe(true);
    expect(() => readHistory(database, SESSION_A2, `${cursor.slice(0, -1)}x`, 2, CURSOR_SECRET)).toThrow();
    expect(() => readHistory(database, SESSION_A, cursor, 2, CURSOR_SECRET)).toThrow(/another session/);
    expect(() => decodeHistoryCursor(cursor, "wrong-secret")).toThrow();
  });

  it("rolls back events, sequence allocation, and projections together on a late write failure", async () => {
    const testDatabase = await openTestDatabase();
    databases.push(testDatabase);
    const { database } = testDatabase;
    seedOwner(database, {
      ownerId: OWNER_A,
      deviceId: DEVICE_A,
      projectId: PROJECT_A,
      sessionIds: [SESSION_A],
      rootSuffix: "a"
    });
    const fixture = await loadFixture("stream.json");
    const events = expandEvents(fixture, fixture.events ?? [], { sessionId: SESSION_A });
    const store = new EventStore(database, {
      commandActor: { userId: OWNER_A, deviceId: DEVICE_A },
      now: () => FIXED_NOW
    });
    database.exec("CREATE TRIGGER s04_fail_batch BEFORE INSERT ON ipc_batches BEGIN SELECT RAISE(ABORT, 'injected S04 failure'); END");
    expect(() => store.appendBatch({ sessionId: SESSION_A, workerEpoch: "epoch-rollback", batchNo: 1, events })).toThrow("injected S04 failure");
    expect(count(database, "events")).toBe(0);
    expect(count(database, "ipc_batches")).toBe(0);
    expect(count(database, "commands")).toBe(0);
    expect(count(database, "runs")).toBe(0);
    expect(count(database, "timeline_items")).toBe(0);
    expect(database.prepare("SELECT last_event_seq FROM sessions WHERE id = ?").get(SESSION_A)).toMatchObject({ last_event_seq: 0 });
    expect(database.prepare("SELECT last_activity_at FROM projects WHERE id = ?").get(PROJECT_A)).toMatchObject({
      last_activity_at: FIXED_NOW - 1000
    });

    database.exec("DROP TRIGGER s04_fail_batch");
    const committed = store.appendBatch({ sessionId: SESSION_A, workerEpoch: "epoch-rollback", batchNo: 1, events });
    expect(committed).toMatchObject({ duplicate: false, firstSeq: 1, lastSeq: 28 });
  });

  it("allows same-owner cross-session causal runs but rejects cross-owner causal references", async () => {
    const testDatabase = await openTestDatabase();
    databases.push(testDatabase);
    const { database } = testDatabase;
    seedOwner(database, {
      ownerId: OWNER_A,
      deviceId: DEVICE_A,
      projectId: PROJECT_A,
      sessionIds: [SESSION_A, SESSION_A2],
      rootSuffix: "a"
    });
    seedOwner(database, {
      ownerId: OWNER_B,
      deviceId: DEVICE_B,
      projectId: PROJECT_B,
      sessionIds: [SESSION_B],
      rootSuffix: "b"
    });
    const commandId = "causal-command";
    const operationIdA = "causal-operation-a";
    const runIdA = "causal-run-a";
    const operationIdB = "causal-operation-b";
    const runIdB = "causal-run-b";
    const commandEvent = {
      schemaVersion: 1,
      sessionId: SESSION_A,
      seq: 1,
      runId: null,
      operationId: null,
      type: "command.updated",
      timestamp: "2026-09-12T08:00:00.000Z",
      payload: { commandId, kind: "prompt", state: "queued" }
    };
    const storeA = new EventStore(database, { commandActor: { userId: OWNER_A, deviceId: DEVICE_A }, now: () => FIXED_NOW });
    await storeA.appendBatch({ sessionId: SESSION_A, workerEpoch: "epoch-causal-a", batchNo: 1, events: [commandEvent] });
    await storeA.appendBatch({
      sessionId: SESSION_A2,
      workerEpoch: "epoch-causal-a2",
      batchNo: 1,
      events: [
        {
          ...commandEvent,
          sessionId: SESSION_A2,
          operationId: operationIdA,
          runId: runIdA,
          type: "operation.updated",
          payload: { operationId: operationIdA, kind: "run", status: "running", commandId }
        },
        {
          ...commandEvent,
          sessionId: SESSION_A2,
          operationId: operationIdA,
          runId: runIdA,
          type: "run.updated",
          payload: { kind: "prompt", status: "running", phase: "thinking", source: "command", commandId }
        }
      ]
    });
    expect(database.prepare("SELECT session_id, user_id FROM commands WHERE id = ?").get(commandId)).toMatchObject({
      session_id: SESSION_A,
      user_id: OWNER_A
    });
    expect(database.prepare("SELECT session_id, command_id FROM runs WHERE id = ?").get(runIdA)).toMatchObject({
      session_id: SESSION_A2,
      command_id: commandId
    });

    const storeB = new EventStore(database, { commandActor: { userId: OWNER_B, deviceId: DEVICE_B }, now: () => FIXED_NOW });
    expect(() => storeB.appendBatch({
      sessionId: SESSION_B,
      workerEpoch: "epoch-causal-b",
      batchNo: 1,
      events: [
        {
          ...commandEvent,
          sessionId: SESSION_B,
          operationId: operationIdB,
          runId: runIdB,
          type: "operation.updated",
          payload: { operationId: operationIdB, kind: "run", status: "running", commandId }
        },
        {
          ...commandEvent,
          sessionId: SESSION_B,
          operationId: operationIdB,
          runId: runIdB,
          type: "run.updated",
          payload: { kind: "prompt", status: "running", phase: "thinking", source: "command", commandId }
        }
      ]
    })).toThrow(/owner/);
    expect(database.prepare("SELECT last_event_seq FROM sessions WHERE id = ?").get(SESSION_B)).toMatchObject({ last_event_seq: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM runs WHERE id IN (?, ?)").get(runIdA, runIdB)).toMatchObject({ count: 1 });
    expect(() => new CommandRepository(database).create({
      userId: OWNER_A,
      deviceId: DEVICE_A,
      sessionId: SESSION_B,
      scope: "POST:/v1/sessions/session-b/commands",
      clientCommandId: "command-owner-check",
      kind: "prompt",
      payload: { text: "must fail" }
    })).toThrow(/owner/);
  });

  it("accepts only safe artifact paths and rejects traversal or invalid metadata", async () => {
    expect(validateArtifactRelativePath("outputs/report.txt")).toBe("outputs/report.txt");
    for (const unsafe of ["", ".", "../report.txt", "outputs/../report.txt", "outputs//report.txt", "./report.txt", "/tmp/report.txt", "C:/report.txt", "outputs\\report.txt"]) {
      expect(() => validateArtifactRelativePath(unsafe)).toThrow();
    }
  });
});
