import {
  createInitialState,
  reduceEvent,
  toSnapshot,
  type LiveItem,
  type ReducerState,
  type Snapshot,
  type TimelineItem,
  type ProtocolEvent
} from "@pi-remote/protocol";
import type { ModelInfo, ModelRef } from "@pi-remote/protocol";

export function thinkingLevelsForModel(
  model: ModelRef | null,
  models: readonly ModelInfo[],
  snapshotModel: ModelRef | null,
  snapshotLevels: readonly string[]
): readonly string[] {
  const discovered = models.find((entry) => entry.model.provider === model?.provider && entry.model.id === model?.id);
  if (discovered) return discovered.thinkingLevels;
  // A live model change must not reuse the previous model's capabilities.
  return model?.provider === snapshotModel?.provider && model?.id === snapshotModel?.id ? snapshotLevels : [];
}

export type LiveTimelineItem = LiveItem & { displayState: "live" };
export type SessionTimelineItem = TimelineItem | LiveTimelineItem;

/** Rebuild the client reducer from the server's authoritative snapshot. */
export function stateFromSnapshot(snapshot: Snapshot): ReducerState {
  const initial = createInitialState(snapshot.session.id, {
    projectId: snapshot.session.projectId,
    title: snapshot.session.title,
    version: snapshot.session.version,
    model: snapshot.session.model,
    thinkingLevel: snapshot.session.thinkingLevel,
    piPersistenceState: snapshot.session.piPersistenceState
  });
  const operations = Object.fromEntries(snapshot.activeOperations.map((operation) => [operation.operationId, structuredClone(operation)]));
  const runs = snapshot.activeRun === null ? {} : { [snapshot.activeRun.runId]: structuredClone(snapshot.activeRun) };
  const inputs = Object.fromEntries(
    [...snapshot.pendingInputs, ...snapshot.recoveredInputs].map((input) => [input.inputId, structuredClone(input)])
  );
  const interactions = Object.fromEntries(
    snapshot.pendingInteractions.map((interaction) => [interaction.interactionId, structuredClone(interaction)])
  );
  return {
    ...initial,
    lastSeq: snapshot.snapshotSeq,
    session: structuredClone(snapshot.session),
    operations,
    runs,
    inputs,
    interactions,
    queue: structuredClone(snapshot.queue),
    timelineItems: structuredClone(snapshot.items),
    liveItems: Object.fromEntries(snapshot.liveItems.map((item) => [item.itemId, structuredClone(item)])),
    notices: structuredClone(snapshot.notices ?? []),
    eventSignatures: {}
  };
}

export function snapshotFromState(
  state: ReducerState,
  options: Pick<Snapshot, "historyCursor" | "availableThinkingLevels" | "allowedCommands">
): Snapshot & { notices: ReducerState["notices"] } {
  return { ...toSnapshot(state, options), notices: structuredClone(state.notices) };
}

/**
 * Merge the snapshot's recent history, older history pages, and current live
 * items without duplicating a message or tool card. Rendering is sorted by
 * the server-assigned ordinal sequence rather than arrival order.
 */
export function timelineForDisplay(state: ReducerState, historyItems: readonly TimelineItem[] = []): SessionTimelineItem[] {
  const byId = new Map<string, SessionTimelineItem>();
  for (const item of historyItems) byId.set(item.itemId, item);
  for (const item of state.timelineItems) byId.set(item.itemId, item);
  for (const item of Object.values(state.liveItems)) byId.set(item.itemId, { ...item, displayState: "live" });
  return [...byId.values()].sort((left, right) => {
    const ordinal = left.ordinalSeq - right.ordinalSeq;
    return ordinal !== 0 ? ordinal : left.itemId.localeCompare(right.itemId);
  });
}

export function applyRealtimeEvent(state: ReducerState, event: ProtocolEvent): ReducerState {
  if (event.seq <= state.lastSeq) return state;
  return reduceEvent(state, event);
}

export function pendingInteractions(state: ReducerState) {
  return Object.values(state.interactions)
    .filter((interaction) => interaction.status === "pending")
    .sort((left, right) => left.updatedSeq - right.updatedSeq);
}

export function recoveredInputs(state: ReducerState) {
  return Object.values(state.inputs)
    .filter((input) => input.state === "returned" || input.state === "unknown")
    .sort((left, right) => left.updatedSeq - right.updatedSeq);
}

export function activeRunId(state: ReducerState): string | null {
  const active = Object.values(state.runs).find((run) => run.status === "running" || run.status === "stopping");
  return active?.runId ?? null;
}

export function eventDisplayText(item: SessionTimelineItem): string {
  if (item.kind === "tool") return item.data.output?.text ?? "等待工具输出";
  if (item.kind === "custom_entry") return item.data.renderer.lines.join("\n");
  if (item.data.custom?.renderer) return item.data.custom.renderer.lines.join("\n");
  return item.data.blocks
    .filter((block) => block.kind === "text" || block.kind === "thinking")
    .map((block) => block.text)
    .join("\n");
}

export function connectionStatusLabel(status: string): string {
  switch (status) {
    case "connected": return "实时已连接";
    case "connecting": return "正在连接";
    case "authenticating": return "正在验证连接";
    case "backing_off": return "连接断开，稍后重试";
    case "resyncing": return "正在重新同步";
    case "error": return "实时连接需要处理";
    default: return "实时未连接";
  }
}

export function queuePauseLabel(state: ReducerState): string | null {
  if (state.queue.state !== "paused" || state.queue.pause === null) return null;
  const reason = state.queue.pause.reason === "failed"
    ? "失败"
    : state.queue.pause.reason === "aborted" ? "已停止" : "连接中断";
  return `旧队列因 Run ${reason} 已暂停`;
}
