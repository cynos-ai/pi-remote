import type { AgentSession, KeybindingsManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { initializeNativeMenu } from "./model-selector.js";

type Model = NonNullable<AgentSession["model"]>;
type Ids = string[] | null;
type Selector = Component & { focused: boolean; updateModels(models: Model[], ids?: Ids): void;
  setRefreshStatus(message: string, kind: "success" | "warning"): void };
const native = await import(new URL("./modes/interactive/components/scoped-models-selector.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href) as {
  ScopedModelsSelectorComponent: new (config: { allModels: Model[]; enabledModelIds: Ids; refreshStatus: string },
    callbacks: { onChange(ids: Ids): void; onPersist(ids: Ids): void; onCancel(): void }) => Selector;
};
const resolver = await import(new URL("./core/model-resolver.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href) as {
  resolveModelScopeFromModels(patterns: string[], models: Model[]): {
    scopedModels: AgentSession["scopedModels"]; diagnostics: { code: string; pattern: string }[] };
};
const catalogs = await import(new URL("./modes/interactive/model-catalog-refresh.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href) as {
  refreshModelCatalogs(runtime: AgentSession["modelRuntime"], signal: AbortSignal): ReturnType<AgentSession["modelRuntime"]["refresh"]>;
};

export function createScopedModelsSelector(tui: TUI, keys: KeybindingsManager, session: AgentSession,
  settings: SettingsManager, valid: () => boolean, persist: (patterns: string[] | undefined) => void,
  done: () => void, scopeChanged: () => void = () => {}): Selector & { dispose(): void } {
  initializeNativeMenu(keys);
  let models = [...session.modelRuntime.getAvailableSnapshot()];
  let available = new Set(models.map(model => `${model.provider}/${model.id}`));
  const patterns = settings.getEnabledModels();
  const initialScope = session.scopedModels;
  const configured = (): Ids => {
    if (!patterns?.length) return null;
    const resolved = resolver.resolveModelScopeFromModels(patterns, models);
    const ids = resolved.scopedModels.map(item => `${item.model.provider}/${item.model.id}`);
    for (const diagnostic of resolved.diagnostics)
      if (diagnostic.code === "no-match" && !ids.includes(diagnostic.pattern)) ids.push(diagnostic.pattern);
    return ids;
  };
  let current: Ids = initialScope.length ? initialScope.map(item => `${item.model.provider}/${item.model.id}`) : configured();
  let changed = false, disposed = false, timedOut = false;
  const active = () => !disposed && valid();
  const update = (ids: Ids) => {
    if (!active()) return;
    current = ids === null ? null : [...ids];
    // Native empty/all/unavailable-only selections mean unrestricted cycling.
    session.setScopedModels(ids && ids.some(id => available.has(id)) && ![...available].every(id => ids.includes(id))
      ? resolver.resolveModelScopeFromModels(ids, models).scopedModels.map(item => ({ model: item.model, thinkingLevel: item.thinkingLevel })) : []);
    scopeChanged();
    tui.requestRender();
  };
  const controller = new AbortController();
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 15_000);
  const selector = new native.ScopedModelsSelectorComponent({ allModels: models, enabledModelIds: current,
    refreshStatus: "Refreshing model catalogs…" }, {
    onChange: ids => { if (active()) { changed = true; update(ids); } },
    onPersist: ids => {
      if (active()) persist(ids === null || (ids.length === models.length && ids.every(id => available.has(id))) ? undefined : [...ids]);
    },
    onCancel: done
  });
  void catalogs.refreshModelCatalogs(session.modelRuntime, controller.signal).then(result => {
    if (!active()) return;
    models = [...session.modelRuntime.getAvailableSnapshot()];
    available = new Set(models.map(model => `${model.provider}/${model.id}`));
    if (!changed && initialScope.length === 0) { current = configured(); selector.updateModels(models, current); }
    else selector.updateModels(models);
    if (current !== null) update(current);
    selector.setRefreshStatus(result.aborted && timedOut ? "Model refresh timed out; showing cached models."
      : result.errors.size ? `Could not refresh ${[...result.errors.keys()].join(", ")}; showing cached models.` : "Model catalogs refreshed.",
    result.errors.size || (result.aborted && timedOut) ? "warning" : "success");
    tui.requestRender();
  }).catch(error => {
    if (!active()) return;
    selector.setRefreshStatus(timedOut ? "Model refresh timed out; showing cached models."
      : `Could not refresh model catalogs: ${error instanceof Error ? error.message : String(error)}`, "warning");
    tui.requestRender();
  }).finally(() => clearTimeout(timeout));
  return Object.assign(selector, { dispose() { disposed = true; clearTimeout(timeout); controller.abort(); } });
}
