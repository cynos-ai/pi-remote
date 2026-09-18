import { describe, expect, it, vi } from "vitest";
import {
  IPC_VERSION,
  PiWorker,
  type WorkerInboundMessage,
  type WorkerOutboundMessage,
  type WorkerSessionFactory
} from "../../packages/agent-pi/src/worker.js";
import type { ProtocolEvent } from "../../packages/protocol/src/events.js";

const SESSION_ID = "s07-interaction-session";
const WORKER_EPOCH = "s07-interaction-epoch";

type FormKind = "select" | "confirm" | "input" | "editor";
type Origin = "initialize" | "configure" | "run" | "bash" | "extension";

interface TestUi {
  select(title: string, options: string[], dialogOptions?: { timeout?: number }): Promise<string | undefined>;
  confirm(title: string, message: string, dialogOptions?: { timeout?: number }): Promise<boolean>;
  input(title: string, placeholder?: string, dialogOptions?: { timeout?: number }): Promise<string | undefined>;
  editor(title: string, prefill?: string): Promise<string | undefined>;
}

interface RuntimeFixture {
  worker: PiWorker;
  sent: WorkerOutboundMessage[];
  ui: () => TestUi;
  session: {
    thinkingLevel: string;
  };
}

interface FixtureOptions {
  origin: Origin;
  formKind: FormKind;
  timeoutMs?: number;
}

function inbound<TType extends WorkerInboundMessage["type"]>(
  type: TType,
  payload: Extract<WorkerInboundMessage, { type: TType }>["payload"]
): Extract<WorkerInboundMessage, { type: TType }> {
  return {
    ipcVersion: IPC_VERSION,
    sessionId: SESSION_ID,
    workerEpoch: WORKER_EPOCH,
    type,
    payload
  } as Extract<WorkerInboundMessage, { type: TType }>;
}

function protocolEvents(sent: WorkerOutboundMessage[]): ProtocolEvent[] {
  return sent
    .filter((message): message is Extract<WorkerOutboundMessage, { type: "event_batch" }> => message.type === "event_batch")
    .flatMap((message) => message.payload.events);
}

function eventOf<TType extends ProtocolEvent["type"]>(
  sent: WorkerOutboundMessage[],
  type: TType,
  predicate: (event: Extract<ProtocolEvent, { type: TType }>) => boolean = () => true
): Extract<ProtocolEvent, { type: TType }> | undefined {
  for (const candidate of protocolEvents(sent)) {
    if (candidate.type !== type) continue;
    const event = candidate as Extract<ProtocolEvent, { type: TType }>;
    if (predicate(event)) return event;
  }
  return undefined;
}

function responseFor(kind: FormKind): Record<string, unknown> {
  if (kind === "select") return { value: "option-a" };
  if (kind === "confirm") return { confirmed: true };
  return { value: kind === "input" ? "typed input" : "edited content" };
}

async function callForm(ui: TestUi, kind: FormKind, timeoutMs?: number): Promise<unknown> {
  const dialogOptions = timeoutMs === undefined ? undefined : { timeout: timeoutMs };
  if (kind === "select") return ui.select("Choose", ["option-a", "option-b"], dialogOptions);
  if (kind === "confirm") return ui.confirm("Confirm", "Continue?", dialogOptions);
  if (kind === "input") return ui.input("Input", "placeholder", dialogOptions);
  return ui.editor("Editor", "prefilled");
}

