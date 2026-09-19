import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CommandRepository,
  OwnerRepository,
  ProjectRepository,
  SessionRepository,
  loadReducerState,
  openServerDatabase
} from "../../apps/server/src/storage/index.js";
import {
  CommandService,
  type CommandServiceError
} from "../../apps/server/src/services/commands.js";
import {
  WorkerManager,
  RecoveryManager
} from "../../apps/server/src/runtime/index.js";
import {
  decodeWorkerInbound,
  makeIpcEnvelope
} from "../../apps/server/src/runtime/ipc.js";
import type {
  WorkerInboundMessage,
  WorkerOutboundMessage
} from "../../packages/agent-pi/src/worker.js";
import type { AuthContext } from "../../apps/server/src/auth.js";

const NOW = Date.parse("2026-09-13T00:00:00.000Z");
const OWNER = "s07-command-owner";
const DEVICE = "s07-command-device";
const PROJECT = "s07-command-project";
const SESSION = "s07-command-session";

interface Fixture {
  database: DatabaseSync;
  directory: string;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function fixture(): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), "pi-remote-s07-commands-"));
  const database = await openServerDatabase({ filename: join(directory, "state.sqlite"), now: NOW });
  new OwnerRepository(database).ensure({ id: OWNER, displayName: OWNER, now: NOW });
  new (await import("../../apps/server/src/storage/index.js")).DeviceRepository(database).create({
    id: DEVICE,
    userId: OWNER,
    name: DEVICE,
    token: "s07-command-token",
    now: NOW
  });
  new ProjectRepository(database).create({
    id: PROJECT,
    userId: OWNER,
    name: PROJECT,
    rootPath: join(directory, "project"),
    workspaceKey: "s07-command-workspace",
    rootIdentity: "s07-command-identity",
    now: NOW
  });
  new SessionRepository(database).create({ id: SESSION, projectId: PROJECT, title: SESSION, now: NOW });
  cleanups.push(async () => {
    database.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { database, directory };
}

type InboundHandler = (message: WorkerInboundMessage, child: FakeChild) => void;

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly executed: Extract<WorkerInboundMessage, { type: "execute" }>[] = [];
  readonly controls: WorkerInboundMessage[] = [];
  readonly pid: number;
  sessionId = "";
  workerEpoch = "";
  private pending = "";

  constructor(pid: number, private readonly onInbound: InboundHandler) {
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
          else if (message.type !== "initialize" && message.type !== "session_mapping_ack" && message.type !== "batch_ack" && message.type !== "shutdown") {
            this.controls.push(message);
          }
          this.onInbound(message, this);
        }
        newline = this.pending.indexOf("\n");
      }
    });
  }

  kill(): boolean {
    this.emit("exit", null, "SIGTERM");
    return true;
  }
}

function outbound<TType extends WorkerOutboundMessage["type"]>(
  child: FakeChild,
  type: TType,
  payload: Extract<WorkerOutboundMessage, { type: TType }>["payload"]
): void {
  child.stdout.write(`${JSON.stringify(makeIpcEnvelope(child.sessionId, child.workerEpoch, type, payload))}\n`);
}

function baseWorkerHandler(message: WorkerInboundMessage, child: FakeChild): void {
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
  } else if (message.type === "execute") {
    outbound(child, "command_accepted", {
      commandId: message.payload.commandId,
      ...(message.payload.runId ? { runId: message.payload.runId } : {}),
      operationId: message.payload.operationId
    });
  } else if (message.type === "shutdown") {
    outbound(child, "stopped", { reason: message.payload.reason ?? "shutdown" });
    queueMicrotask(() => child.emit("exit", 0, null));
  }
}

