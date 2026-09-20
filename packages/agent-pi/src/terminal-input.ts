import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

type Handler = Parameters<ExtensionUIContext["onTerminalInput"]>[0];

/** Bind each subscription to native TUI routing, preserving registration order. */
export class TerminalInputHub {
  private readonly subscriptions = new Set<{ handler: Handler; bindings: Map<TUI, () => void> }>();
  private readonly surfaces = new Set<TUI>();

  subscribe(handler: Handler): () => void {
    const entry = { handler, bindings: new Map<TUI, () => void>() };
    this.subscriptions.add(entry);
    for (const tui of this.surfaces) entry.bindings.set(tui, tui.addInputListener(handler));
    return () => {
      for (const unsubscribe of entry.bindings.values()) unsubscribe();
      entry.bindings.clear(); this.subscriptions.delete(entry);
    };
  }

  attach(tui: TUI): () => void {
    this.surfaces.add(tui);
    for (const entry of this.subscriptions) entry.bindings.set(tui, tui.addInputListener(entry.handler));
    return () => {
      this.surfaces.delete(tui);
      for (const entry of this.subscriptions) { entry.bindings.get(tui)?.(); entry.bindings.delete(tui); }
    };
  }

  clear(): void {
    for (const entry of this.subscriptions) {
      for (const unsubscribe of entry.bindings.values()) unsubscribe();
      entry.bindings.clear();
    }
    this.subscriptions.clear();
  }
}

/** Encode standard terminal keys; native matchesKey remains the decoder/authority. */
export function encodeTerminalKey(value: string): string | undefined {
  const parts = value.trim().toLowerCase().split("+");
  let key = parts.pop();
  if (key === "" && parts.at(-1) === "") { parts.pop(); key = "+"; }
  if (!key || new Set(parts).size !== parts.length || parts.some(part => !["ctrl", "alt", "shift"].includes(part))) return;
  const ctrl = parts.includes("ctrl"), alt = parts.includes("alt"), shift = parts.includes("shift");
  const modifier = 1 + (shift ? 1 : 0) + (alt ? 2 : 0) + (ctrl ? 4 : 0);
  const final = ({ up: "A", down: "B", right: "C", left: "D", home: "H", end: "F" } as Record<string, string>)[key];
  if (final) return modifier === 1 ? `\u001b[${final}` : `\u001b[1;${modifier}${final}`;
  const tilde = ({ insert: 2, delete: 3, pageup: 5, pagedown: 6, f5: 15, f6: 17, f7: 18, f8: 19, f9: 20, f10: 21, f11: 23, f12: 24 } as Record<string, number>)[key];
  if (tilde) return `\u001b[${tilde}${modifier === 1 ? "" : `;${modifier}`}~`;
  if (/^f[1-4]$/.test(key)) {
    const code = String.fromCharCode(79 + Number(key.slice(1)));
    return modifier === 1 ? `\u001bO${code}` : `\u001b[1;${modifier}${code}`;
  }
  const code = ({ enter: 13, tab: 9, esc: 27, escape: 27, backspace: 127, space: 32 } as Record<string, number>)[key]
    ?? (/^[\x21-\x7e]$/.test(key) ? key.charCodeAt(0) : undefined);
  if (code === undefined) return;
  if (modifier === 1) return String.fromCharCode(code);
  if (ctrl && !alt && !shift && /^[a-z]$/.test(key)) return String.fromCharCode(code - 96);
  return `\u001b[${code};${modifier}u`;
}
