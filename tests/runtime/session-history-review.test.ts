import type { WorkerInboundMessage as Inbound, WorkerOutboundMessage as Outbound } from "../../packages/agent-pi/src/worker.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectPiSessionFile, openPiSessionFile } from "../../packages/agent-pi/src/session-file.js";
import { createPiAgentSession, createPiAgentRuntime, createPiWorkerSession, readPiModelCatalog } from "../../packages/agent-pi/src/runtime.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "pi-history-review-"));
  roots.push(cwd);
  const agentDir = join(cwd, "agent");
  const sessionDir = join(cwd, "sessions");
  await Promise.all([mkdir(agentDir), mkdir(sessionDir)]);
  return { cwd, agentDir, sessionDir, sessionFile: join(sessionDir, "known.jsonl"), noTools: "all" as const,
    resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true } };
}
const timestamp = "2026-09-15T00:00:00.000Z";
const entry = (id: string, parentId: string | null = null) => ({ type: "session_info", id, parentId, timestamp, name: id });
const header = (cwd: string) => ({ type: "session", version: 3, id: "recorded-id", timestamp, cwd });
const jsonl = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join("\n") + "\n";

describe("R05 strict JSONL validation", () => {
  for (const [name, tail] of [
    ["truncated final line", '{"type":"message"'],
    ["bad middle line", 'broken\n' + JSON.stringify(entry("a"))],
    ["null", "null"], ["array", "[]"],
    ["duplicate ID", jsonl([entry("a"), entry("a", "a")])],
    ["missing ID", jsonl([{ ...entry("a"), id: undefined }])],
    ["self parent", jsonl([entry("a", "a")])],
    ["forward parent", jsonl([entry("a", "b"), entry("b")])],
    ["second header", jsonl([{ type: "session", id: "other" }])],
    ["invalid message", jsonl([{ ...entry("a"), type: "message", message: null }])],
    ["missing label target", jsonl([{ ...entry("a"), type: "label", targetId: "missing" }])],
    ["missing compaction reference", jsonl([{ ...entry("a"), type: "compaction", summary: "x", tokensBefore: 1, firstKeptEntryId: "missing" }])]
  ]) {
    it(`rejects ${name} without changing bytes`, async () => {
      const f = await fixture();
      const content = jsonl([header(f.cwd)]) + tail;
      await writeFile(f.sessionFile, content);
      const state = await inspectPiSessionFile(f.sessionFile, f.cwd);
      expect(state.kind).toBe("invalid");
      if (state.kind === "invalid") expect(state.reason).toMatch(/line \d+/);
      await expect(openPiSessionFile({ path: f.sessionFile, cwd: f.cwd, persistenceState: "persisted", sessionId: "recorded-id" })).rejects.toThrow();
      expect(await readFile(f.sessionFile, "utf8")).toBe(content);
    });
  }
  it("accepts header-only, non-assistant branches, root reset and fork summaries", async () => {
    const f = await fixture();
    for (const rows of [[], [entry("a"), entry("b", "a"), entry("c", "a"), entry("d"),
      { ...entry("e", "d"), type: "branch_summary", fromId: "source-branch-not-in-fork", summary: "summary" },
      { ...entry("f", "e"), type: "label", targetId: "a", label: "bookmark" }]]) {
      const content = jsonl([header(f.cwd), ...rows]);
      await writeFile(f.sessionFile, content);
      const opened = await openPiSessionFile({ path: f.sessionFile, cwd: f.cwd, sessionId: "recorded-id", persistenceState: "persisted" });
      expect(opened.manager.getSessionId()).toBe("recorded-id");
      expect(opened.manager.getEntries()).toHaveLength(rows.length);
      expect(await readFile(f.sessionFile, "utf8")).toBe(content);
    }
  });
  it("supports native legacy migration after strict parsing", async () => {
    const f = await fixture();
    await writeFile(f.sessionFile, jsonl([{ ...header(f.cwd), version: 1 }, { type: "message", timestamp, message: { role: "user", content: "hello", timestamp: 1 } }]));
    const opened = await openPiSessionFile({ path: f.sessionFile, cwd: f.cwd, persistenceState: "persisted", sessionId: "recorded-id" });
    expect(opened.manager.getEntries()[0]?.id).toBeTruthy();
  });
});

