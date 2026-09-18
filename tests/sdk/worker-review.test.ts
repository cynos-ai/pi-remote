import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPiAgentSession, type PiAgentSessionHandle } from "../../packages/agent-pi/src/runtime.js";
import { PiWorker, type WorkerInboundMessage, type WorkerOutboundMessage, type WorkerExecutePayload } from "../../packages/agent-pi/src/worker.js";
import { snapshotSchema, toSnapshot, type ProtocolEvent, type ReducerState } from "../../packages/protocol/src/index.js";
import { DeviceRepository, EventStore, OwnerRepository, ProjectRepository, SessionRepository, loadReducerState, openServerDatabase } from "../../apps/server/src/storage/index.js";

// Only auth preflight and model transport are synthetic. The SDK creates its real
// copied partial messages, executes tools/Bash, emits queue events and writes JSONL.
// Production PiWorker source and SQLite EventStore handle every resulting event.
const sessionId = "worker-review-session";
const workerEpoch = "worker-review-epoch";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function waitFor(condition: () => unknown, description: string, timeout = 5000) {
  await vi.waitFor(() => expect(Boolean(condition()), description).toBe(true), { timeout, interval: 5 });
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function harness(options: { retry?: boolean; extensionSource?: (root: string) => string; beforeInitializeEditor?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-worker-review-"));
  const cwd = join(root, "project"), agentDir = join(root, "agent"), sessionDir = join(root, "sessions");
  await Promise.all([cwd, agentDir, sessionDir].map((path) => mkdir(path)));
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: options.retry ?? false, maxRetries: 1, baseDelayMs: 1 } }));
  if (options.extensionSource) {
    const extensionDir = join(agentDir, "extensions");
    await mkdir(extensionDir);
    await writeFile(join(extensionDir, "review.ts"), options.extensionSource(root));
  }
  const database = await openServerDatabase({ filename: join(root, "state.sqlite") });
  new OwnerRepository(database).ensure({ id: "owner", displayName: "synthetic owner" });
  new DeviceRepository(database).create({ id: "device", userId: "owner", name: "synthetic device", token: "synthetic-token" });
  new ProjectRepository(database).create({ id: "project", userId: "owner", name: "synthetic project", rootPath: cwd, workspaceKey: cwd, rootIdentity: cwd });
  new SessionRepository(database).create({ id: sessionId, projectId: "project", title: "worker review" });
  const store = new EventStore(database);
  const sent: WorkerOutboundMessage[] = [];
  const persistenceErrors: unknown[] = [];
  const persistenceNotifications: Array<{ fileExists: boolean }> = [];
  const acknowledged = new Set<number>();
  let automaticAcks = true;
  let seedBatch = 0;
  let handle!: PiAgentSessionHandle;
  const inbound = <T extends WorkerInboundMessage["type"]>(type: T, payload: Extract<WorkerInboundMessage, { type: T }>["payload"]) =>
    ({ ipcVersion: 1, sessionId, workerEpoch, type, payload }) as WorkerInboundMessage;
  const worker = new PiWorker({ send(message) {
    sent.push(message);
    if (message.type === "session_persisted") {
      const path = handle?.session.sessionFile;
      persistenceNotifications.push({ fileExists: Boolean(path && existsSync(path)) });
    }
    if (message.type === "session_mapping") setImmediate(() => { void worker.receive(inbound("session_mapping_ack", message.payload)); });
    if (message.type === "event_batch") {
      try { store.appendBatch({ sessionId, workerEpoch, batchNo: message.payload.batchNo, events: message.payload.events }); }
      catch (error) { persistenceErrors.push(error); }
      if (automaticAcks) setImmediate(() => { acknowledged.add(message.payload.batchNo); void worker.receive(inbound("batch_ack", { batchNo: message.payload.batchNo })); });
    }
  } }, { sessionId, workerEpoch, heartbeatMs: 60000, factory: async (input) => {
    handle = await createPiAgentSession({ ...input, resourceLoaderOptions: {
      noExtensions: options.extensionSource === undefined, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true
    } });
    // Synthetic auth is private to this temporary SDK runtime; never use host credentials.
    handle.session.modelRuntime.hasConfiguredAuth = () => true;
    handle.session.modelRuntime.getAuth = async () => ({ auth: { apiKey: "synthetic-test-key" }, env: {} });
    handle.session.setAutoRetryEnabled(options.retry ?? false);
    return handle;
  } });
  cleanup.push(async () => {
    if (handle) { await handle.session.abort(); handle.session.abortBash(); }
    worker.dispose();
    await tick();
    database.close();
    await rm(root, { recursive: true, force: true });
  });
  if (options.beforeInitializeEditor !== undefined) {
    await worker.receive(inbound("editor_state", { text: options.beforeInitializeEditor, requestId: "before-initialize-editor" }));
    expect(sent).toContainEqual({ ipcVersion: 1, sessionId, workerEpoch, type: "editor_state_ack", payload: { requestId: "before-initialize-editor" } });
  }
  await worker.receive(inbound("initialize", { cwd, agentDir, sessionDir, operationId: "initialize-op" }));
  await waitFor(() => sent.some((message) => message.type === "ready"), "worker initialized");
  await tick();
  const events = () => sent.flatMap((message) => message.type === "event_batch" ? message.payload.events : []);
  const result = (commandId: string) => sent.find((message) => message.type === "command_result" && message.payload.commandId === commandId);
  const seed = (payload: WorkerExecutePayload) => {
    const runId = payload.runId ?? null;
    const operationKind = payload.kind === "bash" ? "bash" : payload.kind === "extension_command" ? "extension" : "run";
    const envelope = { schemaVersion: 1, sessionId, seq: 1, operationId: payload.operationId, runId, timestamp: new Date().toISOString() };
    const initial: unknown[] = [
      { ...envelope, type: "command.updated", payload: { commandId: payload.commandId, kind: payload.kind, state: "queued" } },
      { ...envelope, type: "operation.updated", payload: { operationId: payload.operationId, kind: operationKind, status: "running", commandId: payload.commandId, ...(runId ? { runId } : {}) } }
    ];
    if (runId) initial.push({ ...envelope, type: "run.updated", payload: { kind: payload.kind, status: "queued", phase: "queued", source: "command", commandId: payload.commandId } });
    store.appendBatch({ sessionId, workerEpoch: "server-seed", batchNo: ++seedBatch, events: initial });
  };
  return { root, cwd, handle, worker, sent, events, result, database, persistenceNotifications,
    async execute(payload: WorkerExecutePayload) {
      seed(payload);
      if (payload.runId) expect(loadReducerState(database, sessionId).runs[payload.runId]).toMatchObject({ status: "queued", phase: "queued" });
      await worker.receive(inbound("execute", payload));
    },
    async receive<T extends WorkerInboundMessage["type"]>(type: T, payload: Extract<WorkerInboundMessage, { type: T }>["payload"]) { await worker.receive({ ipcVersion: 1, sessionId, workerEpoch, type, payload } as WorkerInboundMessage); },
    async completed(commandId: string) {
      await waitFor(() => result(commandId), `command ${commandId} completed`);
      await tick();
      return result(commandId)!;
    },
    state(): ReducerState {
      expect(persistenceErrors.map((error) => String(error)), "every emitted batch must be accepted by EventStore").toEqual([]);
      expect(sent.filter((message) => message.type === "fatal"), "worker must not emit fatal adapter/backpressure errors").toEqual([]);
      return loadReducerState(database, sessionId);
    },
    holdAcks() { automaticAcks = false; },
    async releaseAcks() {
      automaticAcks = true;
      for (const message of [...sent]) if (message.type === "event_batch" && !acknowledged.has(message.payload.batchNo)) {
        acknowledged.add(message.payload.batchNo);
        await worker.receive(inbound("batch_ack", { batchNo: message.payload.batchNo }));
      }
      await tick();
    }
  };
}

