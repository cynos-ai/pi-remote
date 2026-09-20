import type { AgentSession, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { initializeNativeMenu } from "./model-selector.js";

type Tree = ReturnType<AgentSession["sessionManager"]["getTree"]>;
type Filter = "default" | "no-tools" | "user-only" | "labeled-only" | "all";
type Selector = Component & { focused: boolean; onCopy?: (text: string | undefined) => void };
const native = await import(new URL("./modes/interactive/components/tree-selector.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href) as {
  TreeSelectorComponent: new (tree: Tree, leaf: string | null, height: number, select: (id: string) => void,
    cancel: () => void, label: (id: string, value: string | undefined) => void, selected?: string, filter?: Filter) => Selector;
};

export function createTreeSelector(tui: TUI, keys: KeybindingsManager, session: AgentSession,
  done: (id?: string) => void, copy: (text: string | undefined) => void, selected?: string, filter?: Filter): Selector {
  initializeNativeMenu(keys);
  const selector = new native.TreeSelectorComponent(session.sessionManager.getTree(), session.sessionManager.getLeafId(),
    tui.terminal.rows, done, () => done(), (id, value) => {
      session.sessionManager.appendLabelChange(id, value);
      tui.requestRender();
    }, selected, filter);
  selector.onCopy = copy;
  return selector;
}