describe("R06 persisted-state recovery", () => {
  it("preserves identity through repeated unflushed reopen and actual first flush", async () => {
    const f = await fixture();
    let path = f.sessionFile;
    for (let i = 0; i < 3; i++) {
      const handle = await createPiAgentSession({ ...f, sessionFile: path, sessionId: "recorded-id", persistenceState: "unflushed" });
      expect(handle.session.sessionId).toBe("recorded-id");
      expect(handle.sessionFileState?.kind).toBe("missing");
      path = handle.session.sessionFile!;
      expect((await inspectPiSessionFile(path)).kind).toBe("missing");
      handle.dispose();
    }
    const { manager } = await openPiSessionFile({ path, cwd: f.cwd, sessionId: "recorded-id", persistenceState: "unflushed" });
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "done" }], api: "openai-responses", provider: "openai", model: "synthetic", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 1 });
    const resumed = await openPiSessionFile({ path: manager.getSessionFile()!, cwd: f.cwd, sessionId: "recorded-id", persistenceState: "persisted" });
    expect(resumed.manager.getSessionId()).toBe("recorded-id");
    expect(resumed.manager.getEntries()).toHaveLength(1);
  });
  for (const persistenceState of ["unflushed", "persisted"] as const) {
    for (const mode of ["empty", "wrong-id", "wrong-cwd"] as const) it(`protects ${persistenceState} ${mode}`, async () => {
      const f = await fixture();
      const content = mode === "empty" ? "" : jsonl([{ ...header(f.cwd), ...(mode === "wrong-id" ? { id: "foreign" } : { cwd: join(f.cwd, "foreign") }) }]);
      await writeFile(f.sessionFile, content);
      await expect(createPiAgentSession({ ...f, sessionId: "recorded-id", persistenceState })).rejects.toThrow();
      expect(await readFile(f.sessionFile, "utf8")).toBe(content);
    });
  }
  it("blocks missing persisted history and accepts matching header before persistence marker", async () => {
    const f = await fixture();
    await expect(createPiAgentSession({ ...f, sessionId: "recorded-id", persistenceState: "persisted" })).rejects.toThrow(/missing/);
    expect((await inspectPiSessionFile(f.sessionFile)).kind).toBe("missing");
    await writeFile(f.sessionFile, jsonl([header(f.cwd)]));
    const handle = await createPiAgentSession({ ...f, sessionId: "recorded-id", persistenceState: "unflushed" });
    expect(handle.session.sessionId).toBe("recorded-id");
    expect(handle.sessionFileState?.kind).toBe("persisted");
    handle.dispose();
  });
});

