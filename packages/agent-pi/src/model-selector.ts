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
const resolver = await import(new URL("./core/model-resolver.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href) as {
  findExactModelReferenceMatch(reference: string, models: Model[]): Model | undefined;
};
const catalogs = await import(new URL("./modes/interactive/model-catalog-refresh.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href) as {
  refreshModelCatalogs(runtime: AgentSession["modelRuntime"], signal: AbortSignal): ReturnType<AgentSession["modelRuntime"]["refresh"]>;
};

export async function findEditorModel(session: AgentSession, reference: string, signal: AbortSignal,
  notify: (message: string, type: "info" | "warning") => void): Promise<Model | undefined> {
  if (signal.aborted) return;
  const scoped = session.scopedModels;
  const cached = resolver.findExactModelReferenceMatch(reference,
    scoped.length ? scoped.map(item => item.model) : [...session.modelRuntime.getAvailableSnapshot()]);
  if (cached || scoped.length) return cached;
  notify("正在刷新模型目录…", "info");
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 15_000);
  try {
    const result = await catalogs.refreshModelCatalogs(session.modelRuntime, controller.signal);
    if (!signal.aborted) {
      if (result.aborted && timedOut) notify("模型目录刷新超时，使用缓存结果", "warning");
      else if (result.errors.size) notify(`部分模型目录刷新失败：${[...result.errors.keys()].join(", ")}；使用缓存结果`, "warning");
    }
  } catch (error) {
    if (!signal.aborted) notify(timedOut ? "模型目录刷新超时，使用缓存结果"
      : `模型目录刷新失败：${error instanceof Error ? error.message : String(error)}；使用缓存结果`, "warning");
  } finally { clearTimeout(timeout); signal.removeEventListener("abort", abort); }
  if (!signal.aborted) return resolver.findExactModelReferenceMatch(reference, [...session.modelRuntime.getAvailableSnapshot()]);
}

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
