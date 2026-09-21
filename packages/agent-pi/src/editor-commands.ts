import type { AgentSession, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { Text, matchesKey, type Component } from "@earendil-works/pi-tui";

// This inventory describes the hosted editor, not the SDK's underlying abilities.
export const EDITOR_COMMANDS = {
  settings: "设置菜单（显示/启动项仍有待适配项）", model: "模型选择", tree: "会话树", thinking: "思考等级",
  "scoped-models": "模型范围", export: "导出到服务端路径（HTML/JSONL）", copy: "显示最后回复供手机复制",
  name: "查看/修改会话标题", session: "会话统计", changelog: "SDK 更新记录", hotkeys: "键位与入口能力清单",
  fork: "选择用户消息分叉", clone: "克隆当前分支到叶节点（包含该节点）", new: "新会话", compact: "原生手动压缩", resume: "恢复会话",
  quit: "退出远程编辑器，后端会话继续运行", import: "确认后导入 JSONL（工作目录须存在）", reload: "清理旧扩展 UI 并重载资源",
  trust: "当前目录/父目录的原生信任决定；保存后重启 worker 生效",
  logout: "选择 provider 并移除已保存凭据；环境变量和模型配置不变",
  login: "API key 登录（秘密输入）；OAuth 浏览器授权与设备码待适配"
} as const;
export const PENDING_EDITOR_COMMANDS: Record<string, string> = {
  share: "待接入 GitHub 登录状态、分享预览及发布确认；可先用 /export 导出到服务端",
};
const cache = await import(new URL("./core/cache-stats.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href) as {
  computeCacheWaste(entries: ReturnType<AgentSession["sessionManager"]["getEntries"]>, runtime: AgentSession["modelRuntime"]): unknown;
};
const usage = await import(new URL("./core/usage-totals.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href) as {
  getUsageCostBreakdown(entries: ReturnType<AgentSession["sessionManager"]["getEntries"]>): unknown;
};
const changelog = await import(new URL("./utils/changelog.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href) as {
  getChangelogPath(): string;
  parseChangelog(path: string): Array<{ content: string }>;
  normalizeChangelogLinks(content: string, entry: { content: string }): string;
};

export function sessionInformation(session: AgentSession): string {
  const entries = session.sessionManager.getEntries();
  const stats = session.getSessionStats();
  return JSON.stringify({ name: session.sessionManager.getSessionName() ?? null, ...stats,
    sessionFile: stats.sessionFile ?? null, promptTokens: stats.tokens.input + stats.tokens.cacheRead + stats.tokens.cacheWrite,
    usageByModel: usage.getUsageCostBreakdown(entries), cacheWaste: cache.computeCacheWaste(entries, session.modelRuntime) }, null, 2);
}

export function changelogInformation(): string {
  const entries = changelog.parseChangelog(changelog.getChangelogPath());
  return entries.length ? entries.reverse().map(entry => changelog.normalizeChangelogLinks(entry.content, entry)).join("\n\n") : "No changelog entries found.";
}

export function hotkeyInformation(keys: KeybindingsManager): string {
  return ["当前编辑器键位（终端原生动作不代表远程入口均已适配）", JSON.stringify(keys.getEffectiveConfig(), null, 2),
    "已接入命令", ...Object.entries(EDITOR_COMMANDS).map(([name, help]) => `/${name}: ${help}`),
    "待接入命令", ...Object.entries(PENDING_EDITOR_COMMANDS).map(([name, help]) => `/${name}: ${help}`),
    "远程动作：Ctrl+D（空草稿）、双 Ctrl+C、/quit 关闭编辑器；不会退出后端进程。",
    "app.suspend、app.editor.external、app.clipboard.pasteImage、app.thinking.toggle、app.message.followUp、app.message.dequeue 待适配；手机附件与 follow-up 入口可独立使用。"
  ].join("\n");
}

/** Match the pinned TUI's quoted/single-token path parser; no shell evaluation. */
export function editorPathArgument(text: string, command: string): string | undefined {
  if (!text.startsWith(`${command} `)) return;
  const argument = text.slice(command.length + 1).trimStart();
  if (!argument) return;
  if (argument[0] === "\"" || argument[0] === "'") {
    const end = argument.indexOf(argument[0], 1);
    return end < 0 ? undefined : argument.slice(1, end);
  }
  return argument.split(/\s/, 1)[0];
}

/** Page full text locally so display limits do not silently discard the remainder. */
export function createInformationViewer(text: string, done: () => void): Component {
  const content = new Text(text, 0, 0);
  let offset = 0, total = 0;
  return {
    render(width) {
      const lines = content.render(width); total = lines.length;
      offset = Math.max(0, Math.min(offset, Math.max(0, total - 18)));
      return [...lines.slice(offset, offset + 18), `${offset + 1}–${Math.min(offset + 18, total)}/${total} · ↑/↓ · Page Up/Down · Home/End · Enter/Esc 关闭`];
    },
    invalidate: () => content.invalidate(),
    handleInput(data) {
      if (matchesKey(data, "escape") || matchesKey(data, "enter")) done();
      else if (matchesKey(data, "up")) offset--;
      else if (matchesKey(data, "down")) offset++;
      else if (matchesKey(data, "pageUp")) offset -= 18;
      else if (matchesKey(data, "pageDown")) offset += 18;
      else if (matchesKey(data, "home")) offset = 0;
      else if (matchesKey(data, "end")) offset = total;
    }
  };
}