it("R09 worker facade runs native actions and gates continuations on mapping", async () => {
  const f = await fixture();
  const observations: string[] = [];
  const handle = await createPiWorkerSession({ ...f, sessionFile: undefined,
    onBeforeSessionReplace: async (request) => { observations.push(`intent:${request.kind}`); },
    onSessionReplaced: async (session) => { observations.push(`mapping:${session.sessionId}`); }
  });
  try {
    const bind = vi.spyOn(handle.session, "bindExtensions");
    await handle.bindExtensions({});
    const actions = bind.mock.calls[0]![0]!.commandContextActions!;
    const firstId = handle.session.sessionId;
    await actions.newSession({ withSession: async () => { observations.push("continuation"); } });
    expect(handle.session.sessionId).not.toBe(firstId);
    expect(handle.sessionManager).toBe(handle.session.sessionManager);
    expect(observations).toEqual(["intent:new", `mapping:${handle.session.sessionId}`, "continuation"]);
    const root = handle.sessionManager.appendMessage({ role: "user", content: "fork me", timestamp: 1 });
    await writeFile(handle.session.sessionFile!, jsonl([handle.sessionManager.getHeader(), ...handle.sessionManager.getEntries()]));
    const beforeFork = handle.session.sessionId;
    await actions.fork(root, { position: "at" });
    expect(handle.session.sessionId).not.toBe(beforeFork);
    await writeFile(f.sessionFile, jsonl([header(f.cwd)]));
    await actions.switchSession(f.sessionFile);
    expect(handle.session.sessionId).toBe("recorded-id");
    await actions.reload();
    expect(handle.session.sessionId).toBe("recorded-id");
    const importedPath = join(f.cwd, "imported.jsonl");
    await writeFile(importedPath, jsonl([{ ...header(f.cwd), id: "imported-id" }]));
    await handle.importFromJsonl!(importedPath);
    expect(handle.session.sessionId).toBe("imported-id");
    expect(handle.session.sessionFile).not.toBe(importedPath);
    expect(observations).toContain("intent:import");
    const badPath = join(f.sessionDir, "bad.jsonl");
    await writeFile(badPath, jsonl([header(f.cwd)]) + "broken");
    await expect(actions.switchSession(badPath)).rejects.toThrow(/line 2/);
    expect(handle.session.sessionId).toBe("imported-id");
  } finally { await handle.shutdown(); }
});


it("records the pinned SDK import cwd override recovery mismatch", async () => {
  const f = await fixture();
  const input = join(f.cwd, "moved.jsonl"), missing = join(f.cwd, "missing-directory");
  await writeFile(input, jsonl([{ ...header(missing), id: "moved-id" }]));
  const handle = await createPiAgentRuntime({ ...f, sessionFile: undefined });
  try {
    await handle.runtime.importFromJsonl(input, f.cwd);
    expect(handle.runtime.session.sessionManager.getCwd()).toBe(f.cwd);
    const path = handle.runtime.session.sessionFile!;
    const state = await inspectPiSessionFile(path);
    expect(state.kind === "persisted" && state.header.cwd).toBe(missing);
    await expect(openPiSessionFile({ path, cwd: f.cwd, sessionId: "moved-id", persistenceState: "persisted" })).rejects.toThrow(/belongs to/);
  } finally { await handle.runtime.dispose(); }
});

it("reads custom model capabilities without allocating a session", async () => {
  const f = await fixture();
  await writeFile(join(f.agentDir, "models.json"), JSON.stringify({ providers: {
    "review-provider": { baseUrl: "http://127.0.0.1:1", api: "openai-completions", models: [
      { id: "plain", name: "Plain", reasoning: false, contextWindow: 12345, maxTokens: 100 },
      { id: "reasoner", name: "Reasoner", reasoning: true, contextWindow: 54321, maxTokens: 100 }
    ] }
  } }));
  const models = await readPiModelCatalog({ agentDir: f.agentDir });
  expect(models.find(({ model }) => model.provider === "review-provider" && model.id === "plain"))
    .toMatchObject({ name: "Plain", contextWindow: 12345, thinkingLevels: ["off"] });
  expect(models.find(({ model }) => model.provider === "review-provider" && model.id === "reasoner")?.thinkingLevels).toContain("high");
  expect(await readdir(f.sessionDir)).toEqual([]);
});

it("does not run replacement continuations after a failed mapping ACK", async () => {
  const f = await fixture();
  const handle = await createPiWorkerSession({ ...f, sessionFile: undefined,
    onSessionReplaced: async () => { throw new Error("mapping rejected"); }
  });
  try {
    const bind = vi.spyOn(handle.session, "bindExtensions");
    await handle.bindExtensions({});
    const continuation = vi.fn();
    await expect(bind.mock.calls[0]![0]!.commandContextActions!.newSession({ withSession: continuation })).rejects.toThrow("mapping rejected");
    expect(continuation).not.toHaveBeenCalled();
  } finally { await handle.shutdown(); }
});


