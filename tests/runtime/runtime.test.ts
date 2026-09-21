import { EventEmitter } from "node:events";
import { access, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DeviceRepository,
  EventStore,
  OwnerRepository,
  ProjectRepository,
  SessionRepository,
  CommandRepository,
  openServerDatabase,
  loadReducerState
} from "../../apps/server/src/storage/index.js";
import {
  IpcLineDecoder,
  IpcProtocolError,
  MAX_IPC_FRAME_BYTES,
  WorkerIpcChannel,
  cleanupExpiredWorkerSpoolTemps,
  decodeWorkerInbound,
  decodeWorkerOutbound,
  encodeIpcMessage,
  makeIpcEnvelope
} from "../../apps/server/src/runtime/index.js";
import {
  WorkerManager,
  type SpawnWorkerInput,
  type WorkerManagerOptions
} from "../../apps/server/src/runtime/index.js";
import {
  RecoveryManager
} from "../../apps/server/src/runtime/index.js";
import { assertInstanceStopped } from "../../apps/server/src/maintenance.js";
import { Scheduler } from "../../apps/server/src/runtime/index.js";
import {
  PiWorker,
  runWorkerProcess,
  type WorkerInboundMessage,
  type WorkerOutboundMessage,
  type WorkerSessionFactory
} from "../../packages/agent-pi/src/worker.js";
import { encodeSpooledOutbound } from "../../packages/agent-pi/src/outbound-spool.js";
import { CommandService } from "../../apps/server/src/services/commands.js";
import type { AuthContext } from "../../apps/server/src/auth.js";
import { inspectPiSessionFile } from "../../packages/agent-pi/src/session-file.js";

const NOW = Date.parse("2026-09-13T00:00:00.000Z");
const OWNER = "runtime-owner";
const DEVICE = "runtime-device";
const PROJECT = "runtime-project";
const SESSION_A = "runtime-session-a";
const SESSION_B = "runtime-session-b";

interface TestDatabase {
  database: DatabaseSync;
  directory: string;
  projectPath: string;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function testDatabase(sessionIds: string[] = [SESSION_A], workspaceKey = "runtime-workspace"): Promise<TestDatabase> {
  const directory = await mkdtemp(join(tmpdir(), "pi-remote-s06-"));
  const projectPath = join(directory, "project");
  const database = await openServerDatabase({ filename: join(directory, "state.sqlite"), now: NOW });
  new OwnerRepository(database).ensure({ id: OWNER, displayName: OWNER, now: NOW });
  new DeviceRepository(database).create({
    id: DEVICE,
    userId: OWNER,
    name: DEVICE,
    token: "runtime-test-token",
    now: NOW
  });
  new ProjectRepository(database).create({
    id: PROJECT,
    userId: OWNER,
    name: PROJECT,
    rootPath: projectPath,
    workspaceKey,
    rootIdentity: `runtime-identity-${workspaceKey}`,
    now: NOW
  });
  const sessions = new SessionRepository(database);
  for (const sessionId of sessionIds) sessions.create({ id: sessionId, projectId: PROJECT, title: sessionId, now: NOW });
  const result = { database, directory, projectPath };
  cleanups.push(async () => {
    database.close();
    await rm(directory, { recursive: true, force: true });
  });
  return result;
}

function eventEnvelope(
  sessionId: string,
  seq: number,
  type: string,
  payload: unknown,
  runId: string | null = null,
  operationId: string | null = null
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    sessionId,
    seq,
    runId,
    operationId,
    type,
    timestamp: new Date(NOW).toISOString(),
    payload
  };
}

function appendEvents(database: DatabaseSync, sessionId: string, events: Array<Record<string, unknown>>, workerEpoch = "epoch-old"): void {
  new EventStore(database, {
    commandActor: { userId: OWNER, deviceId: DEVICE },
    now: () => NOW
  }).appendBatch({ sessionId, workerEpoch, batchNo: 1, events });
}

function outbound<TType extends WorkerOutboundMessage["type"]>(
  child: FakeChild,
  type: TType,
  payload: Extract<WorkerOutboundMessage, { type: TType }>["payload"],
  sessionId = child.sessionId,
  workerEpoch = child.workerEpoch
): void {
  child.stdout.write(`${JSON.stringify(makeIpcEnvelope(sessionId, workerEpoch, type, payload))}\n`);
}

type InboundHandler = (message: WorkerInboundMessage, child: FakeChild) => void;

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid: number;
  readonly executed: WorkerInboundMessage[] = [];
  sessionId = "";
  workerEpoch = "";
  killed = false;
  private pending = "";

  constructor(pid: number, private readonly onInbound: InboundHandler = () => undefined) {
    super();
    this.pid = pid;
    this.stdin.on("data", (chunk: Buffer | string) => {
      this.pending += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      let newline = this.pending.indexOf("\n");
      while (newline >= 0) {
        const line = this.pending.slice(0, newline).trim();
        this.pending = this.pending.slice(newline + 1);
        if (line.length > 0) {
          const message = decodeWorkerInbound(JSON.parse(line) as unknown);
          if (message.type === "initialize") {
            this.sessionId = message.sessionId;
            this.workerEpoch = message.workerEpoch;
          }
          if (message.type === "execute") this.executed.push(message);
          this.onInbound(message, this);
        }
        newline = this.pending.indexOf("\n");
      }
    });
  }

  kill(): boolean {
    this.killed = true;
    this.emit("exit", null, "SIGTERM");
    return true;
  }
}

function managerFor(
  database: DatabaseSync,
  directory: string,
  spawnWorker: (input: SpawnWorkerInput) => FakeChild,
  options: Partial<WorkerManagerOptions> = {}
): WorkerManager {
  const manager = new WorkerManager(database, {
    stateDir: directory,
    instanceLockPath: join(directory, "instance.lock"),
    mappingTimeoutMs: 1_000,
    autoRecover: false,
    spawnWorker: (input) => spawnWorker(input) as unknown as ChildProcessWithoutNullStreams,
    ...options
  });
  cleanups.push(async () => manager.stop());
  manager.start();
  return manager;
}

function sessionMappingHandler(message: WorkerInboundMessage, child: FakeChild): void {
  if (message.type === "initialize") {
    outbound(child, "session_mapping", {
      piSessionId: `pi-${message.sessionId}`,
      piSessionFile: join(message.payload.cwd, `${message.sessionId}.jsonl`),
      persistenceState: "unflushed",
      fileState: "missing"
    });
  } else if (message.type === "session_mapping_ack") {
    outbound(child, "ready", {
      pid: child.pid,
      processGroupId: null,
      workerStartTicks: null,
      persistenceState: "unflushed"
    });
  } else if (message.type === "shutdown") {
    outbound(child, "stopped", { reason: message.payload.reason ?? "shutdown" });
    queueMicrotask(() => child.emit("exit", 0, null));
  }
}