function makeFixture(options: FixtureOptions): RuntimeFixture {
  const sent: WorkerOutboundMessage[] = [];
  let currentUi: TestUi | undefined;
  let triggerForm: (() => Promise<unknown>) | undefined;
  const session = {
    sessionId: "pi-s07-interaction-session",
    sessionFile: "/tmp/pi-s07-interaction-session.jsonl",
    model: { provider: "test", id: "model" },
    thinkingLevel: "low",
    prompt: vi.fn(async () => {
      if (options.origin === "run" || options.origin === "extension") {
        await triggerForm?.();
      }
    }),
    compact: vi.fn(async () => undefined),
    executeBash: vi.fn(async () => ({ exitCode: 0, output: "bash output" })),
    recordBashResult: vi.fn(),
    abort: vi.fn(async () => undefined),
    abortBash: vi.fn(),
    clearQueue: vi.fn(() => ({ steering: [], followUp: [] })),
    setModel: vi.fn(async () => undefined),
    setThinkingLevel: vi.fn((level: string) => {
      session.thinkingLevel = level;
      if (options.origin === "configure") void triggerForm?.();
    }),
    setSessionName: vi.fn()
  };
  const settingsManager = { flush: vi.fn(async () => undefined) };
  const model = session.model;
  const handle = {
    session: {
      ...session,
      extensionRunner: {
        emitUserBash: vi.fn(async () => {
          if (options.origin !== "bash") return undefined;
          await triggerForm?.();
          return { result: { output: "hooked bash" } };
        })
      }
    },
    sessionManager: {
      getSessionFile: () => session.sessionFile,
      isPersisted: () => false
    },
    services: {
      cwd: "/tmp",
      modelRuntime: { getModel: () => model },
      settingsManager
    },
    dispose: vi.fn(),
    bindExtensions: vi.fn(async (bindings: unknown) => {
      currentUi = (bindings as { uiContext: TestUi }).uiContext;
      triggerForm = () => callForm(currentUi!, options.formKind, options.timeoutMs);
      if (options.origin === "initialize") await triggerForm();
    }),
    onEvent: () => () => undefined
  } as unknown as Awaited<ReturnType<WorkerSessionFactory>>;
  const worker = new PiWorker({ send: (message) => {
    sent.push(message);
    if (message.type === "event_batch") {
      queueMicrotask(() => { void worker.receive(inbound("batch_ack", { batchNo: message.payload.batchNo })); });
    }
  } }, {
    sessionId: SESSION_ID,
    workerEpoch: WORKER_EPOCH,
    heartbeatMs: 60_000,
    factory: async () => handle
  });
  return {
    worker,
    sent,
    ui: () => {
      if (!currentUi) throw new Error("worker has not bound its UI context");
      return currentUi;
    },
    session
  };
}

async function waitForEvent<TType extends ProtocolEvent["type"]>(
  fixture: RuntimeFixture,
  type: TType,
  predicate: (event: Extract<ProtocolEvent, { type: TType }>) => boolean = () => true
): Promise<Extract<ProtocolEvent, { type: TType }>> {
  await vi.waitFor(() => expect(eventOf(fixture.sent, type, predicate)).toBeDefined());
  const event = eventOf(fixture.sent, type, predicate);
  if (!event) throw new Error(`event ${type} was not emitted`);
  return event;
}

async function waitForOutbound<TType extends WorkerOutboundMessage["type"]>(
  fixture: RuntimeFixture,
  type: TType,
  predicate: (message: Extract<WorkerOutboundMessage, { type: TType }>) => boolean = () => true
): Promise<Extract<WorkerOutboundMessage, { type: TType }>> {
  await vi.waitFor(() => expect(fixture.sent.some((message) => {
    if (message.type !== type) return false;
    return predicate(message as Extract<WorkerOutboundMessage, { type: TType }>);
  })).toBe(true));
  const message = fixture.sent.find((candidate) => {
    if (candidate.type !== type) return false;
    return predicate(candidate as Extract<WorkerOutboundMessage, { type: TType }>);
  });
  if (!message) throw new Error(`message ${type} was not emitted`);
  return message as Extract<WorkerOutboundMessage, { type: TType }>;
}

async function initialize(fixture: RuntimeFixture, waitForForm: boolean): Promise<void> {
  await fixture.worker.receive(inbound("initialize", {
    cwd: "/tmp",
    agentDir: "/tmp/agent",
    sessionDir: "/tmp/sessions",
    operationId: "initialize-operation"
  }));
  await waitForOutbound(fixture, "session_mapping");
  expect(eventOf(fixture.sent, "interaction.requested")).toBeUndefined();
  await fixture.worker.receive(inbound("session_mapping_ack", {
    piSessionId: "pi-s07-interaction-session",
    piSessionFile: "/tmp/pi-s07-interaction-session.jsonl"
  }));
  if (waitForForm) {
    await waitForEvent(fixture, "interaction.requested", (event) => event.operationId === "initialize-operation");
    return;
  }
  await waitForOutbound(fixture, "ready");
}

