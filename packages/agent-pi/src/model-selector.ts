import type { AgentSession, ExtensionUIContext, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { setKeybindings, type Component, type TUI } from "@earendil-works/pi-tui";
import { nativeTextTheme } from "./widget-host.js";

type Model = NonNullable<AgentSession["model"]>;
export type ModelSelection = { model: Model; persist: boolean };
type Selector = Component & { dispose(): void; focused: boolean };

// Version-specific terminal component access stays behind the SDK adapter.
const native = await import(new URL("./modes/interactive/components/model-selector.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href) as {
  ModelSelectorComponent: new (tui: TUI, current: Model | undefined, runtime: AgentSession["modelRuntime"],
    scoped: AgentSession["scopedModels"], select: (model: Model) => void, cancel: () => void,
    search: string | undefined, save: (model: Model) => void, defaults?: { provider: string; id: string }) => Selector;
};
const themes = await import(new URL("./modes/interactive/theme/theme.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href) as {
  setThemeInstance(theme: ExtensionUIContext["theme"]): void;
};

export function createModelSelector(tui: TUI, keys: KeybindingsManager, session: AgentSession,
  defaults: { provider: string; id: string } | undefined, done: (result?: ModelSelection) => void, search?: string): Selector {
  initializeNativeMenu(keys);
  return new native.ModelSelectorComponent(tui, session.model, session.modelRuntime, session.scopedModels,
    model => done({ model, persist: false }), () => done(), search,
    model => done({ model, persist: true }), defaults);
}

export function initializeNativeMenu(keys: KeybindingsManager): void {
  // Native menus use the application-wide theme and TUI keybinding manager.
  // Each worker owns one agent configuration and uses the same fixed text theme.
  themes.setThemeInstance(nativeTextTheme());
  setKeybindings(keys);
}