it("runs replacement hooks and continuations in destination ALS and migrates subscribers", async () => {
  const f = await fixture();
  const context = new AsyncLocalStorage<string>();
  const starts: Array<{ id: string; context: string | undefined }> = [];
  const observed: string[] = [];
  const handle = await createPiWorkerSession({ ...f, sessionFile: undefined,
    resourceLoaderOptions: { ...f.resourceLoaderOptions, extensionFactories: [(pi) => {
      pi.on("session_start", async (_event, ctx) => {
        await Promise.resolve();
        starts.push({ id: ctx.sessionManager.getSessionId(), context: context.getStore() });
      });
    }] },
    runInSessionContext: (session, callback) => context.run(session.sessionId, callback)
  });
  try {
    const bind = vi.spyOn(handle.session, "bindExtensions");
    const unsubscribe = handle.onEvent((event) => { if (event.type === "session_info_changed") observed.push(context.getStore() ?? "none"); });
    await handle.bindExtensions({});
    const actions = bind.mock.calls[0]![0]!.commandContextActions!;
    const continuation = async () => {
      await Promise.resolve();
      expect(context.getStore()).toBe(handle.session.sessionId);
      handle.session.setSessionName("destination");
    };
    await context.run("source-operation", async () => {
      await actions.newSession({ parentSession: "source.jsonl", withSession: continuation });
      expect(handle.sessionManager.getHeader()?.parentSession).toBe("source.jsonl");
      expect(context.getStore()).toBe("source-operation");
      await writeFile(f.sessionFile, jsonl([header(f.cwd), { ...entry("root"), type: "message", message: { role: "user", content: "fork", timestamp: 1 } }]));
      await actions.switchSession(f.sessionFile, { withSession: continuation });
      await actions.fork("root", { position: "at", withSession: continuation });
    });
    expect(starts).toHaveLength(4);
    expect(starts.slice(1).every(({ id, context }) => id === context)).toBe(true);
    expect(observed).toHaveLength(3);
    expect(observed).toEqual(starts.slice(1).map(({ id }) => id));
    unsubscribe();
    handle.session.setSessionName("after unsubscribe");
    expect(observed).toHaveLength(3);
  } finally { await handle.shutdown(); }
});