async function answer(fixture: RuntimeFixture, interaction: ProtocolEvent, response: Record<string, unknown>, commandId = "response-command"): Promise<void> {
  if (interaction.type !== "interaction.requested") throw new Error("expected an interaction request");
  await fixture.worker.receive(inbound("respond", {
    commandId,
    operationId: interaction.payload.operationId,
    interactionId: interaction.payload.interactionId,
    response
  }));
}

const formCases: Array<[Origin, FormKind]> = [
  ["initialize", "select"],
  ["initialize", "confirm"],
  ["initialize", "input"],
  ["initialize", "editor"],
  ["configure", "select"],
  ["configure", "confirm"],
  ["configure", "input"],
  ["configure", "editor"],
  ["run", "select"],
  ["run", "confirm"],
  ["run", "input"],
  ["run", "editor"],
  ["bash", "select"],
  ["bash", "confirm"],
  ["bash", "input"],
  ["bash", "editor"],
  ["extension", "select"],
  ["extension", "confirm"],
  ["extension", "input"],
  ["extension", "editor"]
];

describe("S07 interaction bridge", () => {
  it.each(formCases)("bridges %s/%s with stable operation and worker ownership", async (origin, formKind) => {
    const fixture = makeFixture({ origin, formKind });
    try {
      await initialize(fixture, origin === "initialize");
      let operationId = "initialize-operation";
      let runId: string | null = null;
      let commandId: string | undefined;

      if (origin === "initialize") {
        const interaction = await waitForEvent(fixture, "interaction.requested", (event) => event.payload.origin === origin && event.payload.kind === formKind);
        expect(interaction.runId).toBeNull();
        expect(interaction.operationId).toBe(operationId);
        await answer(fixture, interaction, responseFor(formKind));
        await waitForEvent(fixture, "interaction.resolved", (event) => event.payload.interactionId === interaction.payload.interactionId);
        await waitForOutbound(fixture, "ready");
      } else {
        if (origin === "configure") {
          operationId = "configure-operation";
          commandId = "configure-command";
          await fixture.worker.receive(inbound("set_thinking", {
            commandId,
            operationId,
            level: "high",
            persist: false
          }));
        } else if (origin === "run") {
          operationId = "run-operation";
          commandId = "run-command";
          runId = "run-id";
          await fixture.worker.receive(inbound("execute", {
            commandId,
            operationId,
            runId,
            kind: "prompt",
            text: "please continue"
          }));
        } else if (origin === "bash") {
          operationId = "bash-operation";
          commandId = "bash-command";
          await fixture.worker.receive(inbound("execute", {
            commandId,
            operationId,
            kind: "bash",
            command: "printf bash"
          }));
        } else {
          operationId = "extension-operation";
          commandId = "extension-command";
          await fixture.worker.receive(inbound("execute", {
            commandId,
            operationId,
            kind: "extension_command",
            text: "/extension-command"
          }));
        }

        const interaction = await waitForEvent(fixture, "interaction.requested", (event) => event.payload.origin === origin && event.payload.kind === formKind);
        expect(interaction.operationId).toBe(operationId);
        expect(interaction.runId).toBe(runId);
        expect(interaction.payload.origin).toBe(origin);
        expect(interaction.payload.operationId).toBe(operationId);
        expect(interaction.payload.kind).toBe(formKind);
        await answer(fixture, interaction, responseFor(formKind));
        await waitForEvent(fixture, "interaction.resolved", (event) => event.payload.interactionId === interaction.payload.interactionId);
        if (commandId) await waitForOutbound(fixture, "command_result", (message) => message.payload.commandId === commandId);
      }

      const ownedEvents = protocolEvents(fixture.sent).filter((event) => event.operationId === operationId);
      expect(ownedEvents.length).toBeGreaterThan(0);
      for (const event of ownedEvents) expect(event.runId).toBe(runId);
      for (const message of fixture.sent) expect(message.workerEpoch).toBe(WORKER_EPOCH);
    } finally {
      fixture.worker.dispose();
    }
  }, 10_000);

  it("keeps a configure Operation open after setThinkingLevel returns while its async hook waits", async () => {
    const fixture = makeFixture({ origin: "configure", formKind: "confirm" });
    try {
      await initialize(fixture, false);
      await fixture.worker.receive(inbound("set_thinking", {
        commandId: "thinking-command",
        operationId: "thinking-operation",
        level: "xhigh",
        persist: false
      }));
      const interaction = await waitForEvent(fixture, "interaction.requested", (event) => event.operationId === "thinking-operation");
      await waitForOutbound(fixture, "command_result", (message) => message.payload.commandId === "thinking-command");
      expect(eventOf(fixture.sent, "operation.updated", (event) =>
        event.operationId === "thinking-operation" && event.payload.status === "completed"
      )).toBeUndefined();
      await answer(fixture, interaction, { confirmed: true });
      await waitForEvent(fixture, "interaction.resolved", (event) => event.payload.interactionId === interaction.payload.interactionId);
      await waitForEvent(fixture, "operation.updated", (event) =>
        event.operationId === "thinking-operation" && event.payload.status === "completed"
      );
      expect(fixture.session.thinkingLevel).toBe("xhigh");
    } finally {
      fixture.worker.dispose();
    }
  });

  it("cancels a form once and rejects a duplicate answer", async () => {
    const fixture = makeFixture({ origin: "run", formKind: "select" });
    try {
      await initialize(fixture, false);
      await fixture.worker.receive(inbound("execute", {
        commandId: "cancel-run-command",
        operationId: "cancel-run-operation",
        runId: "cancel-run",
        kind: "prompt",
        text: "wait for cancellation"
      }));
      const interaction = await waitForEvent(fixture, "interaction.requested", (event) => event.payload.operationId === "cancel-run-operation");
      await answer(fixture, interaction, { cancelled: true }, "cancel-response");
      await waitForEvent(fixture, "interaction.resolved", (event) => event.payload.status === "cancelled");
      await waitForOutbound(fixture, "command_result", (message) => message.payload.commandId === "cancel-run-command");
      await answer(fixture, interaction, { value: "option-a" }, "duplicate-response");
      await waitForOutbound(fixture, "command_rejected", (message) =>
        message.payload.commandId === "duplicate-response" && message.payload.code === "INTERACTION_CLOSED"
      );
    } finally {
      fixture.worker.dispose();
    }
  });

  it("expires a timed input without inventing a response", async () => {
    const fixture = makeFixture({ origin: "run", formKind: "input", timeoutMs: 10 });
    try {
      await initialize(fixture, false);
      await fixture.worker.receive(inbound("execute", {
        commandId: "timeout-command",
        operationId: "timeout-operation",
        runId: "timeout-run",
        kind: "prompt",
        text: "wait for timeout"
      }));
      const interaction = await waitForEvent(fixture, "interaction.requested", (event) => event.payload.operationId === "timeout-operation");
      expect(interaction.type).toBe("interaction.requested");
      await waitForEvent(fixture, "interaction.resolved", (event) =>
        event.payload.interactionId === interaction.payload.interactionId && event.payload.status === "expired"
      );
      const resolved = eventOf(fixture.sent, "interaction.resolved", (event) => event.payload.interactionId === interaction.payload.interactionId);
      expect(resolved?.type === "interaction.resolved" ? resolved.payload.reason : undefined).toBe("timeout");
      const result = await waitForOutbound(fixture, "command_result", (message) => message.payload.commandId === "timeout-command");
      expect(result.payload.status).toBe("completed");
    } finally {
      fixture.worker.dispose();
    }
  });
});