describe("S06 scheduler and IPC contracts", () => {
  it("never spills oversized authentication displays to the worker spool", () => {
    const display = { ipcVersion: 1, sessionId: "session", workerEpoch: "epoch", type: "auth_display", payload: { appSessionId: "session", operationId: "op", display: { operationId: "op", title: "OAuth", links: [] } } };
    expect(decodeWorkerOutbound(JSON.parse(encodeSpooledOutbound(display, { spoolDir: "unused" })))).toEqual(display);
    expect(() => encodeSpooledOutbound({ ipcVersion: 1, sessionId: "session", workerEpoch: "epoch", type: "auth_display", payload: { secret: "x".repeat(2048) } }, { spoolDir: "unused", maxFrameBytes: 1024 })).toThrow("in-memory IPC frame limit");
  });
  it("round-trips import intents and rejects unknown replacement kinds", () => {
    const message = makeIpcEnvelope("session", "epoch", "session_replace_intent", {
      requestId: "import", kind: "import" as const, piSessionId: "source", piSessionFile: "/tmp/source.jsonl", targetFile: "/tmp/import.jsonl"
    });
    expect(decodeWorkerOutbound(JSON.parse(encodeIpcMessage(message)))).toEqual(message);
    expect(() => decodeWorkerOutbound({ ...message, payload: { ...message.payload, kind: "unknown" } })).toThrow(IpcProtocolError);
  });
  it("round-trips long native input and diagnostics without the identity-length cap", () => {
    const text = "开发上下文".repeat(1000);
    const execute = makeIpcEnvelope("session", "epoch", "execute", { commandId: "command", operationId: "operation", kind: "prompt" as const, text });
    expect(decodeWorkerInbound(JSON.parse(encodeIpcMessage(execute)))).toMatchObject({ payload: { text } });
    const bash = makeIpcEnvelope("session", "epoch", "execute", { commandId: "bash", operationId: "operation", kind: "bash" as const, command: "printf '%s' " + "x".repeat(20_000) });
    expect(decodeWorkerInbound(JSON.parse(encodeIpcMessage(bash)))).toEqual(bash);
    const compact = makeIpcEnvelope("session", "epoch", "execute", { commandId: "compact", operationId: "operation", kind: "compact" as const, instructions: text });
    expect(decodeWorkerInbound(JSON.parse(encodeIpcMessage(compact)))).toEqual(compact);
    for (const kind of ["steer", "follow_up"] as const) {
      const input = makeIpcEnvelope("session", "epoch", kind, { inputId: "input", text, content: { text } });
      expect(decodeWorkerInbound(JSON.parse(encodeIpcMessage(input)))).toEqual(input);
    }
    const diagnostic = makeIpcEnvelope("session", "epoch", "extension_error", { extensionPath: "/test/extension.ts", event: "session_start", error: "failure ".repeat(200), stack: "at extension()\n".repeat(200) });
    expect(decodeWorkerOutbound(JSON.parse(encodeIpcMessage(diagnostic)))).toEqual(diagnostic);
    expect(() => decodeWorkerInbound({ ...execute, payload: { ...execute.payload, text: "界".repeat(30_000) } })).toThrow(/byte limit/);
  });

  it("keeps default runs parallel across Sessions and makes workspace serialization opt-in", () => {
    const scheduler = new Scheduler();
    expect(scheduler.acquireRun({ sessionId: SESSION_A, workspaceKey: "same" }).sessionId).toBe(SESSION_A);
    expect(scheduler.acquireRun({ sessionId: SESSION_B, workspaceKey: "same" }).sessionId).toBe(SESSION_B);
    expect(() => scheduler.acquireRun({ sessionId: SESSION_A, workspaceKey: "same" })).toThrowError(/already has an active/);

    const serialized = new Scheduler({ serializeWorkspace: true });
    const lease = serialized.acquireRun({ sessionId: SESSION_A, workspaceKey: "same" });
    expect(() => serialized.acquireRun({ sessionId: SESSION_B, workspaceKey: "same" })).toThrowError(/workspace/);
    serialized.releaseRun(lease);
    expect(serialized.acquireRun({ sessionId: SESSION_B, workspaceKey: "same" }).sessionId).toBe(SESSION_B);
  });

  it("tracks idle workers without reaping active calls or pending interactions", () => {
    const scheduler = new Scheduler();
    scheduler.registerWorker({ workerId: SESSION_A, sessionId: SESSION_A, workspaceKey: "w" }, 100);
    expect(scheduler.canReapWorker(SESSION_A, 200, 50)).toBe(true);
    scheduler.updateWorkerActivity(SESSION_A, { activeCall: true }, 200);
    expect(scheduler.canReapWorker(SESSION_A, 1_000, 50)).toBe(false);
    scheduler.updateWorkerActivity(SESSION_A, { activeCall: false, pendingInteractions: 1 }, 300);
    expect(scheduler.canReapWorker(SESSION_A, 1_000, 50)).toBe(false);
    scheduler.updateWorkerActivity(SESSION_A, { pendingInteractions: 0, lastActivityAt: 950 }, 950);
    expect(scheduler.canReapWorker(SESSION_A, 1_000, 50)).toBe(true);
  });

  it("rejects malformed frames, enforces the line limit, and accepts only typed event batches", () => {
    const valid = makeIpcEnvelope("session", "epoch", "heartbeat", { pid: 1, at: new Date(NOW).toISOString(), active: false });
    expect(decodeWorkerOutbound(valid)).toMatchObject({ type: "heartbeat" });
    expect(() => decodeWorkerInbound({ ...valid, type: "unknown" })).toThrow(IpcProtocolError);
    expect(() => decodeWorkerOutbound({ ...valid, type: "event_batch", payload: { batchNo: 1, events: [] } })).toThrow(/batch size/);
    expect(() => decodeWorkerOutbound({ ...valid, ipcVersion: 999 })).toThrow(/version/);
    expect(() => encodeIpcMessage(makeIpcEnvelope("s", "e", "execute", {
      commandId: "c",
      operationId: "o",
      kind: "prompt" as const,
      text: "x"
    }))).not.toThrow();
    expect(MAX_IPC_FRAME_BYTES).toBeGreaterThan(64 * 1024);

    const decoder = new IpcLineDecoder(8);
    expect(() => decoder.push("123456789")).toThrow(/frame limit/);
    const invalidDecoder = new IpcLineDecoder(100);
    const invalidLine = invalidDecoder.push("{bad}\n")[0];
    expect(invalidLine).toBe("{bad}");
    expect(() => decodeWorkerOutbound(JSON.parse(invalidLine ?? "{}") as unknown)).toThrow();
  });

  it("delivers a valid outbound frame through WorkerIpcChannel and reports a broken stream", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const received: WorkerOutboundMessage[] = [];
    const errors: Error[] = [];
    new WorkerIpcChannel({
      input,
      output,
      onMessage: (message) => { received.push(message); },
      onError: (error) => { errors.push(error); }
    });
    input.write(`${JSON.stringify(makeIpcEnvelope("s", "e", "heartbeat", {
      pid: 1,
      at: new Date(NOW).toISOString(),
      active: false
    }))}\n`);
    await vi.waitFor(() => expect(received).toHaveLength(1));
    input.write("not-json\n");
    await vi.waitFor(() => expect(errors).toHaveLength(1));
  });

  it("passes transport spool basenames to the commit boundary", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const contexts: string[][] = [];
    new WorkerIpcChannel({
      input,
      output,
      getOutboundSpoolFiles: () => ["transport.json"],
      onMessage: (_message, context) => { contexts.push([...context.outboundSpoolFiles]); }
    });
    input.write(`${JSON.stringify(makeIpcEnvelope("s", "e", "heartbeat", {
      pid: 1,
      at: new Date(NOW).toISOString(),
      active: false
    }))}\n`);
    await vi.waitFor(() => expect(contexts).toEqual([["transport.json"]]));
  });

  it("cleans only expired temporary worker-spool files", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "pi-remote-spool-cleanup-"));
    cleanups.push(async () => rm(stateDir, { recursive: true, force: true }));
    const backlog = join(stateDir, "worker-spool", "epoch", "backlog");
    await mkdir(backlog, { recursive: true });
    const stale = join(backlog, "stale.json.tmp");
    const fresh = join(backlog, "fresh.json.tmp");
    const durable = join(backlog, "durable.json");
    await Promise.all([writeFile(stale, "stale"), writeFile(fresh, "fresh"), writeFile(durable, "durable")]);
    const staleAt = new Date(NOW - 120_000);
    await utimes(stale, staleAt, staleAt);
    expect(cleanupExpiredWorkerSpoolTemps(stateDir, NOW, 60_000)).toBe(1);
    await expect(access(stale)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(fresh)).resolves.toBeUndefined();
    await expect(access(durable)).resolves.toBeUndefined();
    expect(await readdir(backlog)).toEqual(expect.arrayContaining(["fresh.json.tmp", "durable.json"]));
  });

  it("removes a large transport frame only after event persistence and batch ACK", async () => {
    const fixture = await testDatabase();
    let child: FakeChild | undefined;
    const manager = managerFor(fixture.database, fixture.directory, () => {
      child = new FakeChild(4402, sessionMappingHandler);
      return child!;
    });
    await manager.load(SESSION_A);
    if (!child) throw new Error("fake worker was not created");
    const spoolDir = join(fixture.directory, "worker-spool", child.workerEpoch);
    const frame = makeIpcEnvelope(SESSION_A, child.workerEpoch, "event_batch", {
      batchNo: 1,
      events: [eventEnvelope(SESSION_A, 1, "runtime.notice", { kind: "generic", message: `spooled frame ${"x".repeat(2_000)}` })]
    });
    const encoded = encodeSpooledOutbound(frame, { spoolDir, maxFrameBytes: 1_024 });
    const reference = JSON.parse(encoded) as { payload: { fileName: string } };
    await expect(access(join(spoolDir, reference.payload.fileName))).resolves.toBeUndefined();
    child.stdout.write(`${encoded}\n`);
    await vi.waitFor(() => expect(fixture.database.prepare("SELECT COUNT(*) AS count FROM events WHERE type = 'runtime.notice'").get()?.count).toBe(1));
    await vi.waitFor(() => expect(access(join(spoolDir, reference.payload.fileName))).rejects.toMatchObject({ code: "ENOENT" }));
    expect(child.executed).toEqual([]);
  });
});

