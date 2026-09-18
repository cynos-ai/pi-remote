import { describe, expect, it } from "vitest";
import { createInitialState, toSnapshot } from "../../packages/protocol/src/index";
import {
  applyRealtimeEvent,
  connectionStatusLabel,
  queuePauseLabel,
  stateFromSnapshot,
  timelineForDisplay,
  thinkingLevelsForModel
} from "../../apps/mobile/src/session-model";

function snapshotFixture() {
  const state = createInitialState("session-a", { projectId: "project-a", title: "执行会话" });
  const snapshot = toSnapshot(state, {
    historyCursor: "history-cursor",
    availableThinkingLevels: ["low", "high"],
    allowedCommands: ["prompt", "follow_up", "bash", "respond"]
  });
  snapshot.items = [{
    itemId: "message-a",
    kind: "message",
    operationId: "operation-a",
    runId: null,
    ordinalSeq: 1,
    finalizedSeq: 1,
    completeness: "complete",
    data: { messageId: "message-a", role: "assistant", blocks: [{ id: "block-a", index: 0, kind: "text", text: "已完成" }] }
  }];
  snapshot.liveItems = [{
    itemId: "tool-a",
    kind: "tool",
    operationId: "operation-a",
    runId: "run-a",
    ordinalSeq: 2,
    data: { toolCallId: "tool-a", messageId: "message-a", toolName: "bash", args: {}, output: { text: "进行中", truncated: false } }
  }];
  snapshot.snapshotSeq = 2;
  return snapshot;
}

describe("S10 session presentation model", () => {
  it("uses refreshed capabilities for the actual model and never carries levels across an undiscovered switch", () => {
    const oldModel = { provider: "custom", id: "old" };
    const actualModel = { provider: "custom", id: "new" };
    expect(thinkingLevelsForModel(actualModel, [], oldModel, ["high"])).toEqual([]);
    expect(thinkingLevelsForModel(oldModel, [], oldModel, ["high"])).toEqual(["high"]);
    const models = [{ model: actualModel, name: "New", contextWindow: 8192, thinkingLevels: ["off", "low"] }];
    expect(thinkingLevelsForModel(actualModel, models, oldModel, ["high"])).toEqual(["off", "low"]);
    expect(thinkingLevelsForModel(actualModel, [{ ...models[0]!, thinkingLevels: [] }], actualModel, ["high"])).toEqual([]);
  });
  it("restores snapshot controls and merges live tool cards without duplicates", () => {
    const state = stateFromSnapshot(snapshotFixture());
    const items = timelineForDisplay(state, state.timelineItems);
    expect(items.map((item) => item.itemId)).toEqual(["message-a", "tool-a"]);
    expect("displayState" in items[1]!).toBe(true);
    expect(state.session.title).toBe("执行会话");
  });

  it("treats duplicate events as no-ops and exposes connection / queue status honestly", () => {
    const state = stateFromSnapshot(snapshotFixture());
    const duplicate = applyRealtimeEvent(state, {
      schemaVersion: 1,
      sessionId: "session-a",
      seq: 2,
      runId: null,
      operationId: null,
      type: "runtime.notice",
      timestamp: "2026-09-13T00:00:00.000Z",
      payload: { kind: "generic", message: "duplicate" }
    });
    expect(duplicate).toBe(state);
    expect(connectionStatusLabel("backing_off")).toContain("重试");
    state.queue.state = "paused";
    state.queue.pause = { runId: "run-a", reason: "interrupted" };
    expect(queuePauseLabel(state)).toContain("暂停");
  });
});