it("serializes concurrent production worker replacements before their intent ACKs", async () => {
  const { PiWorker } = await import("../../packages/agent-pi/src/worker.js");
  const f = await fixture();
  await mkdir(join(f.agentDir, "extensions"));
  await writeFile(join(f.agentDir, "extensions", "replace.ts"), `export default function(pi) {
    let nestedContext;
    pi.on("session_before_switch", async () => {
      const ctx = nestedContext;
      nestedContext = undefined;
      if (ctx) await ctx.newSession();
    });
    pi.registerCommand("replace", { handler: async (args, ctx) => {
      if (args === "nested") nestedContext = ctx;
      await ctx.newSession();
    } });
  }`);
  const messages: Outbound[] = [];
  const inbound = (type: Inbound["type"], payload: unknown) => ({ ipcVersion: 1, sessionId: "source", workerEpoch: "replacement-review", type, payload }) as Inbound;
  let releaseFirst!: () => void;
  let intents = 0;
  const worker = new PiWorker({ send(message) {
    messages.push(message);
    if (message.type === "session_mapping") queueMicrotask(() => { void worker.receive(inbound("session_mapping_ack", message.payload)); });
    if (message.type === "event_batch") queueMicrotask(() => { void worker.receive(inbound("batch_ack", { batchNo: message.payload.batchNo })); });
    if (message.type === "session_replace_intent") {
      const ack = () => { void worker.receive(inbound("session_replace_ack", { requestId: message.payload.requestId, phase: "intent", appSessionId: "source" })); };
      if (++intents === 1) releaseFirst = ack;
      else queueMicrotask(ack);
    }
    if (message.type === "session_replaced") queueMicrotask(() => { void worker.receive(inbound("session_replace_ack", {
      requestId: message.payload.requestId, phase: "bound", appSessionId: `destination-${intents}`
    })); });
  } }, { sessionId: "source", workerEpoch: "replacement-review", heartbeatMs: 60000 });
  try {
    await worker.receive(inbound("initialize", { cwd: f.cwd, agentDir: f.agentDir, sessionDir: f.sessionDir, persistenceState: "uninitialized", operationId: "init" }));
    await vi.waitFor(() => expect(messages.some((message) => message.type === "ready")).toBe(true));
    for (let i = 1; i <= 2; i++) await worker.receive(inbound("execute", { commandId: `command-${i}`, operationId: `operation-${i}`, kind: "extension_command", text: "/replace" }));
    await vi.waitFor(() => expect(messages.filter((message) => message.type === "command_accepted")).toHaveLength(2));
    await vi.waitFor(() => expect(intents).toBe(1));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(intents).toBe(1);
    releaseFirst();
    await vi.waitFor(() => expect(messages.filter((message) => message.type === "command_result")).toHaveLength(2));
    const intentIds = messages.filter((message) => message.type === "session_replace_intent").map((message) => message.payload.requestId);
    const boundIds = messages.filter((message) => message.type === "session_replaced").map((message) => message.payload.requestId);
    expect(intentIds).toHaveLength(2);
    expect(boundIds).toEqual(intentIds);
    expect(messages.filter((message) => message.type === "extension_error" || message.type === "fatal")).toEqual([]);
    expect(messages.filter((message) => message.type === "command_result").map((message) => message.payload.status)).toEqual(["completed", "completed"]);
    await worker.receive(inbound("execute", { commandId: "nested-command", operationId: "nested-operation", kind: "extension_command", text: "/replace nested" }));
    await vi.waitFor(() => expect(messages.filter((message) => message.type === "command_result")).toHaveLength(3));
    const nestedIntents = messages.filter((message) => message.type === "session_replace_intent").map((message) => message.payload.requestId);
    const nestedBound = messages.filter((message) => message.type === "session_replaced").map((message) => message.payload.requestId);
    expect(nestedIntents).toHaveLength(4);
    expect(nestedBound).toEqual([nestedIntents[0], nestedIntents[1], nestedIntents[3], nestedIntents[2]]);
    expect(messages.filter((message) => message.type === "extension_error" || message.type === "fatal")).toEqual([]);
  } finally { await worker.receive(inbound("shutdown", { reason: "test" })); worker.dispose(); }
});

it("allows awaited nested hook replacements and serializes sibling continuations", async () => {
  const f = await fixture();
  type Actions = NonNullable<Parameters<Awaited<ReturnType<typeof createPiWorkerSession>>["bindExtensions"]>[0]["commandContextActions"]>;
  let actions: Actions;
  let nestOnStart = false;
  let awaitingMapping = false;
  const mapped: string[] = [];
  const handle = await createPiWorkerSession({ ...f, sessionFile: undefined,
    resourceLoaderOptions: { ...f.resourceLoaderOptions, extensionFactories: [(pi) => {
      pi.on("session_start", async () => {
        if (nestOnStart) {
          nestOnStart = false;
          await actions.newSession();
        }
      });
    }] },
    onBeforeSessionReplace: async () => {
      expect(awaitingMapping).toBe(false);
      awaitingMapping = true;
      await Promise.resolve();
    },
    onSessionReplaced: async (session) => { mapped.push(session.sessionId); awaitingMapping = false; }
  });
  try {
    const bind = vi.spyOn(handle.session, "bindExtensions");
    await handle.bindExtensions({});
    actions = bind.mock.calls[0]![0]!.commandContextActions!;
    nestOnStart = true;
    await actions.newSession({ withSession: async () => {
      await Promise.all([actions.newSession(), actions.newSession()]);
    } });
    expect(mapped).toHaveLength(4);
    expect(new Set(mapped).size).toBe(4);
    expect(handle.session.sessionId).toBe(mapped.at(-1));
    await expect(actions.switchSession(join(f.sessionDir, "missing.jsonl"))).rejects.toThrow();
    await actions.newSession();
    expect(mapped).toHaveLength(5);
  } finally { await handle.shutdown(); }
});
