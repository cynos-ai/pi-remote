import type { AgentSession, KeybindingsManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { Component, SettingsList } from "@earendil-works/pi-tui";
import { initializeNativeMenu } from "./model-selector.js";

type Level = Parameters<AgentSession["setThinkingLevel"]>[0];
const defaults = await import(new URL("./core/defaults.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href) as {
  DEFAULT_THINKING_LEVEL: Level; THINKING_LEVEL_OPTIONS: Level[];
};
const http = await import(new URL("./core/http-dispatcher.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href) as {
  configureHttpDispatcher(timeout: number): void;
};
// This version-specific constructor is intentionally confined to the SDK adapter.
const native = await import(new URL("./modes/interactive/components/settings-selector.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href) as {
  SettingsSelectorComponent: new (config: Record<string, unknown>, callbacks: Record<string, unknown>) => Component & { getSettingsList(): SettingsList };
};
type Bridge = {
  change(apply: () => void): void;
  unavailable(message: string): void;
  refreshAutocomplete(): void;
  setPaddingX(value: number): void;
  setAutocompleteMaxVisible(value: number): void;
};

export function createSettingsSelector(keys: KeybindingsManager, session: AgentSession, s: SettingsManager,
  bridge: Bridge, done: () => void): Component & { dispose(): void } {
  initializeNativeMenu(keys);
  let closed = false;
  const apply = (fn: () => void) => { if (!closed) bridge.change(fn); };
  const pending = (id: string) => () => {
    if (closed) return;
    selector.getSettingsList().updateValue(id, "待适配");
    bridge.unavailable("该设置的显示或启动行为尚未接入，设置未修改");
  };
  const pendingItems = {
    onShowImagesChange: "show-images", onImageWidthCellsChange: "image-width-cells",
    onThemeChange: "theme", onHideThinkingBlockChange: "hide-thinking", onMermaidRenderingModeChange: "mermaid-rendering",
    onShowCacheMissNoticesChange: "cache-miss-notices", onCollapseChangelogChange: "collapse-changelog",
    onEnableInstallTelemetryChange: "install-telemetry", onQuietStartupChange: "quiet-startup",
    onShowHardwareCursorChange: "show-hardware-cursor", onOutputPadChange: "output-padding",
    onClearOnShrinkChange: "clear-on-shrink", onShowTerminalProgressChange: "terminal-progress",
    onTuiModeChange: "tui-mode", onFullscreenExitOutputChange: "fullscreen-exit-output",
    onFullscreenScrollbarChange: "fullscreen-scrollbar", onFullscreenCopyOnSelectChange: "fullscreen-copy-on-select",
    onWarningsChange: "warnings"
  };
  const selector: InstanceType<typeof native.SettingsSelectorComponent> = new native.SettingsSelectorComponent({
    autoCompact: session.autoCompactionEnabled,
    defaultModel: s.getDefaultProvider() && s.getDefaultModel() ? `${s.getDefaultProvider()}/${s.getDefaultModel()}` : "not set",
    currentModel: session.model, availableDefaultModels: session.modelRuntime.getAvailableSnapshot(),
    showImages: s.getShowImages(), imageWidthCells: s.getImageWidthCells(), autoResizeImages: s.getImageAutoResize(),
    blockImages: s.getBlockImages(), enableSkillCommands: s.getEnableSkillCommands(),
    steeringMode: session.steeringMode, followUpMode: session.followUpMode,
    transport: s.getTransport(), httpIdleTimeoutMs: s.getHttpIdleTimeoutMs(),
    thinkingLevel: s.getDefaultThinkingLevel() ?? defaults.DEFAULT_THINKING_LEVEL,
    availableThinkingLevels: [...defaults.THINKING_LEVEL_OPTIONS], modelThinkingLevels: s.getAllModelThinkingLevels(),
    currentTheme: "dark", terminalTheme: "dark", availableThemes: ["dark"],
    hideThinkingBlock: s.getHideThinkingBlock(), mermaidRenderingMode: s.getMermaidRenderingMode(),
    showCacheMissNotices: s.getShowCacheMissNotices(), collapseChangelog: s.getCollapseChangelog(),
    enableInstallTelemetry: s.getEnableInstallTelemetry(), doubleEscapeAction: s.getDoubleEscapeAction(),
    treeFilterMode: s.getTreeFilterMode(), showHardwareCursor: s.getShowHardwareCursor(),
    editorPaddingX: s.getEditorPaddingX(), outputPad: s.getOutputPad(), autocompleteMaxVisible: s.getAutocompleteMaxVisible(),
    quietStartup: s.getQuietStartup(), defaultProjectTrust: s.getDefaultProjectTrust(),
    clearOnShrink: s.getClearOnShrink(), showTerminalProgress: s.getShowTerminalProgress(), tuiMode: s.getTuiMode(),
    fullscreenExitOutput: s.getFullscreenExitOutput(), fullscreenScrollbar: s.getFullscreenScrollbar(),
    fullscreenCopyOnSelect: s.getFullscreenCopyOnSelect(), warnings: s.getWarnings()
  }, {
    ...Object.fromEntries(Object.entries(pendingItems).map(([callback, id]) => [callback, pending(id)])),
    onAutoCompactChange: (enabled: boolean) => apply(() => session.setAutoCompactionEnabled(enabled)),
    onAutoResizeImagesChange: (enabled: boolean) => apply(() => s.setImageAutoResize(enabled)),
    onBlockImagesChange: (enabled: boolean) => apply(() => s.setBlockImages(enabled)),
    onEnableSkillCommandsChange: (enabled: boolean) => apply(() => { s.setEnableSkillCommands(enabled); bridge.refreshAutocomplete(); }),
    onSteeringModeChange: (mode: Parameters<AgentSession["setSteeringMode"]>[0]) => apply(() => session.setSteeringMode(mode)),
    onFollowUpModeChange: (mode: Parameters<AgentSession["setFollowUpMode"]>[0]) => apply(() => session.setFollowUpMode(mode)),
    onTransportChange: (transport: Parameters<SettingsManager["setTransport"]>[0]) => apply(() => { s.setTransport(transport); session.agent.transport = transport; }),
    onHttpIdleTimeoutMsChange: (timeout: number) => apply(() => { s.setHttpIdleTimeoutMs(timeout); http.configureHttpDispatcher(timeout); }),
    onModelThinkingLevelChange: (provider: string, id: string, level: Level) => apply(() => {
      s.setModelThinkingLevel(provider, id, level);
      if (session.model?.provider === provider && session.model.id === id) session.setThinkingLevel(level);
    }),
    onModelThinkingLevelRemove: (provider: string, id: string) => apply(() => {
      s.removeModelThinkingLevel(provider, id);
      if (session.model?.provider === provider && session.model.id === id) session.setThinkingLevel(s.getDefaultThinkingLevel() ?? defaults.DEFAULT_THINKING_LEVEL);
    }),
    onDoubleEscapeActionChange: (value: Parameters<SettingsManager["setDoubleEscapeAction"]>[0]) => apply(() => s.setDoubleEscapeAction(value)),
    onTreeFilterModeChange: (value: Parameters<SettingsManager["setTreeFilterMode"]>[0]) => apply(() => s.setTreeFilterMode(value)),
    onDefaultProjectTrustChange: (value: Parameters<SettingsManager["setDefaultProjectTrust"]>[0]) => apply(() => s.setDefaultProjectTrust(value)),
    onEditorPaddingXChange: (value: number) => apply(() => { s.setEditorPaddingX(value); bridge.setPaddingX(value); }),
    onAutocompleteMaxVisibleChange: (value: number) => apply(() => { s.setAutocompleteMaxVisible(value); bridge.setAutocompleteMaxVisible(value); }),
    onCancel: done
  });
  for (const id of Object.values(pendingItems)) selector.getSettingsList().updateValue(id, "待适配");
  return { render: width => selector.render(width), invalidate: () => selector.invalidate(),
    handleInput: data => { if (!closed) selector.getSettingsList().handleInput(data); }, dispose: () => { closed = true; } };
}