type SdkMessage = Parameters<PiAgentSessionHandle["sessionManager"]["appendMessage"]>[0];
type AssistantMessage = Extract<SdkMessage, { role: "assistant" }>;
type StreamFunction = NonNullable<PiAgentSessionHandle["session"]["agent"]["streamFunction"]>;
interface StreamPlan { error?: string; toolCommand?: string; thinking?: string[]; text?: string[]; gate?: ReturnType<typeof deferred> }
function deterministicStream(handle: PiAgentSessionHandle, plans: StreamPlan[]) {
  let calls = 0;
  handle.session.agent.streamFunction = (model, _context, options) => {
    const plan = plans[calls++];
    if (!plan) throw new Error(`unexpected model call ${calls}; deterministic plans exhausted`);
    const partial: AssistantMessage = {
      role: "assistant", api: model.api, provider: model.provider, model: model.id,
      content: [], timestamp: Date.now(), stopReason: plan.error ? "error" : plan.toolCommand ? "toolUse" : "stop",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      ...(plan.error ? { errorMessage: plan.error } : {})
    };
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: "start", partial };
        if (plan.thinking) {
          const block = { type: "thinking" as const, thinking: "" };
          const contentIndex = partial.content.push(block) - 1;
          yield { type: "thinking_start", contentIndex, partial };
          for (const delta of plan.thinking) { block.thinking += delta; yield { type: "thinking_delta", contentIndex, delta, partial }; }
          yield { type: "thinking_end", contentIndex, content: block.thinking, partial };
        }
        const block = { type: "text" as const, text: "" };
        const contentIndex = partial.content.push(block) - 1;
        yield { type: "text_start", contentIndex, partial };
        for (const delta of plan.text ?? ["deterministic-", "stream-", "complete"]) {
          block.text += delta;
          yield { type: "text_delta", contentIndex, delta, partial };
        }
        if (plan.gate) {
          const abort = () => plan.gate!.resolve();
          options?.signal?.addEventListener("abort", abort, { once: true });
          if (options?.signal?.aborted) abort();
          await plan.gate.promise;
          options?.signal?.removeEventListener("abort", abort);
        }
        if (options?.signal?.aborted) {
          partial.stopReason = "aborted";
          yield { type: "error", reason: "aborted", error: partial };
          return;
        }
        yield { type: "text_end", contentIndex, content: block.text, partial };
        if (plan.toolCommand) {
          const toolCall = { type: "toolCall" as const, id: `bash-call-${calls}`, name: "bash", arguments: { command: plan.toolCommand } };
          const toolIndex = partial.content.push(toolCall) - 1;
          yield { type: "toolcall_start", contentIndex: toolIndex, partial };
          const json = JSON.stringify(toolCall.arguments);
          for (const delta of [json.slice(0, 15), json.slice(15)]) yield { type: "toolcall_delta", contentIndex: toolIndex, delta, partial };
          yield { type: "toolcall_end", contentIndex: toolIndex, toolCall, partial };
        }
        yield plan.error ? { type: "error", reason: "error", error: partial } : { type: "done", reason: partial.stopReason, message: partial };
      },
      async result() { return partial; }
    } as unknown as ReturnType<StreamFunction>;
  };
  return () => calls;
}
function prompt(commandId = "prompt-command"): WorkerExecutePayload {
  return { kind: "prompt", text: "Synthetic worker regression", commandId, operationId: `${commandId}-op`, runId: `${commandId}-run` };
}
function assistantCompletions(events: ProtocolEvent[]) {
  return events.filter((event) => event.type === "message.completed").filter((event) => event.payload.role === "assistant");
}
function expectClosed(state: ReducerState) {
  expect(state.liveItems).toEqual({});
  expect(Object.values(state.operations).filter((operation) => operation.status === "running" || operation.status === "waiting_input")).toEqual([]);
}

