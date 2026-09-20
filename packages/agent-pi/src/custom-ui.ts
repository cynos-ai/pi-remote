import type { ExtensionUIContext, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { createTextTui, nativeTextTheme, renderTextComponent, type Widget } from "./widget-host.js";

const keybindings = await import(new URL("./core/keybindings.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href) as {
  KeybindingsManager: { create(agentDir?: string): KeybindingsManager };
};

export const customKeys: Record<string, string> = {
  "↑": "\u001b[A", "↓": "\u001b[B", "←": "\u001b[D", "→": "\u001b[C",
  Enter: "\r", Esc: "\u001b", Tab: "\t", Backspace: "\u007f",
  Home: "\u001b[H", End: "\u001b[F", "Page Up": "\u001b[5~", "Page Down": "\u001b[6~"
};

/** Input uses ordinary one-shot interactions, so retries cannot deliver a key twice. */
export async function runCustomUi<T>(factory: Parameters<ExtensionUIContext["custom"]>[0], bridge: {
  agentDir?: string;
  signal: AbortSignal;
  publish(lines: string[] | null): void;
  ask(kind: "select" | "input", options: string[] | undefined, signal: AbortSignal): Promise<Record<string, unknown> | undefined>;
}): Promise<T> {
  const controller = new AbortController();
  let closed = false;
  let result: unknown;
  let failure: unknown;
  let component: Widget | undefined;
  let queued = false;
  let last: string | undefined;
  let release!: () => void;
  const finished = new Promise<void>(resolve => { release = resolve; });
  const close = (value?: unknown, error?: unknown) => {
    if (closed) return;
    closed = true; result = value; failure = error;
    controller.abort(); release();
  };
  const abort = () => close();
  bridge.signal.addEventListener("abort", abort, { once: true });
  if (bridge.signal.aborted) abort();
  const render = () => {
    if (closed || queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (closed || !component) return;
      try {
        const lines = renderTextComponent(component);
        const encoded = JSON.stringify(lines);
        if (!closed && encoded !== last) { last = encoded; bridge.publish(lines); }
      } catch (error) { close(undefined, error); }
    });
  };
  const tui = createTextTui(render);
  try {
    if (!closed) {
      const creation = Promise.resolve().then(() => factory(tui, nativeTextTheme(), keybindings.KeybindingsManager.create(bridge.agentDir), value => close(value)))
        .then(created => { if (closed) created.dispose?.(); else { component = created; tui.setFocus(created); render(); } })
        .catch(error => close(undefined, error));
      await Promise.race([creation, finished]);
    }
    while (!closed) {
      const response = await bridge.ask("select", [...Object.keys(customKeys), "输入文本"], controller.signal);
      if (closed) break;
      if (!response) { close(); break; }
      let data = customKeys[String(response.value)];
      if (response.value === "输入文本") {
        const text = await bridge.ask("input", undefined, controller.signal);
        if (closed) break;
        if (!text) continue; // Cancelling text entry returns to the component controls.
        data = typeof text.value === "string" ? text.value : "";
      }
      if (data !== undefined) component?.handleInput?.(data);
      render();
    }
    if (failure !== undefined) throw failure;
    return result as T;
  } finally {
    close();
    bridge.signal.removeEventListener("abort", abort);
    try { component?.dispose?.(); } finally { bridge.publish(null); }
  }
}
