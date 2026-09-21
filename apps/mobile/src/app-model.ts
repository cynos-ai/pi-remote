import type { ProjectSummary, SessionSummary, TimelineItem } from "@pi-remote/protocol";

export type SessionFilter = "exclude" | "only" | "all";
export type MobileSendMode = "prompt" | "steer" | "follow_up";

export interface SlashCommandSuggestion {
  command: string;
  description: string;
}

export const BUILT_IN_SLASH_COMMANDS: readonly SlashCommandSuggestion[] = [
  { command: "/model", description: "选择或搜索模型" },
  { command: "/thinking", description: "选择思考等级" },
  { command: "/compact", description: "压缩当前上下文" },
  { command: "/new", description: "新建 Session" },
  { command: "/resume", description: "切换历史 Session" },
  { command: "/tree", description: "浏览和切换对话分支" },
  { command: "/session", description: "查看会话统计" },
  { command: "/login", description: "登录模型 provider" },
  { command: "/logout", description: "移除 provider 凭据" },
  { command: "/trust", description: "管理项目资源信任" },
  { command: "/name", description: "查看或修改标题" },
  { command: "/copy", description: "查看最后一条助手文本" },
  { command: "/fork", description: "从用户消息分叉" },
  { command: "/clone", description: "复制当前分支" },
  { command: "/import", description: "导入原生会话" },
  { command: "/export", description: "导出当前分支" },
  { command: "/share", description: "预览并分享会话" },
  { command: "/reload", description: "重新加载资源" },
  { command: "/settings", description: "打开常用设置" },
  { command: "/scoped-models", description: "配置模型范围" },
  { command: "/hotkeys", description: "查看远程快捷键" },
  { command: "/changelog", description: "查看 SDK 更新记录" },
  { command: "/quit", description: "退出远程编辑器" }
] as const;

export function reconcileSendMode(activeRunId: string | null, current: MobileSendMode): MobileSendMode {
  if (activeRunId !== null) return current === "prompt" ? "steer" : current;
  return "prompt";
}

export function slashCommandSuggestions(input: string, limit = 8): readonly SlashCommandSuggestion[] {
  const query = input.trim().toLowerCase().replace(/^\//, "");
  const matches = query.length === 0
    ? BUILT_IN_SLASH_COMMANDS
    : BUILT_IN_SLASH_COMMANDS.filter((item) =>
      item.command.slice(1).includes(query) || item.description.toLowerCase().includes(query));
  return matches.slice(0, Math.max(0, limit));
}

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