function managerFor(
  fixtureData: Fixture,
  handler: InboundHandler = baseWorkerHandler
): { manager: WorkerManager; getChild: () => FakeChild } {
  let child: FakeChild | undefined;
  const manager = new WorkerManager(fixtureData.database, {
    stateDir: fixtureData.directory,
    instanceLockPath: join(fixtureData.directory, "instance.lock"),
    mappingTimeoutMs: 1_000,
    autoRecover: false,
    spawnWorker: () => {
      child = new FakeChild(5101, handler);
      return child as unknown as ChildProcessWithoutNullStreams;
    }
  });
  manager.start();
  cleanups.push(async () => manager.stop());
  return {
    manager,
    getChild: () => {
      if (!child) throw new Error("fake worker was not created");
      return child;
    }
  };
}

function createCommand(database: DatabaseSync, id: string, kind: string, payload: unknown, targetRunId?: string): void {
  new CommandRepository(database).create({
    id,
    userId: OWNER,
    deviceId: DEVICE,
    sessionId: SESSION,
    scope: "s07",
    clientCommandId: id,
    kind,
    payload,
    ...(targetRunId ? { targetRunId } : {}),
    now: NOW
  });
}

const actor = { userId: OWNER, deviceId: DEVICE } as AuthContext;

describe("S07 command controls", () => {
  it("does not let a targeted abort or respond close the model Run", async () => {
    const data = await fixture();
    const { manager, getChild } = managerFor(data);
    createCommand(data.database, "model-command", "prompt", { text: "hold" });
    await manager.dispatch({
      sessionId: SESSION,
      commandId: "model-command",
      operationId: "model-operation",
      runId: "model-run",
      kind: "prompt",
      text: "hold"
    });
    await vi.waitFor(() => expect(loadReducerState(data.database, SESSION).commands["model-command"]?.state).toBe("accepted"));
    const child = getChild();

    createCommand(data.database, "abort-command", "abort", { targetRunId: "model-run" }, "model-run");
    await manager.sendControl(SESSION, "abort", { commandId: "abort-command", runId: "model-run" });
    outbound(child, "command_result", { commandId: "abort-command", status: "completed" });
    await vi.waitFor(() => expect(loadReducerState(data.database, SESSION).commands["abort-command"]?.state).toBe("completed"));

    expect(loadReducerState(data.database, SESSION).runs["model-run"]?.status).toBe("queued");
    expect(manager.activeRunCount).toBe(1);

    outbound(child, "command_result", { commandId: "model-command", status: "completed" });
    await vi.waitFor(() => expect(manager.activeRunCount).toBe(0));
    expect(loadReducerState(data.database, SESSION).runs["model-run"]?.status).toBe("completed");
  });

  it("releases a Run on a terminal projection and merges the later command_result", async () => {
    const data = await fixture();
    const { manager, getChild } = managerFor(data);
    createCommand(data.database, "projection-command", "prompt", { text: "projection" });
    await manager.dispatch({
      sessionId: SESSION,
      commandId: "projection-command",
      operationId: "projection-operation",
      runId: "projection-run",
      kind: "prompt",
      text: "projection"
    });
    await vi.waitFor(() => expect(manager.activeRunCount).toBe(1));
    const child = getChild();

    outbound(child, "event_batch", {
      batchNo: 77,
      events: [
        {
          schemaVersion: 1,
          sessionId: SESSION,
          seq: 1,
          runId: "projection-run",
          operationId: "projection-operation",
          type: "run.updated",
          timestamp: new Date(NOW).toISOString(),
          payload: { kind: "prompt", status: "completed", phase: null, source: "command", commandId: "projection-command" }
        },
        {
          schemaVersion: 1,
          sessionId: SESSION,
          seq: 2,
          runId: "projection-run",
          operationId: "projection-operation",
          type: "operation.updated",
          timestamp: new Date(NOW).toISOString(),
          payload: { operationId: "projection-operation", kind: "run", status: "completed", runId: "projection-run", commandId: "projection-command" }
        },
        {
          schemaVersion: 1,
          sessionId: SESSION,
          seq: 3,
          runId: null,
          operationId: null,
          type: "command.updated",
          timestamp: new Date(NOW).toISOString(),
          payload: {
            commandId: "projection-command",
            kind: "prompt",
            state: "completed",
            targetRunId: "projection-run",
            runs: [{ runId: "projection-run", sessionId: SESSION }]
          }
        }
      ]
    });
    await vi.waitFor(() => expect(manager.activeRunCount).toBe(0));

    outbound(child, "command_result", {
      commandId: "projection-command",
      status: "completed",
      result: { answer: "stored after projection" }
    });
    await vi.waitFor(() => expect(loadReducerState(data.database, SESSION).commands["projection-command"]?.result).toEqual({ answer: "stored after projection" }));
    expect(loadReducerState(data.database, SESSION).runs["projection-run"]?.status).toBe("completed");
    expect(new CommandRepository(data.database).get("projection-command")?.result).toEqual({ answer: "stored after projection" });
  });

  it("keeps follow_up durable, steers active input, and preserves idempotent receipts", async () => {
    const data = await fixture();
    const { manager, getChild } = managerFor(data);
    const service = new CommandService(data.database, manager);
    cleanups.push(async () => service.dispose());

    const first = await service.submit(actor, SESSION, { kind: "prompt", payload: { text: "first" } }, "00000000-0000-4000-8000-000000000001");
    const replay = await service.submit(actor, SESSION, { kind: "prompt", payload: { text: "first" } }, "00000000-0000-4000-8000-000000000001");
    expect(first).toEqual(replay);
    const child = getChild();
    await vi.waitFor(() => expect(child.executed).toHaveLength(1));

    const steer = await service.submit(actor, SESSION, { kind: "prompt", payload: { text: "steer now" } }, "00000000-0000-4000-8000-000000000002");
    expect(steer.status).toBe(202);
    await vi.waitFor(() => expect(child.controls.some((message) => message.type === "steer")).toBe(true));
    const followUp = await service.submit(actor, SESSION, { kind: "follow_up", payload: { text: "tail" } }, "00000000-0000-4000-8000-000000000003");
    expect(followUp.status).toBe(202);
    expect(loadReducerState(data.database, SESSION).queue.items).toHaveLength(1);
    expect(child.executed).toHaveLength(1);

    const conflict = service.submit(actor, SESSION, { kind: "prompt", payload: { text: "different" } }, "00000000-0000-4000-8000-000000000001");
    await expect(conflict).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" } satisfies Partial<CommandServiceError>);

    const promptCommandId = first.body.commandId;
    outbound(child, "command_result", { commandId: promptCommandId, status: "completed" });
    await vi.waitFor(() => expect(child.executed).toHaveLength(2));
    expect(loadReducerState(data.database, SESSION).queue.items).toHaveLength(1);
    outbound(child, "command_result", { commandId: loadReducerState(data.database, SESSION).queue.items[0]!.commandId, status: "completed" });
    await vi.waitFor(() => expect(loadReducerState(data.database, SESSION).queue.items).toHaveLength(0));
  });

  it.each(["cancelled", "failed"] as const)("pauses existing tails after a direct Run is %s without blocking fresh work", async (status) => {
    const data = await fixture();
    const { manager, getChild } = managerFor(data);
    const service = new CommandService(data.database, manager);
    cleanups.push(async () => service.dispose());
    const first = await service.submit(actor, SESSION, { kind: "prompt", payload: { text: "first" } }, "40000000-0000-4000-8000-000000000001");
    await vi.waitFor(() => expect(getChild().executed).toHaveLength(1));
    const tail = await service.submit(actor, SESSION, { kind: "follow_up", payload: { text: "old tail" } }, "40000000-0000-4000-8000-000000000002");
    outbound(getChild(), "command_result", { commandId: first.body.commandId, status });
    await vi.waitFor(() => expect(loadReducerState(data.database, SESSION).queue.state).toBe("paused"));
    const paused = loadReducerState(data.database, SESSION).queue;
    expect(paused.pause).toEqual({ runId: first.body.runId, reason: status === "cancelled" ? "aborted" : "failed" });
    expect(data.database.prepare("SELECT dispatched_at FROM commands WHERE id = ?").get(tail.body.commandId)?.dispatched_at).toBeNull();
    const fresh = await service.submit(actor, SESSION, { kind: "prompt", payload: { text: "fresh" } }, "40000000-0000-4000-8000-000000000003");
    await vi.waitFor(() => expect(getChild().executed).toHaveLength(2));
    outbound(getChild(), "command_result", { commandId: fresh.body.commandId, status: "completed" });
    await vi.waitFor(() => expect(loadReducerState(data.database, SESSION).commands[fresh.body.commandId]?.state).toBe("completed"));
    expect(loadReducerState(data.database, SESSION).queue).toEqual(paused);
    await service.submit(actor, SESSION, { kind: "cancel_queued", payload: { targetCommandId: tail.body.commandId } }, "40000000-0000-4000-8000-000000000004");
    expect(loadReducerState(data.database, SESSION).queue.state).toBe("ready");
    expect(loadReducerState(data.database, SESSION).queue.items).toHaveLength(0);
  });

  it("recovers a production follow_up without losing its queued Run or resending uncertain work", async () => {
    const data = await fixture();
    const { manager, getChild } = managerFor(data);
    const service = new CommandService(data.database, manager);
    cleanups.push(async () => service.dispose());
    const first = await service.submit(actor, SESSION, { kind: "prompt", payload: { text: "in flight" } }, "10000000-0000-4000-8000-000000000001");
    await vi.waitFor(() => expect(getChild().executed).toHaveLength(1));
    const tail = await service.submit(actor, SESSION, { kind: "follow_up", payload: { text: "keep all of this tail" } }, "10000000-0000-4000-8000-000000000002");
    const before = loadReducerState(data.database, SESSION);
    const item = before.queue.items[0]!;
    expect(item.commandId).toBe(tail.body.commandId);
    getChild().emit("exit", null, "SIGKILL");
    await vi.waitFor(() => expect(manager.activeWorkerCount).toBe(0));
    const after = loadReducerState(data.database, SESSION);
    expect(after.commands[first.body.commandId]?.state).toBe("unknown");
    expect(after.commands[tail.body.commandId]?.state).toBe("queued");
    expect(after.runs[item.runId]?.status).toBe("queued");
    expect(after.operations[after.runs[item.runId]!.operationId]?.status).toBe("running");
    expect(after.queue.items).toEqual(before.queue.items);
    expect(after.queue.state).toBe("paused");
    expect(new CommandRepository(data.database).get(tail.body.commandId)?.payload).toEqual({ kind: "follow_up", payload: { text: "keep all of this tail" } });
    new RecoveryManager(data.database).recoverSession(SESSION);
    expect(loadReducerState(data.database, SESSION).queue.items).toEqual(before.queue.items);
    await service.submit(actor, SESSION, { kind: "prompt", payload: { text: "new explicit intent" } }, "10000000-0000-4000-8000-000000000003");
    await vi.waitFor(() => expect(getChild().executed).toHaveLength(1));
    expect(getChild().executed[0]?.payload.text).toBe("new explicit intent");
  });

  it("associates a queued prompt with the destination when initialization replaces the native Session", async () => {
    const data = await fixture();
    const { manager, getChild } = managerFor(data, (message, child) => {
      if (message.type === "initialize" || message.type === "shutdown") baseWorkerHandler(message, child);
      else if (message.type === "session_mapping_ack") {
        outbound(child, "session_replace_intent", { requestId: "startup-replace", kind: "new", piSessionId: message.payload.piSessionId, piSessionFile: message.payload.piSessionFile });
      } else if (message.type === "session_replace_ack") {
        if (message.payload.phase === "intent") outbound(child, "session_replaced", { requestId: "startup-replace", piSessionId: "startup-destination-pi", piSessionFile: join(data.directory, "destination.jsonl"), persistenceState: "unflushed" });
        else outbound(child, "ready", { pid: child.pid, processGroupId: null, workerStartTicks: null, persistenceState: "unflushed" });
      } else if (message.type === "execute") {
        outbound(child, "command_accepted", { commandId: message.payload.commandId });
      }
    });
    const service = new CommandService(data.database, manager);
    cleanups.push(async () => service.dispose());
    const request = { kind: "prompt", payload: { text: "follow startup's current native session" } };
    const receipt = await service.submit(actor, SESSION, request, "30000000-0000-4000-8000-000000000001");
    await vi.waitFor(() => expect(getChild().executed).toHaveLength(1));
    const execution = getChild().executed[0]!.payload;
    const command = new CommandRepository(data.database).get(receipt.body.commandId)!;
    expect(command.sessionId).not.toBe(SESSION);
    expect(command.scope).toBe(`POST:/v1/sessions/${SESSION}/commands`);
    expect(command.payload).toEqual(request);
    expect(command.targetRunId).toBe(execution.runId);
    expect(loadReducerState(data.database, SESSION).runs[receipt.body.runId!]?.status).toBe("cancelled");
    expect(loadReducerState(data.database, command.sessionId!).runs[execution.runId!]?.status).toBe("queued");
    expect(manager.activeWorkerCount).toBe(1);
    outbound(getChild(), "command_result", { commandId: receipt.body.commandId, status: "completed" });
    await vi.waitFor(() => expect(loadReducerState(data.database, SESSION).commands[receipt.body.commandId]?.state).toBe("completed"));
    expect(loadReducerState(data.database, command.sessionId!).runs[execution.runId!]?.status).toBe("completed");
    expect(await service.submit(actor, SESSION, request, "30000000-0000-4000-8000-000000000001")).toEqual(receipt);
    expect(getChild().executed).toHaveLength(1);
  });

  it("dispatches user Bash during a model Run without consuming or releasing its lease", async () => {
    const data = await fixture();
    const { manager, getChild } = managerFor(data);
    const service = new CommandService(data.database, manager);
    cleanups.push(async () => service.dispose());
    await service.submit(actor, SESSION, { kind: "prompt", payload: { text: "model running" } }, "20000000-0000-4000-8000-000000000001");
    await vi.waitFor(() => expect(manager.activeRunCount).toBe(1));
    const bash = await service.submit(actor, SESSION, { kind: "bash", payload: { command: "printf hello", excludeFromContext: false } }, "20000000-0000-4000-8000-000000000002");
    await vi.waitFor(() => expect(getChild().executed).toHaveLength(2));
    expect(getChild().executed[1]?.payload.runId).toBeUndefined();
    expect(manager.activeRunCount).toBe(1);
    outbound(getChild(), "command_result", { commandId: bash.body.commandId, status: "completed" });
    await vi.waitFor(() => expect(loadReducerState(data.database, SESSION).commands[bash.body.commandId]?.state).toBe("completed"));
    expect(manager.activeRunCount).toBe(1);
  });

  it("enforces configuration CAS and persists the actual clamped value", async () => {
    const data = await fixture();
    const handler: InboundHandler = (message, child) => {
      baseWorkerHandler(message, child);
      if (message.type === "set_thinking") {
        outbound(child, "command_result", {
          commandId: message.payload.commandId ?? "missing-command",
          status: "completed",
          result: { actualConfig: { model: { provider: "test", id: "thinking-model" }, thinkingLevel: "medium" } }
        });
      }
    };
    const { manager } = managerFor(data, handler);
    const service = new CommandService(data.database, manager);
    cleanups.push(async () => service.dispose());

    const result = await service.submit(actor, SESSION, {
      kind: "set_thinking",
      payload: { expectedVersion: 1, level: "xhigh", persist: true }
    }, "00000000-0000-4000-8000-000000000004");
    expect(result.status).toBe(202);
    await vi.waitFor(() => {
      const state = loadReducerState(data.database, SESSION);
      expect(state.session.version).toBe(2);
      expect(state.session.thinkingLevel).toBe("medium");
      expect(state.session.actualConfig).toEqual({ model: { provider: "test", id: "thinking-model" }, thinkingLevel: "medium" });
    });
    await expect(service.submit(actor, SESSION, {
      kind: "set_thinking",
      payload: { expectedVersion: 0, level: "low" }
    }, "00000000-0000-4000-8000-000000000005")).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  });
});
