import type { ProjectSummary, SessionSummary, TimelineItem } from "@pi-remote/protocol";

export type SessionFilter = "exclude" | "only" | "all";

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface HistoryPage {
  items: TimelineItem[];
  nextCursor: string | null;
  atSeq: number;
}

export function appendPage<T extends { id?: string; itemId?: string }>(current: T[], page: Page<T>): T[] {
  const seen = new Set(current.map((item) => item.id ?? item.itemId));
  return [...current, ...page.items.filter((item) => {
    const key = item.id ?? item.itemId;
    if (key === undefined || seen.has(key)) return false;
    seen.add(key);
    return true;
  })];
}

export function mergeHistoryPage(current: TimelineItem[], page: HistoryPage): TimelineItem[] {
  const seen = new Set(current.map((item) => item.itemId));
  return [...current, ...page.items.filter((item) => {
    if (seen.has(item.itemId)) return false;
    seen.add(item.itemId);
    return true;
  })];
}

export function projectActivityLabel(project: ProjectSummary): string {
  if (project.runningCount > 0) return `${project.runningCount} 个运行中`;
  if (project.waitingInputCount > 0) return `${project.waitingInputCount} 个待答复`;
  return project.lastActivityAt === null ? "暂无活动" : formatRelativeTime(project.lastActivityAt);
}

export function sessionStatusLabel(session: SessionSummary): string {
  switch (session.status) {
    case "running": return "运行中";
    case "queued": return `排队中${session.queuedCount > 0 ? ` · ${session.queuedCount}` : ""}`;
    case "waiting_input": return "等待输入";
    case "busy": return "处理中";
    case "interrupted": return "已中断";
    case "failed": return "失败";
    case "idle": return "空闲";
  }
}

export function formatRelativeTime(value: string, now = Date.now()): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "时间未知";
  const delta = Math.max(0, now - timestamp);
  if (delta < 60_000) return "刚刚";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  return `${Math.floor(delta / 86_400_000)} 天前`;
}

export function offlineCacheLabel(updatedAt: number): string {
  return `离线缓存 · ${formatRelativeTime(new Date(updatedAt).toISOString())}`;
}
