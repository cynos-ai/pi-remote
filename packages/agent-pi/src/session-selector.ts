import { SessionManager, type AgentSession, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { resolve } from "node:path";
import { initializeNativeMenu } from "./model-selector.js";
import { inspectPiSessionFile, openPiSessionFile, PiSessionHistoryError } from "./session-file.js";

type Loader = (progress?: Parameters<typeof SessionManager.list>[2]) => ReturnType<typeof SessionManager.list>;
type Selector = Component & { focused: boolean; header: { setStatusMessage(value: null): void } };
const native = await import(new URL("./modes/interactive/components/session-selector.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href) as {
  SessionSelectorComponent: new (current: Loader, all: Loader, select: (path: string) => void, cancel: () => void,
    exit: () => void, render: () => void, options: { renameSession(path: string, name: string | undefined): Promise<void>; showRenameHint: boolean; keybindings: KeybindingsManager }, currentFile?: string) => Selector;
};

export function createSessionSelector(tui: TUI, keys: KeybindingsManager, session: AgentSession,
  done: (path?: string) => void, exit: () => void): Component & { focused: boolean; dispose(): void } {
  initializeNativeMenu(keys);
  const manager = session.sessionManager;
  let closed = false;
  const selector = new native.SessionSelectorComponent(
    progress => SessionManager.list(manager.getCwd(), manager.getSessionDir(), progress),
    progress => manager.usesDefaultSessionDir() ? SessionManager.listAll(progress) : SessionManager.listAll(manager.getSessionDir(), progress),
    path => done(path), () => done(), exit, () => { if (!closed) tui.requestRender(); }, {
      keybindings: keys, showRenameHint: true,
      renameSession: async (path, value) => {
        if (closed || !value?.trim()) return;
        const state = await inspectPiSessionFile(path);
        if (state.kind !== "persisted") throw new PiSessionHistoryError({ kind: "invalid", path, reason: `rename history is ${state.kind}` });
        if (closed) return;
        if (manager.getSessionFile() && resolve(path) === resolve(manager.getSessionFile()!)) session.setSessionName(value.trim());
        else {
          const opened = await openPiSessionFile({ path, cwd: state.header.cwd, sessionId: state.header.id, persistenceState: "persisted" });
          if (!closed) opened.manager.appendSessionInfo(value.trim());
        }
      }
    }, manager.getSessionFile());
  return {
    render: width => selector.render(width), invalidate: () => selector.invalidate(),
    handleInput: data => { if (!closed) selector.handleInput?.(data); },
    get focused() { return selector.focused; }, set focused(value) { selector.focused = value; },
    dispose: () => { closed = true; selector.header.setStatusMessage(null); }
  };
}
