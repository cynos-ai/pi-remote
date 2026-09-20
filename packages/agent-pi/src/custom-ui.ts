import type { ExtensionUIContext, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { nativeTextTheme, type Widget } from "./widget-host.js";
import { CustomTextTui } from "./custom-tui.js";

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
}, options?: Parameters<ExtensionUIContext["custom"]>[1]): Promise<T> {
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
        const lines = tui.renderFrame();
        const encoded = JSON.stringify(lines);
        if (!closed && encoded !== last) { last = encoded; bridge.publish(lines); }
      } catch (error) { close(undefined, error); }
    });
  };
  const tui = new CustomTextTui(render);
  try {
    tui.start();
    if (!closed) {
      const creation = Promise.resolve().then(() => factory(tui, nativeTextTheme(), keybindings.KeybindingsManager.create(bridge.agentDir), value => close(value)))
        .then(created => {
          if (closed) { created.dispose?.(); return; }
          component = created;
          if (options?.overlay) {
            const fallbackWidth = (created as Widget & { width?: number | `${number}%` }).width;
            const layout = typeof options.overlayOptions === "function" ? options.overlayOptions() : options.overlayOptions;
            const handle = tui.showOverlay(created, layout ?? (fallbackWidth ? { width: fallbackWidth } : undefined));
            options.onHandle?.(handle);
          } else { tui.addChild(created); tui.setFocus(created); }
          render();
        })
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
      if (data !== undefined) tui.deliverInput(data);
      render();
    }
    if (failure !== undefined) throw failure;
    return result as T;
  } finally {
    close();
    bridge.signal.removeEventListener("abort", abort);
    try { component?.dispose?.(); } finally { tui.stop(); bridge.publish(null); }
  }
}