describe("real SDK worker review regressions", () => {
  it("R01 keeps stable message/block IDs across copied partials, thinking, tool arguments and a second turn", async () => {
    const h = await harness();
    const calls = deterministicStream(h.handle, [
      { thinking: ["inspect ", "then execute"], text: ["one ", "two"], toolCommand: "printf 'real-tool-marker\\n'" },
      { text: ["tool ", "finished"] }
    ]);
    await h.execute(prompt());
    expect(await h.completed("prompt-command")).toMatchObject({ payload: { status: "completed" } });
    const events = h.events();
    const runningIndex = events.findIndex((event) => event.type === "run.updated" && event.runId === "prompt-command-run" && event.payload.status === "running");
    const firstContentIndex = events.findIndex((event) => event.type === "message.started" && event.runId === "prompt-command-run");
    expect(runningIndex, "worker must promote the queued Run before SDK content starts").toBeGreaterThanOrEqual(0);
    expect(firstContentIndex).toBeGreaterThan(runningIndex);
    const starts = events.filter((event) => event.type === "message.started").filter((event) => event.payload.role === "assistant");
    const ends = assistantCompletions(events);
    expect(starts).toHaveLength(2);
    expect(ends).toHaveLength(2);
    expect(starts.map((event) => event.payload.messageId)).toEqual(ends.map((event) => event.payload.messageId));
    expect(new Set(starts.map((event) => event.payload.messageId)).size).toBe(2);
    expect(events.filter((event) => event.type === "content.delta")).toHaveLength(8);
    expect(events.find((event) => event.type === "tool.finished")).toMatchObject({ payload: { isError: false, output: { text: expect.stringContaining("real-tool-marker") } } });
    expect(calls()).toBe(2);
    const state = h.state();
    expect(state.runs["prompt-command-run"]?.status).toBe("completed");
    expectClosed(state);
  });

  it("R02 fails a normally-resolved prompt whose final SDK message carries stopReason=error", async () => {
    const h = await harness();
    deterministicStream(h.handle, [{ text: ["partial-before-error"], error: "synthetic provider failure" }]);
    await h.execute(prompt());
    expect(await h.completed("prompt-command")).toMatchObject({ payload: { status: "failed", error: { message: "synthetic provider failure" } } });
    const state = h.state();
    expect(state.runs["prompt-command-run"]?.status).toBe("failed");
    expect(state.commands["prompt-command"]?.state).toBe("failed");
    expect(JSON.stringify(state.timelineItems)).toContain("partial-before-error");
    expectClosed(state);
  });

  it("R02 reports success after real SDK auto-retry, using the final attempt outcome", async () => {
    const h = await harness({ retry: true });
    const calls = deterministicStream(h.handle, [{ error: "429 rate limit exceeded" }, { text: ["retry succeeded"] }]);
    const sdkRetries: string[] = [];
    h.handle.onEvent((event) => { if (event.type === "auto_retry_start" || event.type === "auto_retry_end") sdkRetries.push(event.type); });
    await h.execute(prompt());
    expect(await h.completed("prompt-command")).toMatchObject({ payload: { status: "completed" } });
    expect(calls()).toBe(2);
    expect(sdkRetries).toContain("auto_retry_start");
    expect(h.state().runs["prompt-command-run"]?.status).toBe("completed");
    expectClosed(h.state());
  });

  it("R02 does not classify an entire successful model turn as failed just because Bash tool execution failed", async () => {
    const h = await harness();
    deterministicStream(h.handle, [{ toolCommand: "printf 'tool-failed-marker\\n'; exit 7" }, { text: ["handled tool failure"] }]);
    await h.execute(prompt());
    expect(await h.completed("prompt-command")).toMatchObject({ payload: { status: "completed" } });
    expect(h.events().find((event) => event.type === "tool.finished")).toMatchObject({ payload: { isError: true } });
    expectClosed(h.state());
  });

  it("R03 stop returns duplicate-text steer/follow-up drafts intact despite synchronous SDK queue_update", async () => {
    const h = await harness();
    const gate = deferred();
    deterministicStream(h.handle, [{ gate, text: ["partial-before-abort"] }]);
    await h.execute(prompt());
    await waitFor(() => h.events().some((event) => event.type === "content.delta" && event.runId === "prompt-command-run"), "model emitted a partial before control");
    expect(h.state().runs["prompt-command-run"]?.status, "streaming Run must be running before controls target it").toBe("running");
    for (const [type, inputId] of [["steer", "steer-a"], ["steer", "steer-b"], ["follow_up", "follow-a"]] as const) {
      await h.receive(type, { inputId, operationId: "prompt-command-op", runId: "prompt-command-run", text: "duplicate draft", content: { text: "duplicate draft", attachments: [{ artifactId: inputId, mimeType: "image/png" }] } });
    }
    await waitFor(() => h.handle.session.getSteeringMessages().length === 2 && h.handle.session.getFollowUpMessages().length === 1, "SDK queues populated");
    const queueSnapshots: number[] = [];
    h.handle.onEvent((event) => { if (event.type === "queue_update") queueSnapshots.push(event.steering.length + event.followUp.length); });
    await h.receive("abort", { runId: "prompt-command-run" });
    expect(await h.completed("prompt-command")).toMatchObject({ payload: { status: "cancelled" } });
    expect(h.state().runs["prompt-command-run"]?.status).toBe("aborted");
    expect(queueSnapshots).toContain(0);
    expect(h.handle.session.getSteeringMessages()).toEqual([]);
    expect(h.handle.session.getFollowUpMessages()).toEqual([]);
    for (const inputId of ["steer-a", "steer-b", "follow-a"]) {
      expect(h.events().filter((event) => event.type === "input.updated").filter((event) => event.payload.inputId === inputId).map((event) => event.payload.state)).toEqual(["queued", "returned"]);
      expect(h.state().inputs[inputId]).toMatchObject({ content: { text: "duplicate draft", attachments: [{ artifactId: inputId, mimeType: "image/png" }] }, state: "returned" });
    }
    expectClosed(h.state());
  });

  it("R07 persists incremental Bash output with no Run while a model remains active", async () => {
    const h = await harness();
    const gate = deferred();
    deterministicStream(h.handle, [{ gate }]);
    await h.execute(prompt());
    await waitFor(() => h.events().some((event) => event.type === "content.delta" && event.runId === "prompt-command-run"), "model emitted a partial before control");
    expect(h.state().runs["prompt-command-run"]?.status, "streaming Run must be running before controls target it").toBe("running");
    await h.execute({ kind: "bash", commandId: "bash-command", operationId: "bash-op", command: "printf 'first-bash-chunk\\n'; sleep 0.1; printf 'last-bash-chunk\\n'", excludeFromContext: true });
    expect(await h.completed("bash-command")).toMatchObject({ payload: { status: "completed", result: { exitCode: 0, output: expect.stringContaining("last-bash-chunk") } } });
    expect(h.result("prompt-command")).toBeUndefined();
    const content = h.events().filter((event) => event.operationId === "bash-op");
    expect(content.filter((event) => event.type === "content.delta").length).toBeGreaterThanOrEqual(2);
    expect(content.find((event) => event.type === "message.completed")).toMatchObject({ runId: null, payload: { role: "bash", bash: { outcome: "succeeded", excludeFromContext: true } } });
    gate.resolve();
    await h.completed("prompt-command");
    expectClosed(h.state());
  });

  it("R07 preserves nonzero Bash exit/output and cancellation in the timeline", async () => {
    const h = await harness();
    await h.execute({ kind: "bash", commandId: "nonzero", operationId: "nonzero-op", command: "printf 'nonzero-output\\n'; exit 7" });
    expect(await h.completed("nonzero")).toMatchObject({ payload: { result: { exitCode: 7, output: expect.stringContaining("nonzero-output") } } });
    expect(h.events().find((event) => event.type === "message.completed" && event.operationId === "nonzero-op")).toMatchObject({ payload: { bash: { exitCode: 7, outcome: "failed" } } });
    await h.execute({ kind: "bash", commandId: "cancel-bash", operationId: "cancel-bash-op", command: "printf 'before-bash-cancel\\n'; sleep 30" });
    await waitFor(() => h.events().some((event) => event.type === "content.delta" && event.operationId === "cancel-bash-op"), "Bash emitted before cancellation");
    await h.receive("abort_bash", {});
    expect(await h.completed("cancel-bash")).toMatchObject({ payload: { status: "cancelled" } });
    expect(h.events().find((event) => event.type === "message.completed" && event.operationId === "cancel-bash-op")).toMatchObject({ payload: { bash: { outcome: "aborted", cancelled: true } } });
    expect(JSON.stringify(h.state().timelineItems)).toContain("before-bash-cancel");
    expectClosed(h.state());
  });

  it("R09 persists idle SDK custom content with an owned, completed Operation and no command or Run", async () => {
    const h = await harness();
    await h.handle.session.sendCustomMessage({ customType: "review.status", content: "idle custom marker", display: true }, { triggerTurn: false });
    await waitFor(() => h.events().some((event) => event.type === "message.completed" && event.payload.role === "custom"), "idle custom event persisted");
    expect(h.handle.sessionManager.getEntries().some((entry) => entry.type === "custom_message" && entry.customType === "review.status")).toBe(true);
    const state = h.state();
    const item = state.timelineItems.find((item) => item.kind === "message" && item.data.role === "custom");
    expect(item).toMatchObject({ runId: null, completeness: "complete", data: { custom: { type: "review.status", display: true } } });
    expect(state.operations[item!.operationId]).toMatchObject({ kind: "extension", status: "completed", commandId: null });
    expect(state.commands).toEqual({});
    expect(state.runs).toEqual({});
    expectClosed(state);
  });

  it("R09 assigns autonomous SDK turns a Run without inventing an external Command", async () => {
    const h = await harness();
    deterministicStream(h.handle, [{ text: ["autonomous model marker"] }]);
    await h.handle.session.sendCustomMessage({ customType: "review.trigger", content: "autonomous custom marker", display: true }, { triggerTurn: true });
    await waitFor(() => h.events().some((event) => event.type === "run.updated" && event.payload.status === "completed"), "autonomous run completed");
    const state = h.state();
    expect(state.commands).toEqual({});
    expect(Object.values(state.runs)).toHaveLength(1);
    expect(Object.values(state.runs)[0]).toMatchObject({ source: "runtime", status: "completed", commandId: null });
    expect(JSON.stringify(state.timelineItems)).toContain("autonomous model marker");
    expectClosed(state);
  });

  it("R06 reports unflushed mapping despite SDK persistence being enabled, and notifies only after the file is written", async () => {
    const h = await harness();
    expect(h.handle.sessionManager.isPersisted(), "SDK flag means persistence is enabled").toBe(true);
    const mapping = h.sent.find((message) => message.type === "session_mapping")!;
    expect(mapping.payload).toMatchObject({ persistenceState: "unflushed", fileState: "missing" });
    expect(h.sent.find((message) => message.type === "ready")?.payload).toMatchObject({ persistenceState: "unflushed" });
    await expect(readFile(mapping.payload.piSessionFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(h.persistenceNotifications).toEqual([]);
    const gate = deferred();
    deterministicStream(h.handle, [{ gate, text: ["flush-on-completion-marker"] }]);
    await h.execute(prompt());
    await waitFor(() => h.events().some((event) => event.type === "content.delta"), "SDK has emitted a streaming partial");
    expect(h.persistenceNotifications).toEqual([]);
    await expect(readFile(mapping.payload.piSessionFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    gate.resolve();
    await h.completed("prompt-command");
    expect(h.persistenceNotifications.length).toBeGreaterThan(0);
    expect(h.persistenceNotifications.every((observation) => observation.fileExists)).toBe(true);
    const jsonl = await readFile(mapping.payload.piSessionFile, "utf8");
    expect(JSON.parse(jsonl.split("\n")[0]!)).toMatchObject({ type: "session", id: mapping.payload.piSessionId });
    expect(jsonl).toContain("flush-on-completion-marker");
    expectClosed(h.state());
  });

  it("R10 real extension reads pre-initialize editor state and preserves standard UI notices in snapshots", async () => {
    const h = await harness({ beforeInitializeEditor: "draft before initialize\n第二行", extensionSource: () => `
export default function(pi) {
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setStatus("startup-editor", ctx.ui.getEditorText());
    ctx.ui.setWidget("review-widget", ["first widget line", "second widget line"]);
    ctx.ui.setEditorText("extension replacement");
    ctx.ui.pasteToEditor(" + pasted");
    ctx.ui.setStatus("after-paste", ctx.ui.getEditorText());
  });
  pi.registerCommand("review-editor", { description: "Read synchronized editor", handler: async (_args, ctx) => {
    ctx.ui.setStatus("updated-editor", ctx.ui.getEditorText());
    ctx.ui.setWidget("review-widget", undefined);
  }});
}` });
    const ackIndex = h.sent.findIndex((message) => message.type === "editor_state_ack" && message.payload.requestId === "before-initialize-editor");
    expect(ackIndex).toBeGreaterThanOrEqual(0);
    expect(ackIndex).toBeLessThan(h.sent.findIndex((message) => message.type === "session_mapping"));
    await h.receive("editor_state", { text: "new mobile draft", requestId: "updated-editor" });
    expect(h.sent).toContainEqual({ ipcVersion: 1, sessionId, workerEpoch, type: "editor_state_ack", payload: { requestId: "updated-editor" } });
    await h.execute({ kind: "extension_command", text: "/review-editor", commandId: "editor-command", operationId: "editor-op" });
    expect(await h.completed("editor-command")).toMatchObject({ payload: { status: "completed" } });
    const state = h.state();
    const snapshot = snapshotSchema.parse(toSnapshot(state));
    const ui = snapshot.notices.filter((notice) => notice.kind === "extension_ui");
    expect(ui.map((notice) => notice.details)).toEqual([
      { method: "setStatus", args: ["startup-editor", "draft before initialize\n第二行"] },
      { method: "setWidget", args: ["review-widget", ["first widget line", "second widget line"]] },
      { method: "setEditorText", args: ["extension replacement"] },
      { method: "setEditorText", args: ["extension replacement + pasted"] },
      { method: "setStatus", args: ["after-paste", "extension replacement + pasted"] },
      { method: "setStatus", args: ["updated-editor", "new mobile draft"] },
      { method: "setWidget", args: ["review-widget", null] }
    ]);
    expect(snapshot.notices).toEqual(state.notices);
    expect(snapshotSchema.parse({ ...snapshot, notices: undefined }).notices).toEqual([]);
    expect(h.sent.filter((message) => message.type === "extension_error")).toEqual([]);
  });

  it("R10 delayed native thinking hook opens a child Operation after the configure method has returned", async () => {
    const h = await harness({ extensionSource: (root) => `
import { existsSync } from "node:fs";
export default function(pi) {
  pi.on("thinking_level_select", async (_event, ctx) => {
    if (!existsSync(${JSON.stringify(join(root, "arm-thinking-hook"))})) return;
    const deadline = Date.now() + 4000;
    while (!existsSync(${JSON.stringify(join(root, "release-thinking-hook"))})) {
      if (Date.now() > deadline) throw new Error("test did not release thinking hook");
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    const confirmed = await ctx.ui.confirm("Delayed thinking hook", "Continue after configuration returned?");
    ctx.ui.setStatus("delayed-thinking-result", String(confirmed));
  });
}` });
    const reasoningModel = h.handle.services.modelRuntime.getModels().find((model) => model.provider === "anthropic" && model.reasoning);
    expect(reasoningModel, "SDK catalog contains a reasoning-capable model").toBeDefined();
    await h.handle.services.modelRuntime.setRuntimeApiKey(reasoningModel!.provider, "synthetic-test-key");
    await h.handle.session.setModel(reasoningModel!, { persist: false });
    await writeFile(join(h.root, "arm-thinking-hook"), "armed after fixture model selection");
    const levels = h.handle.session.getAvailableThinkingLevels();
    const level = levels.find((candidate) => candidate !== h.handle.session.thinkingLevel);
    expect(level, "real SDK model supports a different thinking level").toBeDefined();
    const envelope = { schemaVersion: 1, sessionId, seq: 1, operationId: "thinking-op", runId: null, timestamp: new Date().toISOString() };
    new EventStore(h.database).appendBatch({ sessionId, workerEpoch: "thinking-seed", batchNo: 1, events: [
      { ...envelope, type: "command.updated", payload: { commandId: "thinking-command", kind: "set_thinking", state: "queued" } },
      { ...envelope, type: "operation.updated", payload: { operationId: "thinking-op", kind: "configure", status: "running", commandId: "thinking-command" } }
    ] });
    await h.receive("set_thinking", { level: level!, operationId: "thinking-op", commandId: "thinking-command" });
    expect(await h.completed("thinking-command")).toMatchObject({ payload: { status: "completed" } });
    expect(h.state().operations["thinking-op"]?.status).toBe("completed");
    expect(h.events().filter((event) => event.type === "interaction.requested")).toEqual([]);
    await writeFile(join(h.root, "release-thinking-hook"), "release");
    await waitFor(() => h.events().some((event) => event.type === "interaction.requested" && event.payload.title === "Delayed thinking hook"), "native async hook requested a form after return");
    const form = h.events().filter((event) => event.type === "interaction.requested").find((event) => event.payload.title === "Delayed thinking hook")!;
    expect(form.operationId).not.toBe("thinking-op");
    expect(form.runId).toBeNull();
    expect(form.payload.origin).toBe("extension");
    expect(h.state().operations[form.operationId!]).toMatchObject({ parentOperationId: "thinking-op", kind: "extension", status: "waiting_input" });
    await h.receive("respond", { operationId: form.operationId!, interactionId: form.payload.interactionId, response: { confirmed: true } });
    await waitFor(() => h.events().some((event) => event.type === "runtime.notice" && JSON.stringify(event.payload.details?.args) === JSON.stringify(["delayed-thinking-result", "true"])), "native thinking hook resumed once");
    await tick();
    const state = h.state();
    expect(state.interactions[form.payload.interactionId]).toMatchObject({ status: "resolved", response: { confirmed: true } });
    expect(state.operations[form.operationId!]?.status).toBe("completed");
    expect(state.operations["thinking-op"]?.status).toBe("completed");
    expect(h.events().filter((event) => event.type === "interaction.resolved")).toHaveLength(1);
    expect(snapshotSchema.parse(toSnapshot(state)).notices).toContainEqual(expect.objectContaining({ details: { method: "setStatus", args: ["delayed-thinking-result", "true"] } }));
    expect(h.sent.filter((message) => message.type === "extension_error")).toEqual([]);
  });

  it("R15 retains output beyond 256 held ACKs, then drains ordered bounded batches without fatal backpressure", async () => {
    const h = await harness();
    vi.stubEnv("PI_REMOTE_WORKER_SPOOL_DIR", join(h.root, "spool"));
    h.holdAcks();
    const initialBatchCount = h.sent.filter((message) => message.type === "event_batch").length;
    for (let index = 0; index < 270; index++) {
      await h.handle.session.sendCustomMessage({ customType: "review.backlog", content: `backlog-marker-${index}`, display: true }, { triggerTurn: false });
      if (index < 256) await waitFor(() => h.sent.filter((message) => message.type === "event_batch").length >= initialBatchCount + index + 1, `batch ${index + 1} reached transport`);
    }
    expect(h.sent.filter((message) => message.type === "event_batch")).toHaveLength(initialBatchCount + 256);
    expect(h.sent.filter((message) => message.type === "fatal")).toEqual([]);
    deterministicStream(h.handle, [{ text: ["after-backlog-model-marker"] }]);
    await h.execute(prompt("backlogged-command"));
    await waitFor(() => h.handle.sessionManager.getEntries().some((entry) =>
      entry.type === "message" && entry.message.role === "assistant" && JSON.stringify(entry.message).includes("after-backlog-model-marker")
    ), "SDK completed while outbound events were backlogged");
    await h.handle.session.waitForIdle();
    await tick();
    expect(h.result("backlogged-command"), "terminal command result must not overtake unsent content").toBeUndefined();
    await h.releaseAcks();
    expect(await h.completed("backlogged-command")).toMatchObject({ payload: { status: "completed" } });
    await waitFor(() => h.events().filter((event) => event.type === "message.completed" && event.payload.role === "custom").length === 270, "all backlogged custom messages drained");
    const batches = h.sent.filter((message) => message.type === "event_batch");
    expect(batches.map((message) => message.payload.batchNo)).toEqual(batches.map((_, index) => index + 1));
    expect(batches.every((message) => message.payload.events.length <= 500)).toBe(true);
    const state = h.state();
    expect(state.timelineItems.filter((item) => item.kind === "message" && item.data.role === "custom").map((item) => item.kind === "message" && item.data.blocks[0]?.kind === "text" ? item.data.blocks[0].text : "")).toEqual(Array.from({ length: 270 }, (_, index) => `backlog-marker-${index}`));
    expectClosed(state);
  }, 15000);
});