describe("S06 recovery policy", () => {
  it("recovers multiple Sessions without reusing the same IPC batch identity", async () => {
    const fixture = await testDatabase([SESSION_A, SESSION_B]);
    for (const sessionId of [SESSION_A, SESSION_B]) {
      appendEvents(fixture.database, sessionId, [eventEnvelope(sessionId, 1, "operation.updated", { operationId: `operation-${sessionId}`, kind: "extension", status: "running" }, null, `operation-${sessionId}`)], `worker-${sessionId}`);
    }
    const recovery = new RecoveryManager(fixture.database, { now: () => NOW });
    const reports = recovery.recoverAll("same-recovery-epoch");
    expect(reports).toHaveLength(2);
    expect(reports.every((report) => report.appendedEvents > 0)).toBe(true);
    for (const sessionId of [SESSION_A, SESSION_B]) {
      expect(loadReducerState(fixture.database, sessionId).operations[`operation-${sessionId}`]?.status).toBe("interrupted");
    }
    expect(recovery.recoverAll("same-recovery-epoch").every((report) => report.appendedEvents === 0)).toBe(true);
  });

  it("interrupts an active Run, seals its partial content, and is idempotent", async () => {
    const fixture = await testDatabase();
    appendEvents(fixture.database, SESSION_A, [
      eventEnvelope(SESSION_A, 1, "operation.updated", {
        operationId: "operation-active",
        kind: "run",
        status: "running",
        runId: "run-active"
      }, "run-active", "operation-active"),
      eventEnvelope(SESSION_A, 2, "run.updated", {
        kind: "prompt",
        status: "running",
        phase: "model",
        source: "runtime"
      }, "run-active", "operation-active")
    ]);
    const recovery = new RecoveryManager(fixture.database, { now: () => NOW });
    const first = recovery.recoverSession(SESSION_A, "recovery-epoch");
    expect(first.interruptedRunIds).toEqual(["run-active"]);
    expect(first.interruptedOperationIds).toEqual(["operation-active"]);
    expect(first.appendedEvents).toBe(3);
    expect(loadReducerState(fixture.database, SESSION_A).runs["run-active"]?.status).toBe("interrupted");
    expect(loadReducerState(fixture.database, SESSION_A).operations["operation-active"]?.status).toBe("interrupted");
    expect(recovery.recoverSession(SESSION_A, "recovery-epoch-2").appendedEvents).toBe(0);
  });

  it("classifies a queued target Run as stale_runtime before command kind", async () => {
    const fixture = await testDatabase();
    new CommandRepository(fixture.database).create({
      id: "command-stale",
      userId: OWNER,
      deviceId: DEVICE,
      sessionId: SESSION_A,
      scope: "runtime",
      clientCommandId: "client-stale",
      kind: "abort",
      payload: { kind: "abort", targetRunId: "run-queued" },
      now: NOW
    });
    appendEvents(fixture.database, SESSION_A, [
      eventEnvelope(SESSION_A, 1, "operation.updated", {
        operationId: "operation-queued",
        kind: "run",
        status: "running",
        runId: "run-queued",
        commandId: "command-stale"
      }, "run-queued", "operation-queued"),
      eventEnvelope(SESSION_A, 2, "run.updated", {
        kind: "prompt",
        status: "queued",
        phase: "dispatching",
        source: "command",
        commandId: "command-stale"
      }, "run-queued", "operation-queued"),
      eventEnvelope(SESSION_A, 3, "command.updated", {
        commandId: "command-stale",
        kind: "abort",
        state: "dispatching",
        targetRunId: "run-queued",
        runs: [{ runId: "run-queued", sessionId: SESSION_A }]
      })
    ]);
    const report = new RecoveryManager(fixture.database, { now: () => NOW }).recoverSession(SESSION_A, "recovery-stale");
    expect(report.staleCommandIds).toEqual(["command-stale"]);
    expect(report.unknownCommandIds).toEqual([]);
    expect(fixture.database.prepare("SELECT state, error_code FROM commands WHERE id = ?").get("command-stale")).toMatchObject({
      state: "cancelled",
      error_code: "STALE_RUNTIME"
    });
    expect(fixture.database.prepare("SELECT status FROM runs WHERE id = ?").get("run-queued")).toMatchObject({ status: "cancelled" });
  });

  it("pauses only a non-empty queued tail and leaves an empty queue ready", async () => {
    const fixture = await testDatabase();
    appendEvents(fixture.database, SESSION_A, [
      eventEnvelope(SESSION_A, 1, "operation.updated", {
        operationId: "operation-active",
        kind: "run",
        status: "running",
        runId: "run-active"
      }, "run-active", "operation-active"),
      eventEnvelope(SESSION_A, 2, "run.updated", {
        kind: "prompt",
        status: "running",
        phase: "model",
        source: "runtime"
      }, "run-active", "operation-active"),
      eventEnvelope(SESSION_A, 3, "queue.updated", {
        state: "ready",
        version: 1,
        pause: null,
        items: [{ commandId: "queued-tail", runId: "queued-tail-run", kind: "prompt", position: 0 }]
      })
    ]);
    const report = new RecoveryManager(fixture.database, { now: () => NOW }).recoverSession(SESSION_A, "recovery-queue");
    expect(report.pausedQueue).toBe(true);
    expect(loadReducerState(fixture.database, SESSION_A).queue).toMatchObject({ state: "paused", version: 2 });

    const empty = await testDatabase([SESSION_B]);
    appendEvents(empty.database, SESSION_B, [
      eventEnvelope(SESSION_B, 1, "operation.updated", {
        operationId: "operation-empty",
        kind: "run",
        status: "running",
        runId: "run-empty"
      }, "run-empty", "operation-empty"),
      eventEnvelope(SESSION_B, 2, "run.updated", {
        kind: "prompt",
        status: "running",
        phase: "model",
        source: "runtime"
      }, "run-empty", "operation-empty")
    ]);
    const emptyReport = new RecoveryManager(empty.database, { now: () => NOW }).recoverSession(SESSION_B, "recovery-empty");
    expect(emptyReport.pausedQueue).toBe(false);
    expect(loadReducerState(empty.database, SESSION_B).queue.state).toBe("ready");
  });

  it("closes an active operation with no Run and keeps valid SDK history recognizable", async () => {
    const fixture = await testDatabase();
    appendEvents(fixture.database, SESSION_A, [
      eventEnvelope(SESSION_A, 1, "operation.updated", {
        operationId: "operation-bash",
        kind: "bash",
        status: "running"
      }, null, "operation-bash")
    ]);
    const report = new RecoveryManager(fixture.database, { now: () => NOW }).recoverSession(SESSION_A, "recovery-bash");
    expect(report.interruptedRunIds).toEqual([]);
    expect(report.interruptedOperationIds).toEqual(["operation-bash"]);
    expect(loadReducerState(fixture.database, SESSION_A).operations["operation-bash"]?.status).toBe("interrupted");

    const headerPath = join(fixture.directory, "header-only.jsonl");
    await writeFile(headerPath, `${JSON.stringify({
      type: "session",
      version: 3,
      id: "pi-header",
      timestamp: new Date(NOW).toISOString(),
      cwd: fixture.projectPath
    })}\n`);
    const header = await inspectPiSessionFile(headerPath, fixture.projectPath);
    expect(header.kind).toBe("persisted");
    if (header.kind === "persisted") expect(header.hasAssistantMessage).toBe(false);

    await writeFile(headerPath, `${JSON.stringify({
      type: "session",
      version: 3,
      id: "pi-header",
      timestamp: new Date(NOW).toISOString(),
      cwd: fixture.projectPath
    })}\n${JSON.stringify({
      type: "session_info",
      id: "info-1",
      parentId: null,
      timestamp: new Date(NOW).toISOString(),
      name: "valid metadata"
    })}\n`);
    const nonAssistant = await inspectPiSessionFile(headerPath, fixture.projectPath);
    expect(nonAssistant.kind).toBe("persisted");
    if (nonAssistant.kind === "persisted") expect(nonAssistant.hasNonAssistantEntry).toBe(true);
  });
});

