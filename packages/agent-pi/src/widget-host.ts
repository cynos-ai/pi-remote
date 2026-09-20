import { stripVTControlCharacters } from "node:util";
import { TuiMainScreen, type TUI, type Component, type Terminal } from "@earendil-works/pi-tui";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

// The pinned SDK does not export its theme loader from its public entry point.
// Keep this version-specific access inside agent-pi, alongside SDK types.
const themes = await import(new URL("./modes/interactive/theme/theme.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href) as {
  getThemeByName(name: string): ExtensionUIContext["theme"] | undefined;
};

export type Widget = Component & { dispose?(): void };
export type WidgetFactory = (tui: TUI, theme: ExtensionUIContext["theme"]) => Widget;

export function createTextTui(render: () => void): TuiMainScreen {
  const tui = new TuiMainScreen(createTextTerminal());
  tui.requestRender = render;
  return tui;
}

export function createTextTerminal(): Terminal {
  return {
    columns: 80, rows: 24, kittyProtocolActive: false,
    start: () => {}, stop: () => {}, drainInput: async () => {}, write: () => {},
    moveBy: () => {}, hideCursor: () => {}, showCursor: () => {}, clearLine: () => {},
    clearFromCursor: () => {}, clearScreen: () => {}, setTitle: () => {}, setProgress: () => {}
  };
}

export function nativeTextTheme(): ExtensionUIContext["theme"] {
  const theme = themes.getThemeByName("dark");
  if (!theme) throw new Error("Pinned SDK dark theme is unavailable");
  return theme;
}

export function renderTextComponent(component: Component): string[] {
  const raw = component.render(80);
  if (raw.some(line => line.includes("\u001b_G") || line.includes("\u001b]1337;File="))) throw new Error("Terminal image widgets need a mobile image adapter");
  return raw.map(line => stripVTControlCharacters(line));
}

/** Non-focused native widgets rendered as plain text at an explicit 80-column viewport. */
export class WidgetHost {
  private readonly entries = new Map<string, { component?: Widget; active: boolean; queued: boolean; last?: string; failure: (error: unknown) => void }>();

  set(key: string, factory: WidgetFactory, publish: (lines: string[]) => void, failure: (error: unknown) => void): void {
    this.remove(key);
    const entry = { active: true, queued: false, failure } as { component?: Widget; active: boolean; queued: boolean; last?: string; failure: (error: unknown) => void };
    this.entries.set(key, entry);
    const render = () => {
      if (!entry.active || entry.queued) return;
      entry.queued = true;
      queueMicrotask(() => {
        entry.queued = false;
        if (!entry.active || !entry.component) return;
        try {
          const lines = renderTextComponent(entry.component);
          const encoded = JSON.stringify(lines);
          if (entry.active && encoded !== entry.last) { entry.last = encoded; publish(lines); }
        } catch (error) { entry.last = undefined; failure(error); }
      });
    };
    // Widgets have no keyboard focus; the native TUI supplies layout utilities,
    // while render requests project the widget, never writing terminal bytes to IPC.
    const tui = createTextTui(render);
    try {
      entry.component = factory(tui, nativeTextTheme());
      if (!entry.active) { entry.component.dispose?.(); return; }
      render();
    } catch (error) { this.remove(key); failure(error); }
  }

  remove(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.active = false;
    this.entries.delete(key);
    try { entry.component?.dispose?.(); } catch (error) { entry.failure(error); }
  }

  dispose(): void {
    for (const key of this.entries.keys()) this.remove(key);
  }
}
