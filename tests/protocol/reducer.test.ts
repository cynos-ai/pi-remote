import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EventGapError,
  DuplicateEventConflictError,
  commandRequestSchema,
  createInitialState,
  parseProtocolEvent,
  reduceEvent,
  reduceEvents,
  replayEvents,
  snapshotSchema,
  toSnapshot
} from "../../packages/protocol/src/index.js";

interface Fixture {
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

async function fixture(name: string): Promise<Fixture> {
  return JSON.parse(await readFile(resolve("docs/examples", name), "utf8")) as Fixture;
}

function expandEvents(
  fixtureData: Fixture,
  events: Array<Record<string, unknown>>,
  context: { sessionId?: string; runId?: string | null; operationId?: string | null } = {}
): Array<Record<string, unknown>> {
  const defaults = fixtureData.envelopeDefaults ?? {};
  return events.map((event) => ({
    ...event,
    schemaVersion: event.schemaVersion ?? defaults.schemaVersion ?? 1,
    sessionId: event.sessionId ?? context.sessionId ?? fixtureData.sessionId,
    runId: Object.hasOwn(event, "runId") ? event.runId : context.runId ?? fixtureData.runId ?? defaults.runId ?? null,
    operationId: Object.hasOwn(event, "operationId")
      ? event.operationId
      : context.operationId ?? fixtureData.operationId ?? defaults.operationId ?? null,
    timestamp: event.timestamp ?? fixtureData.timestamp
  }));
}

describe("S03 protocol schemas", () => {
  it("rejects unknown command fields and incompatible schema versions", () => {
    expect(() => commandRequestSchema.parse({ kind: "prompt", payload: { text: "hello", extra: true } })).toThrow();
    expect(() => parseProtocolEvent({
      schemaVersion: 2,
      sessionId: "s1",
      seq: 1,
      runId: null,
      operationId: null,
      type: "runtime.notice",
      timestamp: "2026-09-12T00:00:00.000Z",
      payload: { kind: "generic", message: "new protocol" }
    })).toThrow();
  });

  it("replays the normal stream with cumulative tool snapshots", async () => {
    const data = await fixture("stream.json");
    const events = expandEvents(data, data.events ?? [], { sessionId: data.sessionId });
    const state = replayEvents(data.sessionId!, events);
    const tool = state.timelineItems.find((item) => item.itemId === "tool-1");
    expect(state.lastSeq).toBe(28);
    expect(state.runs["22222222-2222-4222-8222-222222222222"]?.status).toBe("completed");
    expect(tool?.kind).toBe("tool");
    expect(tool && tool.kind === "tool" ? tool.data.output?.text : undefined).toBe("one\ntwo\n");
    expect(state.liveItems).toEqual({});
    expect(toSnapshot(state).activeOperations).toHaveLength(0);
  });

  it("seals partial messages and tools without inventing a result", async () => {
    const data = await fixture("interrupted.json");
    const scenario = data.scenarios![0]!;
    const events = expandEvents(data, scenario.events, scenario);
    const state = replayEvents(scenario.sessionId, events);
    const partialTool = state.timelineItems.find((item) => item.itemId === "long-tool");
    expect(partialTool?.completeness).toBe("partial");
    expect(partialTool?.endReason).toBe("interrupted");
    expect(partialTool && partialTool.kind === "tool" ? partialTool.data.outcome : undefined).toBe("unknown");
    expect(partialTool && partialTool.kind === "tool" ? partialTool.data.exitCode : undefined).toBeUndefined();
    expect(state.queue.state).toBe("paused");
    expect(state.queue.items).toHaveLength(1);
    expect(state.liveItems).toEqual({});
  });

  it("keeps initialization forms without manufacturing a Run", async () => {
    const data = await fixture("initialization-dialog.json");
    const events = expandEvents(data, data.events ?? [], { sessionId: data.sessionId });
    const state = replayEvents(data.sessionId!, events);
    const snapshot = snapshotSchema.parse(toSnapshot(state));
    expect(Object.keys(state.runs)).toHaveLength(0);
    expect(snapshot.pendingInteractions).toHaveLength(0);
    expect(state.interactions["63333333-3333-4333-8333-333333333333"]?.response).toEqual({ confirmed: true });
    expect(snapshot.session.status).toBe("idle");
  });

  it("replays mixed native-runtime sessions independently", async () => {
    const data = await fixture("native-runtime.json");
    const scenario = data.scenarios![1]!;
    const expanded = expandEvents(data, scenario.events, scenario);
    const bySession = new Map<string, Array<Record<string, unknown>>>();
    for (const event of expanded) {
      const sessionId = String(event.sessionId);
      const list = bySession.get(sessionId) ?? [];
      list.push(event);
      bySession.set(sessionId, list);
    }
    const states = [...bySession.entries()].map(([sessionId, events]) => [sessionId, replayEvents(sessionId, events)] as const);
    expect(states).toHaveLength(2);
    const first = states.find(([sessionId]) => sessionId === "761c1d3c-6150-5ae0-9513-8eff18c2d92f")![1];
    const second = states.find(([sessionId]) => sessionId === "74e51a0c-3912-5737-a8b5-56d7b5e24026")![1];
    expect(Object.keys(first.runs)).toHaveLength(2);
    expect(Object.keys(second.runs)).toHaveLength(1);
    expect(first.commands["19ea1055-13ff-5f5d-8007-1e1e3201f3e3"]?.runs).toHaveLength(2);
    expect(second.timelineItems[0]?.runId).toBe("ab5c2541-b817-569e-a879-e2c99fb85c04");
  });
});

describe("S03 reducer sequencing", () => {
  const notice = (seq: number, message = "ok") => ({
    schemaVersion: 1,
    sessionId: "s1",
    seq,
    runId: null,
    operationId: null,
    type: "runtime.notice",
    timestamp: "2026-09-12T00:00:00.000Z",
    payload: { kind: "generic", message }
  });

  it("deduplicates the same event and rejects a conflicting duplicate or gap", () => {
    let state = createInitialState("s1");
    state = reduceEvent(state, notice(1));
    expect(reduceEvent(state, notice(1))).toBe(state);
    expect(() => reduceEvent(state, notice(1, "different"))).toThrow(DuplicateEventConflictError);
    expect(() => reduceEvent(state, notice(3))).toThrow(EventGapError);
  });

  it("does not duplicate cumulative tool output on replay", async () => {
    const data = await fixture("stream.json");
    const events = expandEvents(data, data.events ?? [], { sessionId: data.sessionId });
    const state = reduceEvents(createInitialState(data.sessionId!), events);
    const output = state.timelineItems.find((item) => item.itemId === "tool-1");
    expect(output && output.kind === "tool" ? output.data.output?.text : undefined).toBe("one\ntwo\n");
    expect(state.timelineItems.filter((item) => item.itemId === "tool-1")).toHaveLength(1);
  });
});

