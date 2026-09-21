import { describe, expect, it } from "vitest";
import {
  appendPage,
  formatRelativeTime,
  mergeHistoryPage,
  offlineCacheLabel,
  projectActivityLabel,
  reconcileSendMode,
  slashCommandSuggestions,
  sessionStatusLabel
} from "../../apps/mobile/src/app-model";

type ProjectSummary = Parameters<typeof projectActivityLabel>[0];
type SessionSummary = Parameters<typeof sessionStatusLabel>[0];
type TimelineItem = Parameters<typeof mergeHistoryPage>[0][number];

const project = (changes: Partial<ProjectSummary> = {}): ProjectSummary => ({
  id: "project-a",
  name: "Project A",
  version: 1,
  lastActivityAt: null,
  runningCount: 0,
  waitingInputCount: 0,
  blockedReason: null,
  ...changes
});

const session = (changes: Partial<SessionSummary> = {}): SessionSummary => ({
  id: "session-a",
  projectId: "project-a",
  title: "Session A",
  version: 1,
  status: "idle",
  phase: null,
  activeRunId: null,
  queuedCount: 0,
  queueState: "ready",
  queueVersion: 1,
  queuePause: null,
  piPersistenceState: "persisted",
  model: null,
  thinkingLevel: null,
  historyErrorCode: null,
  lastActivityAt: null,
  lastMessagePreview: null,
  archivedAt: null,
  ...changes
});

const timeline = (itemId: string): TimelineItem => ({
  itemId,
  kind: "message",
  operationId: "operation-a",
  runId: null,
  ordinalSeq: Number(itemId.slice(-1)),
  finalizedSeq: Number(itemId.slice(-1)),
  completeness: "complete",
  data: { messageId: itemId, role: "user", blocks: [] }
});

describe("S09 list, history, and offline view model", () => {
  it("deduplicates overlapping resource pages by stable IDs", () => {
    expect(appendPage([{ id: "a" }, { id: "b" }], { items: [{ id: "b" }, { id: "c" }], nextCursor: "next" }))
      .toEqual([{ id: "a" }, { id: "b" }, { id: "c" }]);
    expect(mergeHistoryPage([timeline("item-1")], {
      items: [timeline("item-1"), timeline("item-2")],
      nextCursor: null,
      atSeq: 2
    }).map((item) => item.itemId)).toEqual(["item-1", "item-2"]);
  });

  it("reports real server state and does not turn activity into fake offline execution", () => {
    expect(projectActivityLabel(project({ runningCount: 2 }))).toBe("2 个运行中");
    expect(projectActivityLabel(project({ waitingInputCount: 1 }))).toBe("1 个待答复");
    expect(sessionStatusLabel(session({ status: "interrupted" }))).toBe("已中断");
    expect(sessionStatusLabel(session({ status: "queued", queuedCount: 3 }))).toBe("排队中 · 3");
    expect(sessionStatusLabel(session({ status: "failed" }))).toBe("失败");
  });

  it("formats cached timestamps explicitly", () => {
    const now = Date.parse("2026-09-13T00:00:00.000Z");
    expect(formatRelativeTime("2026-09-12T23:59:30.000Z", now)).toBe("刚刚");
    expect(formatRelativeTime("2026-09-12T23:00:00.000Z", now)).toBe("1 小时前");
    expect(formatRelativeTime("bad timestamp", now)).toBe("时间未知");
    expect(offlineCacheLabel(now - 60_000)).toContain("离线缓存");
  });

  it("routes active input to steer/follow-up and resets idle input to prompt", () => {
    expect(reconcileSendMode("run-a", "prompt")).toBe("steer");
    expect(reconcileSendMode("run-a", "follow_up")).toBe("follow_up");
    expect(reconcileSendMode(null, "steer")).toBe("prompt");
    expect(reconcileSendMode(null, "follow_up")).toBe("prompt");
  });

  it("discovers common slash commands by name or description", () => {
    expect(slashCommandSuggestions("", 3).map((item) => item.command)).toEqual(["/model", "/thinking", "/compact"]);
    expect(slashCommandSuggestions("/think").map((item) => item.command)).toEqual(["/thinking"]);
    expect(slashCommandSuggestions("provider").map((item) => item.command)).toEqual(["/login", "/logout"]);
    expect(slashCommandSuggestions("missing-command")).toEqual([]);
  });
});
