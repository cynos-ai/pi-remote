import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { TerminalInputHub, encodeTerminalKey } from "../../packages/agent-pi/src/terminal-input.js";
import { CustomTextTui } from "../../packages/agent-pi/src/custom-tui.js";

const require = createRequire(resolve("packages/agent-pi/package.json"));
const { matchesKey } = require("@earendil-works/pi-tui") as { matchesKey(data: string, key: string): boolean };

describe("native terminal input subscriptions", () => {
  it("preserves native listener order, transforms, consumption and unsubscribe", () => {
    const hub = new TerminalInputHub();
    const tui = new CustomTextTui(() => {});
    const seen: string[] = [];
    const first = hub.subscribe(data => { seen.push(`global:${data}`); return data === "hide" ? { consume: true } : { data: data.toUpperCase() }; });
    const detach = hub.attach(tui);
    tui.addInputListener(data => { seen.push(`local:${data}`); });
    tui.setFocus({ render: () => [], invalidate() {}, handleInput: data => seen.push(`component:${data}`) });
    tui.start();
    try {
      tui.deliverInput("a"); tui.deliverInput("hide");
      expect(seen).toEqual(["global:a", "local:A", "component:A", "global:hide"]);
      const late = hub.subscribe(data => { seen.push(`late:${data}`); return { consume: true }; });
      seen.length = 0; tui.deliverInput("b");
      expect(seen).toEqual(["global:b", "local:B", "late:B"]);
      first(); first(); late();
      seen.length = 0; tui.deliverInput("c");
      expect(seen).toEqual(["local:c", "component:c"]);
      hub.subscribe(() => ({ consume: true })); hub.clear();
      seen.length = 0; tui.deliverInput("d");
      expect(seen).toEqual(["local:d", "component:d"]);
    } finally { detach(); tui.stop(); hub.clear(); }
  });

  it("detaches closed surfaces while retaining listeners for a new surface", () => {
    const hub = new TerminalInputHub();
    let calls = 0;
    hub.subscribe(() => { calls++; });
    const old = new CustomTextTui(() => {}), next = new CustomTextTui(() => {});
    old.start(); next.start();
    const detachOld = hub.attach(old); detachOld();
    const detachNext = hub.attach(next);
    old.deliverInput("a"); next.deliverInput("b");
    expect(calls).toBe(1);
    hub.clear(); next.deliverInput("c"); expect(calls).toBe(1);
    detachNext(); old.stop(); next.stop();
  });

  it("encodes combinations recognized by the pinned native key matcher", () => {
    for (const key of ["ctrl+k", "ctrl+c", "ctrl+space", "alt+enter", "shift+enter", "shift+tab", "ctrl+alt+k", "ctrl+shift+left", "alt+up", "ctrl+delete", "ctrl+/", "f1", "f5"]) {
      const data = encodeTerminalKey(key);
      expect(data, key).toBeDefined();
      expect(matchesKey(data!, key), key).toBe(true);
    }
    for (const invalid of ["", "ctrl+ctrl+k", "meta+k", "ctrl+unknown", "f99", "ctrl+\n"]) expect(encodeTerminalKey(invalid)).toBeUndefined();
  });

  it("preserves modified function-key bytes but records the SDK matcher limitation", () => {
    // Pinned keys.js explicitly returns false for F1–F12 with modifiers.
    // Raw listeners/components may still handle these bytes themselves.
    expect(encodeTerminalKey("shift+f12")).toBe("\u001b[24;2~");
    expect(matchesKey(encodeTerminalKey("shift+f12")!, "shift+f12")).toBe(false);
  });
});