describe("S06 worker and manager lifecycle", () => {
  it("carries durable identity/state/title into reload and allows only same-ID unflushed path rebind", async () => {
    const fixture = await testDatabase();
    const sessions = new SessionRepository(fixture.database);
    sessions.setPiMapping({ id: SESSION_A, piSessionId: "same-pi-id", piSessionFile: "/old.jsonl", persistenceState: "unflushed" });
    let initialization: Extract<WorkerInboundMessage, { type: "initialize" }> | undefined;
    const manager = managerFor(fixture.database, fixture.directory, () => new FakeChild(4150, (message, child) => {
      if (message.type === "initialize") {
        initialization = message;
        outbound(child, "session_mapping", { piSessionId: "same-pi-id", piSessionFile: "/new.jsonl", persistenceState: "unflushed", fileState: "missing" });
      } else sessionMappingHandler(message, child);
    }));
    await manager.load(SESSION_A);
    expect(initialization?.payload).toMatchObject({ sessionId: "same-pi-id", sessionFile: "/old.jsonl", persistenceState: "unflushed", title: SESSION_A, hasPendingTitle: false });
    expect(sessions.getRow(SESSION_A)?.pi_session_file).toBe("/new.jsonl");
    expect(() => sessions.setPiMapping({ id: SESSION_A, piSessionId: "different-id", piSessionFile: "/other.jsonl", persistenceState: "unflushed" })).toThrow(/different pi mapping/);
    sessions.markPiPersisted(SESSION_A);
    expect(() => sessions.setPiMapping({ id: SESSION_A, piSessionId: "same-pi-id", piSessionFile: "/third.jsonl", persistenceState: "persisted" })).toThrow(/different pi mapping/);
  });

  it("keeps pre-handle trust and session_start forms alive beyond the startup deadline and answers them once", async () => {
    const fixture = await testDatabase();
    const extensions = join(fixture.projectPath, ".pi", "extensions");
    await mkdir(extensions, { recursive: true });
    const marker = join(fixture.directory, "answers.txt");
    await writeFile(join(extensions, "startup-form.ts"), `import { appendFileSync } from 'node:fs';
export default function(pi) { pi.on('session_start', async (_event, ctx) => {
  const confirmed = await ctx.ui.confirm('Initialization', 'Continue?');
  appendFileSync(${JSON.stringify(marker)}, String(confirmed) + '\\n');
}); }`);
    const manager = new WorkerManager(fixture.database, {
      spawnWorker: (input) => {
        // Reuse the preloaded production worker module: /mnt/c cold imports
        // exceed the process handshake deadline in WSL. SDK/resource loading
        // and the actual extension callback remain real in this test.
        const child = new FakeChild(4151, (message) => { void worker.receive(message); });
        const worker = new PiWorker({ send: (message) => {
          child.stdout.write(JSON.stringify(message) + "\n");
          if (message.type === "stopped") queueMicrotask(() => child.emit("exit", 0, null));
        } }, { sessionId: input.env.PI_REMOTE_WORKER_SESSION_ID!, workerEpoch: input.env.PI_REMOTE_WORKER_EPOCH!, heartbeatMs: 200 });
        child.once("exit", () => worker.dispose());
        return child as unknown as ChildProcessWithoutNullStreams;
      },
      stateDir: fixture.directory, agentDir: join(fixture.directory, "agent"),
      sessionDir: join(fixture.directory, "sessions"), autoRecover: false,
      workerHeartbeatMs: 200, heartbeatTimeoutMs: 15_000
    });
    cleanups.push(async () => manager.stop());
    const loaded = manager.load(SESSION_A);
    // Attach a rejection observer before the long UI wait so failures are reported by assertions.
    let loadError: unknown;
    void loaded.catch((error: unknown) => { loadError = error; });
    await vi.waitFor(() => { if (loadError) throw loadError; expect(Object.values(loadReducerState(fixture.database, SESSION_A).interactions)).toHaveLength(1); }, { timeout: 20_000 });
    const first = Object.values(loadReducerState(fixture.database, SESSION_A).interactions)[0]!;
    expect(first.status).toBe("pending");
    expect(first.title).toContain("Trust project folder?");
    expect(fixture.database.prepare("SELECT pi_session_id FROM sessions WHERE id = ?").get(SESSION_A)).toMatchObject({ pi_session_id: null });
    await new Promise((resolve) => setTimeout(resolve, 15_200));
    expect(loadError).toBeUndefined();
    expect(manager.activeWorkerCount).toBe(1);
    const reconnected = Object.values(loadReducerState(fixture.database, SESSION_A).interactions)[0]!;
    expect(reconnected.interactionId).toBe(first.interactionId);
    expect(reconnected.status).toBe("pending");
    const commands = new CommandService(fixture.database, manager);
    cleanups.push(async () => commands.dispose());
    const answer = { kind: "respond", payload: { operationId: first.operationId, interactionId: first.interactionId, response: { value: "Trust (this session only)" } } };
    const actor = { userId: OWNER, deviceId: DEVICE } as AuthContext;
    const receipt = await commands.submit(actor, SESSION_A, answer, "70000000-0000-4000-8000-000000000001");
    expect(receipt.status).toBe(202);
    expect(await commands.submit(actor, SESSION_A, answer, "70000000-0000-4000-8000-000000000001")).toEqual(receipt);
    await vi.waitFor(() => expect(Object.values(loadReducerState(fixture.database, SESSION_A).interactions).some(item => item.title === "Initialization")).toBe(true));
    const startup = Object.values(loadReducerState(fixture.database, SESSION_A).interactions).find(item => item.title === "Initialization")!;
    await commands.submit(actor, SESSION_A, { kind: "respond", payload: { operationId: startup.operationId, interactionId: startup.interactionId, response: { confirmed: true } } }, "70000000-0000-4000-8000-000000000002");
    await loaded;
    await vi.waitFor(async () => expect(await readFile(marker, "utf8")).toBe("true\n"));
    expect(Object.values(loadReducerState(fixture.database, SESSION_A).interactions)[0]?.status).toBe("resolved");
  }, 40_000);

  it("still detects a startup process that never reaches a form or ready", async () => {
    const fixture = await testDatabase();
    const child = new FakeChild(4152);
    const manager = managerFor(fixture.database, fixture.directory, () => child, { mappingTimeoutMs: 30 });
    await expect(manager.load(SESSION_A)).rejects.toMatchObject({ code: "WORKER_START_TIMEOUT" });
    await vi.waitFor(() => expect(child.killed).toBe(true));
  });

  it("queries refreshed worker models and retains current native thinking levels for snapshots", async () => {
    const fixture = await testDatabase();
    const requests: Extract<WorkerInboundMessage, { type: "get_models" }>[] = [];
    const manager = managerFor(fixture.database, fixture.directory, () => new FakeChild(4156, (message, child) => {
      sessionMappingHandler(message, child);
      if (message.type === "get_models") {
        requests.push(message);
        outbound(child, "models", { requestId: message.payload.requestId, items: [{ model: { provider: "extension", id: "custom" }, name: "Custom", thinkingLevels: ["off", "high"], contextWindow: 65536 }], availableThinkingLevels: ["off", "high"] });
      }
    }));
    const catalog = await manager.getModels(SESSION_A, true);
    expect(catalog.items[0]?.model).toEqual({ provider: "extension", id: "custom" });
    expect(requests[0]?.payload.refresh).toBe(true);
    expect(manager.availableThinkingLevels(SESSION_A)).toEqual(["off", "high"]);
  });

  it("applies editor state with an ACK before ready without blocking initialization controls", async () => {
    const fixture = await testDatabase();
    let child: FakeChild;
    let editor: Extract<WorkerInboundMessage, { type: "editor_state" }> | undefined;
    const manager = managerFor(fixture.database, fixture.directory, () => {
      child = new FakeChild(4155, (message) => {
        if (message.type === "editor_state") editor = message;
        if (message.type === "shutdown") queueMicrotask(() => child.emit("exit", 0, null));
      });
      return child;
    });
    let resolved = false;
    const applied = manager.setEditorState(SESSION_A, "draft text").then(() => { resolved = true; });
    expect(editor?.payload.text).toBe("draft text");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(resolved).toBe(false);
    outbound(child!, "editor_state_ack", { requestId: editor!.payload.requestId! });
    await applied;
    expect(resolved).toBe(true);
    expect(loadReducerState(fixture.database, SESSION_A).session.status).not.toBe("ready");
  });

  it("ACKs replacement mappings without rebinding source history and routes delayed source events", async () => {
    const fixture = await testDatabase();
    let child: FakeChild;
    const acknowledgements: Array<Extract<WorkerInboundMessage, { type: "session_replace_ack" }>> = [];
    const manager = managerFor(fixture.database, fixture.directory, () => {
      child = new FakeChild(4160, (message, instance) => {
        sessionMappingHandler(message, instance);
        if (message.type === "session_replace_ack") acknowledgements.push(message);
      });
      return child;
    });
    await manager.load(SESSION_A);
    const original = new SessionRepository(fixture.database).getRow(SESSION_A)!;
    outbound(child!, "session_replace_intent", { requestId: "replace-one", kind: "new", piSessionId: String(original.pi_session_id), piSessionFile: String(original.pi_session_file) });
    await vi.waitFor(() => expect(acknowledgements).toHaveLength(1));
    expect(acknowledgements[0]?.payload).toEqual({ requestId: "replace-one", phase: "intent", appSessionId: SESSION_A });
    expect(manager.hasPendingNativeReplacement(String(original.project_id))).toBe(true);
    expect(fixture.database.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'runtime.notice'").get()?.n).toBe(1);
    outbound(child!, "session_replaced", { requestId: "replace-one", piSessionId: "replacement-pi", piSessionFile: "/replacement.jsonl", persistenceState: "unflushed" });
    await vi.waitFor(() => expect(acknowledgements).toHaveLength(2));
    const destination = acknowledgements[1]!.payload.appSessionId;
    expect(manager.hasPendingNativeReplacement(String(original.project_id))).toBe(false);
    expect(destination).not.toBe(SESSION_A);
    expect(new SessionRepository(fixture.database).getRow(SESSION_A)?.pi_session_id).toBe(original.pi_session_id);
    expect(new SessionRepository(fixture.database).getRow(destination)?.pi_session_id).toBe("replacement-pi");
    expect(manager.workerEpoch(destination)).toBe(child!.workerEpoch);
    expect(manager.workerEpoch(SESSION_A)).toBeNull();
    outbound(child!, "event_batch", { batchNo: 2, events: [
      eventEnvelope(SESSION_A, 1, "runtime.notice", { kind: "generic", message: "old callback" }),
      eventEnvelope(destination, 1, "session.updated", { changes: { title: "Destination native name" } })
    ] as never });
    await vi.waitFor(() => expect(new SessionRepository(fixture.database).get(destination)?.title).toBe("Destination native name"));
    expect(loadReducerState(fixture.database, SESSION_A).notices.at(-1)?.message).toBe("old callback");
    outbound(child!, "session_replaced", { requestId: "replace-one", piSessionId: "replacement-pi", piSessionFile: "/replacement.jsonl", persistenceState: "unflushed" });
    await vi.waitFor(() => expect(acknowledgements).toHaveLength(3));
    expect(acknowledgements[2]!.payload.appSessionId).toBe(destination);
    expect(fixture.database.prepare("SELECT COUNT(*) AS n FROM sessions").get()?.n).toBe(2);
  });

  it.each([false, true])("maps cross-cwd native switch to its actual project and reloads that cwd (registered=%s)", async (registered) => {
    const fixture = await testDatabase();
    const targetCwd = join(fixture.directory, "other-native-project");
    await mkdir(targetCwd, { recursive: true });
    const targetFile = join(fixture.directory, "other-native.jsonl");
    const contents = JSON.stringify({ type: "session", version: 3, id: "other-native-pi", timestamp: new Date(NOW).toISOString(), cwd: targetCwd }) + "\n";
    await writeFile(targetFile, contents);
    let registeredProjectId: string | undefined;
    if (registered) {
      const info = await (await import("node:fs/promises")).stat(targetCwd);
      registeredProjectId = new ProjectRepository(fixture.database).create({ userId: OWNER, name: "Registered destination", rootPath: targetCwd, rootIdentity: `${info.dev}:${info.ino}`, workspaceKey: `path:${targetCwd}` }).id;
    }
    let child: FakeChild;
    const acks: Array<Extract<WorkerInboundMessage, { type: "session_replace_ack" }>> = [];
    const manager = managerFor(fixture.database, fixture.directory, () => {
      child = new FakeChild(4170, (message, instance) => {
        sessionMappingHandler(message, instance);
        if (message.type === "session_replace_ack") acks.push(message);
      });
      return child;
    });
    await manager.load(SESSION_A);
    const source = new SessionRepository(fixture.database).getRow(SESSION_A)!;
    outbound(child!, "session_replace_intent", { requestId: "cross-cwd", kind: "switch", piSessionId: String(source.pi_session_id), piSessionFile: String(source.pi_session_file), targetFile });
    await vi.waitFor(() => expect(acks).toHaveLength(1));
    const intent = loadReducerState(fixture.database, SESSION_A).notices.at(-1)?.details?.nativeSessionReplacement as { targetCwd: string; projectId: string };
    expect(intent.targetCwd).toBe(targetCwd);
    outbound(child!, "session_replaced", { requestId: "cross-cwd", piSessionId: "other-native-pi", piSessionFile: targetFile, persistenceState: "persisted" });
    await vi.waitFor(() => expect(acks).toHaveLength(2));
    const destination = acks[1]!.payload.appSessionId;
    const destinationSession = new SessionRepository(fixture.database).get(destination)!;
    const project = new ProjectRepository(fixture.database).get(destinationSession.projectId)!;
    expect(project.rootPath).toBe(targetCwd);
    expect(project.workspaceKey).toBe(`path:${targetCwd}`);
    expect(destinationSession.projectId).not.toBe(PROJECT);
    if (registered) expect(destinationSession.projectId).toBe(registeredProjectId);
    expect(fixture.database.prepare("SELECT COUNT(*) AS n FROM projects").get()?.n).toBe(2);
    expect(new SessionRepository(fixture.database).getRow(SESSION_A)?.pi_session_id).toBe(source.pi_session_id);
    expect(await readFile(targetFile, "utf8")).toBe(contents);
    await manager.stop();
    let initialization: Extract<WorkerInboundMessage, { type: "initialize" }> | undefined;
    const restarted = managerFor(fixture.database, fixture.directory, () => new FakeChild(4171, (message, instance) => {
      if (message.type === "initialize") {
        initialization = message;
        outbound(instance, "session_mapping", { piSessionId: "other-native-pi", piSessionFile: targetFile, persistenceState: "persisted", fileState: "persisted" });
      } else sessionMappingHandler(message, instance);
    }));
    await restarted.load(destination);
    expect(initialization?.payload).toMatchObject({ cwd: targetCwd, sessionFile: targetFile, sessionId: "other-native-pi", persistenceState: "persisted" });
    expect((await inspectPiSessionFile(targetFile, initialization!.payload.cwd)).kind).toBe("persisted");
    expect(await readFile(targetFile, "utf8")).toBe(contents);
  });

  it("loads the exact editor Session while an old form stays on its moved worker and protects it from idle reap", async () => {
    const fixture = await testDatabase();
    const children: FakeChild[] = [];
    const seen: Array<{ child: FakeChild; message: WorkerInboundMessage }> = [];
    const manager = managerFor(fixture.database, fixture.directory, () => {
      const child = new FakeChild(4162 + children.length, (message, instance) => {
        seen.push({ child: instance, message });
        sessionMappingHandler(message, instance);
        if (message.type === "editor_state") outbound(instance, "editor_state_ack", { requestId: message.payload.requestId! });
      });
      children.push(child);
      return child;
    }, { workerIdleMs: 10, now: () => NOW });
    await manager.load(SESSION_A);
    const original = children[0]!;
    outbound(original, "event_batch", { batchNo: 1, events: [
      eventEnvelope(SESSION_A, 1, "operation.updated", { operationId: "old-form-operation", kind: "extension", status: "running" }, null, "old-form-operation"),
      eventEnvelope(SESSION_A, 2, "interaction.requested", { interactionId: "old-form", operationId: "old-form-operation", origin: "extension", kind: "confirm", title: "Old callback" }, null, "old-form-operation")
    ] as never });
    await vi.waitFor(() => expect(loadReducerState(fixture.database, SESSION_A).interactions["old-form"]?.status).toBe("pending"));
    const mapping = new SessionRepository(fixture.database).getRow(SESSION_A)!;
    outbound(original, "session_replace_intent", { requestId: "editor-move", kind: "new", piSessionId: String(mapping.pi_session_id), piSessionFile: String(mapping.pi_session_file) });
    await vi.waitFor(() => expect(seen.some(({ message }) => message.type === "session_replace_ack" && message.payload.phase === "intent")).toBe(true));
    outbound(original, "session_replaced", { requestId: "editor-move", piSessionId: "editor-destination-pi", piSessionFile: "/editor-destination.jsonl", persistenceState: "unflushed" });
    await vi.waitFor(() => expect(seen.some(({ message }) => message.type === "session_replace_ack" && message.payload.phase === "bound")).toBe(true));
    expect(await manager.reapIdleWorkers(NOW + 1000)).toEqual([]);
    await manager.setEditorState(SESSION_A, "new source draft");
    expect(children).toHaveLength(2);
    expect(seen.find(({ message }) => message.type === "editor_state")?.child).toBe(children[1]);
    expect(manager.workerEpoch(SESSION_A)).toBe(original.workerEpoch);
    await manager.sendControl(SESSION_A, "respond", { operationId: "old-form-operation", interactionId: "old-form", response: { confirmed: true } }, { waitForReady: false });
    expect(seen.find(({ message }) => message.type === "respond")?.child).toBe(original);
    expect(original.killed).toBe(false);
    outbound(original, "extension_error", { sessionId: SESSION_A, operationId: "old-form-operation", extensionPath: "synthetic", event: "command", error: "source callback error" });
    await vi.waitFor(() => expect(loadReducerState(fixture.database, SESSION_A).notices.some(notice => notice.message.includes("source callback error"))).toBe(true));
  });

  it("does not overwrite heartbeat-reported native activity with an empty model lease set during reap", async () => {
    const fixture = await testDatabase();
    let child: FakeChild;
    const manager = managerFor(fixture.database, fixture.directory, () => {
      child = new FakeChild(4165, sessionMappingHandler);
      return child;
    }, { workerIdleMs: 10, now: () => NOW });
    await manager.load(SESSION_A);
    outbound(child!, "heartbeat", { pid: child!.pid, at: new Date(NOW).toISOString(), active: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(manager.activeRunCount).toBe(0);
    expect(await manager.reapIdleWorkers(NOW + 1000)).toEqual([]);
    expect(child!.killed).toBe(false);
    outbound(child!, "heartbeat", { pid: child!.pid, at: new Date(NOW).toISOString(), active: false });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await manager.reapIdleWorkers(NOW + 1000)).toEqual([SESSION_A]);
  });

  it("uses a recovered native title emitted before ready instead of overwriting it from stale DB metadata", async () => {
    const fixture = await testDatabase();
    const renames: string[] = [];
    const manager = managerFor(fixture.database, fixture.directory, () => new FakeChild(4161, (message, child) => {
      if (message.type === "initialize") {
        expect(message.payload.hasPendingTitle).toBe(false);
        sessionMappingHandler(message, child);
      } else if (message.type === "session_mapping_ack") {
        outbound(child, "event_batch", { batchNo: 1, events: [eventEnvelope(SESSION_A, 1, "session.updated", { changes: { title: "Native title survived the crash" } })] as never });
        outbound(child, "ready", { pid: child.pid, processGroupId: null, workerStartTicks: null, persistenceState: "unflushed" });
      } else {
        if (message.type === "rename") renames.push(message.payload.name);
        sessionMappingHandler(message, child);
      }
    }));
    await manager.load(SESSION_A);
    expect(new SessionRepository(fixture.database).get(SESSION_A)?.title).toBe("Native title survived the crash");
    expect(renames).toEqual(["Native title survived the crash"]);
  });

  it("keeps a newer pending rename when an earlier ACK arrives", async () => {
    const fixture = await testDatabase();
    const sessions = new SessionRepository(fixture.database);
    let child: FakeChild;
    const renames: Extract<WorkerInboundMessage, { type: "rename" }>[] = [];
    let initializedWithPendingTitle = false;
    const manager = managerFor(fixture.database, fixture.directory, () => {
      child = new FakeChild(4153, (message, instance) => {
        if (message.type === "initialize") initializedWithPendingTitle = message.payload.hasPendingTitle === true;
        sessionMappingHandler(message, instance);
        if (message.type === "rename") renames.push(message);
      });
      return child;
    });
    sessions.setPendingTitle(SESSION_A, { intentId: "rename-a", value: "A", version: 1, source: "mobile", requestedSeq: 1 });
    await manager.load(SESSION_A);
    expect(renames.at(-1)?.payload).toEqual({ name: "A", intentId: "rename-a" });
    expect(initializedWithPendingTitle).toBe(true);
    sessions.setPendingTitle(SESSION_A, { intentId: "rename-b", value: "B", version: 2, source: "mobile", requestedSeq: 2 });
    manager.notifyRename(SESSION_A, "B");
    outbound(child!, "rename_ack", { name: "A", intentId: "rename-a" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(loadReducerState(fixture.database, SESSION_A).metadataSync.pendingTitle?.intentId).toBe("rename-b");
    outbound(child!, "rename_ack", { name: "B", intentId: "rename-b" });
    await vi.waitFor(() => expect(loadReducerState(fixture.database, SESSION_A).metadataSync.pendingTitle).toBeNull());
    expect(renames).toHaveLength(2);
  });

  it("accepts mapping before ready and never starts a worker for a history read", async () => {
    const fixture = await testDatabase();
    const children: FakeChild[] = [];
    const manager = managerFor(fixture.database, fixture.directory, () => {
      const child = new FakeChild(4101, sessionMappingHandler);
      children.push(child);
      return child;
    });
    expect(manager.activeWorkerCount).toBe(0);
    await manager.load(SESSION_A);
    expect(manager.activeWorkerCount).toBe(1);
    expect(children).toHaveLength(1);
    expect(fixture.database.prepare("SELECT pi_session_id, pi_session_file FROM sessions WHERE id = ?").get(SESSION_A)).toMatchObject({
      pi_session_id: `pi-${SESSION_A}`
    });
    await manager.load(SESSION_A);
    expect(children).toHaveLength(1);
  });

  it("allows different Sessions to run in parallel, rejects a second Run in one Session, and records failures honestly", async () => {
    const fixture = await testDatabase([SESSION_A, SESSION_B]);
    const children = new Map<string, FakeChild>();
    const manager = managerFor(fixture.database, fixture.directory, (input) => {
      const child = new FakeChild(4200 + children.size, sessionMappingHandler);
      children.set(input.env.PI_REMOTE_WORKER_SESSION_ID ?? "", child);
      return child;
    });
    const commands = new CommandRepository(fixture.database);
    commands.create({ id: "command-a", userId: OWNER, deviceId: DEVICE, sessionId: SESSION_A, scope: "runtime", clientCommandId: "client-a", kind: "prompt", payload: { text: "a" }, now: NOW });
    commands.create({ id: "command-a2", userId: OWNER, deviceId: DEVICE, sessionId: SESSION_A, scope: "runtime", clientCommandId: "client-a2", kind: "prompt", payload: { text: "a2" }, now: NOW });
    commands.create({ id: "command-b", userId: OWNER, deviceId: DEVICE, sessionId: SESSION_B, scope: "runtime", clientCommandId: "client-b", kind: "prompt", payload: { text: "b" }, now: NOW });

    await manager.dispatch({ sessionId: SESSION_A, commandId: "command-a", operationId: "operation-a", kind: "prompt", text: "a" });
    await expect(manager.dispatch({ sessionId: SESSION_A, commandId: "command-a2", operationId: "operation-a2", kind: "prompt", text: "a2" })).rejects.toMatchObject({ code: "SESSION_BUSY" });
    await manager.dispatch({ sessionId: SESSION_B, commandId: "command-b", operationId: "operation-b", kind: "prompt", text: "b" });
    expect(manager.activeRunCount).toBe(2);

    const childA = children.get(SESSION_A);
    const childB = children.get(SESSION_B);
    if (!childA || !childB) throw new Error("fake workers were not created");
    outbound(childA, "command_result", { commandId: "command-a", status: "failed", error: { code: "MODEL_DOWN", message: "provider failed" } });
    outbound(childB, "command_result", { commandId: "command-b", status: "completed" });
    await vi.waitFor(() => expect(manager.activeRunCount).toBe(0));
    expect(fixture.database.prepare("SELECT state, error_code FROM commands WHERE id = ?").get("command-a")).toMatchObject({ state: "failed", error_code: "MODEL_DOWN" });
    expect(fixture.database.prepare("SELECT status, error_code FROM runs WHERE id = ?").get("operation-a")).toBeUndefined();
    const run = fixture.database.prepare("SELECT status, error_code FROM runs WHERE command_id = ?").get("command-a");
    expect(run).toMatchObject({ status: "failed", error_code: "MODEL_DOWN" });
  });

  it("marks a queued Run unknown when the execute frame crossed IPC before worker loss", async () => {
    const fixture = await testDatabase();
    const commands = new CommandRepository(fixture.database);
    commands.create({
      id: "command-crash",
      userId: OWNER,
      deviceId: DEVICE,
      sessionId: SESSION_A,
      scope: "runtime",
      clientCommandId: "client-crash",
      kind: "prompt",
      payload: { text: "crash" },
      now: NOW
    });
    let child: FakeChild | undefined;
    const manager = managerFor(fixture.database, fixture.directory, () => {
      child = new FakeChild(4250, sessionMappingHandler);
      return child;
    });
    await manager.dispatch({ sessionId: SESSION_A, commandId: "command-crash", operationId: "operation-crash", kind: "prompt", text: "crash" });
    if (!child) throw new Error("fake worker was not created");
    expect(fixture.database.prepare("SELECT dispatched_at FROM commands WHERE id = ?").get("command-crash")).toMatchObject({ dispatched_at: expect.any(Number) });
    child.emit("exit", 1, "SIGKILL");
    await vi.waitFor(() => expect(manager.activeWorkerCount).toBe(0));
    expect(fixture.database.prepare("SELECT state, error_code FROM commands WHERE id = ?").get("command-crash")).toMatchObject({
      state: "unknown",
      error_code: "UNKNOWN_RUNTIME"
    });
    expect(fixture.database.prepare("SELECT status, error_code FROM runs WHERE command_id = ?").get("command-crash")).toMatchObject({
      status: "interrupted",
      error_code: "UNKNOWN_RUNTIME"
    });
  });

  it("ignores an old epoch and reaps only a configured idle worker", async () => {
    const fixture = await testDatabase();
    let clock = NOW;
    let child: FakeChild | undefined;
    const manager = managerFor(fixture.database, fixture.directory, () => {
      child = new FakeChild(4301, (message, process) => {
        if (message.type === "shutdown") outbound(process, "stopped", { reason: "idle_reap" });
        else sessionMappingHandler(message, process);
      });
      const process = child;
      process.stdin.once("finish", () => process.emit("exit", 0, null));
      return child;
    }, { now: () => clock, workerIdleMs: 50 });
    await manager.load(SESSION_A);
    if (!child) throw new Error("fake worker was not created");
    expect(manager.acceptsEpoch(SESSION_A, "old-epoch")).toBe(false);
    expect(manager.acceptsEpoch(SESSION_A, child.workerEpoch)).toBe(true);
    expect(child.stdin.writableEnded).toBe(false);
    clock += 100;
    expect(await manager.reapIdleWorkers(clock)).toEqual([SESSION_A]);
    await vi.waitFor(() => expect(manager.activeWorkerCount).toBe(0));
    expect(child.killed).toBe(false);
    expect(child.stdin.writableEnded).toBe(true);
  });

  it("keeps the single-instance lock until the first manager releases it", async () => {
    const fixture = await testDatabase();
    const first = managerFor(fixture.database, fixture.directory, () => new FakeChild(4401, sessionMappingHandler));
    await expect(access(join(fixture.directory, "instance.lock.sqlite"))).resolves.toBeUndefined();
    expect(() => assertInstanceStopped(fixture.directory)).toThrow(/live server instance owns/);
    expect(() => new WorkerManager(fixture.database, {
      instanceLockPath: join(fixture.directory, "instance.lock"),
      autoRecover: false
    }).start()).toThrow(/another server instance/);
    await first.stop();
    const second = new WorkerManager(fixture.database, {
      instanceLockPath: join(fixture.directory, "instance.lock"),
      autoRecover: false
    });
    expect(second.start()).toEqual([]);
    await second.stop();
  });
});

describe("S06 PiWorker ACK boundary", () => {
  it("keeps the newline worker reader live while initialization waits for the ACK", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: string[] = [];
    let pending = "";
    let mappingAcknowledged = false;
    let ending = false;
    const acknowledgedBatches = new Set<number>();
    output.on("data", (chunk: Buffer | string) => {
      pending += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        lines.push(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
      const mapping = lines.map((line) => JSON.parse(line) as WorkerOutboundMessage)
        .find((message) => message.type === "session_mapping");
      if (mapping && !mappingAcknowledged) {
        mappingAcknowledged = true;
        input.write(`${JSON.stringify(makeIpcEnvelope(SESSION_A, "process-epoch", "session_mapping_ack", {
          piSessionId: "pi-process-session",
          piSessionFile: "/tmp/process-session.jsonl"
        }))}\n`);
      }
      for (const line of lines) {
        const message = JSON.parse(line) as WorkerOutboundMessage;
        if (message.type === "event_batch" && !acknowledgedBatches.has(message.payload.batchNo)) {
          acknowledgedBatches.add(message.payload.batchNo);
          input.write(`${JSON.stringify(makeIpcEnvelope(SESSION_A, "process-epoch", "batch_ack", { batchNo: message.payload.batchNo }))}\n`);
        }
      }
      if (!ending && lines.some((line) => (JSON.parse(line) as WorkerOutboundMessage).type === "ready")) {
        ending = true;
        setImmediate(() => input.end());
      }
    });
    const handle = {
      session: {
        sessionId: "pi-process-session",
        sessionFile: "/tmp/process-session.jsonl",
        model: null,
        prompt: vi.fn(async () => undefined),
        compact: vi.fn(async () => undefined),
        executeBash: vi.fn(async () => ({ exitCode: 0, output: "" })),
        abort: vi.fn(async () => undefined),
        abortBash: vi.fn(),
        setModel: vi.fn(async () => undefined),
        setThinkingLevel: vi.fn(),
        setSessionName: vi.fn()
      },
      sessionManager: { getSessionFile: () => "/tmp/process-session.jsonl", isPersisted: () => false },
      services: { modelRuntime: { getModel: () => null } },
      dispose: vi.fn(),
      bindExtensions: vi.fn(async () => undefined),
      onEvent: () => () => undefined
    } as unknown as Awaited<ReturnType<WorkerSessionFactory>>;
    const running = runWorkerProcess({
      input,
      output,
      sessionId: SESSION_A,
      workerEpoch: "process-epoch",
      heartbeatMs: 60_000,
      factory: async () => handle
    });
    input.write(`${JSON.stringify(makeIpcEnvelope(SESSION_A, "process-epoch", "initialize", {
      cwd: "/tmp",
      agentDir: "/tmp/agent",
      sessionDir: "/tmp/sessions"
    }))}\n`);
    await expect(running).resolves.toBeUndefined();
    const messages = lines.map((line) => JSON.parse(line) as WorkerOutboundMessage);
    expect(messages.filter(message => message.type !== "event_batch").map(message => message.type)).toEqual([
      "session_mapping",
      "ready"
    ]);
    expect(messages.filter(message => message.type === "event_batch").flatMap(message => message.payload.events))
      .toContainEqual(expect.objectContaining({ type: "runtime.notice", payload: expect.objectContaining({ details: { method: "setToolsExpanded", args: [false] } }) }));
  });

  it("does not deadlock mapping ACK and ACKs event batches after emitting SDK events", async () => {
    const sent: WorkerOutboundMessage[] = [];
    let onEvent: ((event: unknown) => void) | undefined;
    let resolvePrompt: (() => void) | undefined;
    const prompt = vi.fn(() => new Promise<void>((resolve) => { resolvePrompt = resolve; }));
    const sessionFile = join("/tmp", "pi-remote-worker-test.jsonl");
    const handle = {
      session: {
        sessionId: "pi-worker-session",
        sessionFile,
        model: null,
        prompt,
        compact: vi.fn(async () => undefined),
        executeBash: vi.fn(async () => ({ exitCode: 0, output: "" })),
        abort: vi.fn(async () => undefined),
        abortBash: vi.fn(),
        setModel: vi.fn(async () => undefined),
        setThinkingLevel: vi.fn(),
        setSessionName: vi.fn()
      },
      sessionManager: {
        getSessionFile: () => sessionFile,
        isPersisted: () => false
      },
      services: { modelRuntime: { getModel: () => null } },
      dispose: vi.fn(),
      bindExtensions: vi.fn(async () => undefined),
      onEvent: (listener: (event: unknown) => void) => {
        onEvent = listener;
        return () => { onEvent = undefined; };
      }
    } as unknown as Awaited<ReturnType<WorkerSessionFactory>>;
    const worker = new PiWorker({ send: (message) => {
      sent.push(message);
      if (message.type === "event_batch") {
        queueMicrotask(() => { void worker.receive(makeIpcEnvelope(SESSION_A, "worker-epoch", "batch_ack", { batchNo: message.payload.batchNo })); });
      }
    } }, {
      sessionId: SESSION_A,
      workerEpoch: "worker-epoch",
      heartbeatMs: 60_000,
      factory: async () => handle
    });
    try {
      await worker.receive(makeIpcEnvelope(SESSION_A, "worker-epoch", "initialize", {
        cwd: "/tmp",
        agentDir: "/tmp/agent",
        sessionDir: "/tmp/sessions"
      }));
      await vi.waitFor(() => expect(sent.some((message) => message.type === "session_mapping")).toBe(true));
      await worker.receive(makeIpcEnvelope(SESSION_A, "worker-epoch", "session_mapping_ack", {
        piSessionId: "pi-worker-session",
        piSessionFile: sessionFile
      }));
      await vi.waitFor(() => expect(sent.some((message) => message.type === "ready")).toBe(true));
      await worker.receive(makeIpcEnvelope(SESSION_A, "worker-epoch", "execute", {
        commandId: "worker-command",
        operationId: "worker-operation",
        runId: "worker-run",
        kind: "prompt" as const,
        text: "hold"
      }));
      await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce());
      onEvent?.({ type: "message_start", message: { role: "assistant", content: [] } });
      await vi.waitFor(() => expect(sent.some((message) => message.type === "event_batch")).toBe(true));
      const batch = sent.find((message): message is Extract<WorkerOutboundMessage, { type: "event_batch" }> => message.type === "event_batch");
      if (!batch) throw new Error("worker did not emit an event batch");
      await worker.receive(makeIpcEnvelope(SESSION_A, "worker-epoch", "batch_ack", { batchNo: batch.payload.batchNo }));
      resolvePrompt?.();
      await vi.waitFor(() => expect(sent.some((message) => message.type === "command_result")).toBe(true));
      expect(sent.find((message) => message.type === "command_result")).toMatchObject({
        payload: { commandId: "worker-command", status: "completed" }
      });
    } finally {
      worker.dispose();
    }
  });
});
