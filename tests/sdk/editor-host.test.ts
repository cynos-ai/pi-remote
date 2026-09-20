import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EditorHost } from "../../packages/agent-pi/src/editor-host.js";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const cleanup: Array<() => void> = [];
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose(); });
function setup() {
  const agentDir = mkdtempSync(join(tmpdir(), "editor-host-"));
  cleanup.push(() => rmSync(agentDir, { recursive: true, force: true }));
  const host = new EditorHost(); cleanup.push(() => host.stop());
  const questions: Array<(value?: Record<string, unknown>) => void> = [];
  const frames: unknown[] = [], texts: string[] = [], submitted: string[] = [], failures: unknown[] = [];
  const controller = new AbortController();
  const bridge: Parameters<EditorHost["run"]>[1] = {
    agentDir, signal: controller.signal, publish: value => { frames.push(value); },
    changed: text => { texts.push(text); }, submit: async text => { submitted.push(text); }, failure: error => { failures.push(error); },
    autocomplete: () => ({ getSuggestions: async () => ({ prefix: "", items: [{ value: "native", label: "native" }] }), applyCompletion: lines => ({ lines, cursorLine: 0, cursorCol: 0 }) }),
    ask: (_kind, _options, signal) => new Promise(resolve => {
      const abort = () => resolve(undefined);
      signal.addEventListener("abort", abort, { once: true });
      questions.push(value => { signal.removeEventListener("abort", abort); resolve(value); });
      if (signal.aborted) abort();
    })
  };
  return { host, bridge, controller, questions, frames, texts, submitted, failures };
}
function editor() {
  let text = "";
  let disposed = 0;
  const history: string[] = [];
  const component = {
    onChange: undefined as ((text: string) => void) | undefined,
    onSubmit: undefined as ((text: string) => void) | undefined,
    getText: () => text,
    setText(value: string) { text = value; this.onChange?.(text); },
    insertTextAtCursor(value: string) { this.setText(`${value}${text}`); },
    render: () => [text], invalidate() {},
    handleInput(value: string) { if (value === "\r") this.onSubmit?.(`transformed:${text}`); else this.setText(text + value); },
    addToHistory(value: string) { history.push(value); }, dispose() { disposed++; }
  };
  return { component, history, disposed: () => disposed };
}
describe("native extension editor host", () => {
  it("updates active layout and completions without replacing the editor or its draft", async () => {
    const h = setup(), e = editor();
    const padding: number[] = [], limits: number[] = [];
    let installs = 0;
    const component = { ...e.component, setPaddingX: (value: number) => { padding.push(value); },
      setAutocompleteMaxVisible: (value: number) => { limits.push(value); }, setAutocompleteProvider: () => { installs++; } };
    h.host.setText("retained draft");
    const running = h.host.run(() => component, h.bridge); await tick();
    const before = installs;
    h.host.setPaddingX(3); h.host.setAutocompleteMaxVisible(15); h.host.refreshAutocomplete();
    expect(padding.at(-1)).toBe(3); expect(limits.at(-1)).toBe(15); expect(installs).toBe(before + 1);
    expect(h.host.getText()).toBe("retained draft"); expect(e.disposed()).toBe(0); expect(h.submitted).toEqual([]);
    h.host.stop(); await running;
    h.host.setPaddingX(1); h.host.refreshAutocomplete();
    expect(padding.at(-1)).toBe(3); expect(installs).toBe(before + 1);
  });
  it("binds default actions, preserves special overrides and ignores stale actions", async () => {
    const h = setup(), e = editor();
    const calls: string[] = [];
    const onEscape = () => { calls.push("override"); };
    const component = { ...e.component, actionHandlers: new Map<string, () => void>([["app.clear", () => { calls.push("old"); }]]), onEscape };
    h.bridge.actions = new Map([
      ["app.clear", () => { calls.push("clear"); }],
      ["app.interrupt", () => { calls.push("stop"); }],
      ["app.tools.expand", async () => { throw new Error("action failed"); }]
    ]);
    const result = h.host.run(() => component, h.bridge); await tick();
    expect(component.onEscape).toBe(onEscape);
    component.onEscape(); component.actionHandlers.get("app.clear")!();
    component.actionHandlers.get("app.tools.expand")!(); await tick();
    expect(calls).toEqual(["override", "clear"]);
    expect(h.failures).toHaveLength(1);
    expect(h.host.getFactory()).toBeDefined();
    const staleClear = component.actionHandlers.get("app.clear")!;
    h.host.stop(); await result;
    component.actionHandlers.get("app.clear")!();
    component.actionHandlers.get("app.interrupt")!();
    expect(calls).toEqual(["override", "clear"]);
    const reinstalled = h.host.run(() => component, h.bridge); await tick();
    staleClear(); component.actionHandlers.get("app.clear")!();
    expect(calls).toEqual(["override", "clear", "clear"]);
    h.host.stop(); await reinstalled;
  });
  it("installs shortcuts only on native CustomEditor-shaped components and preserves overrides", async () => {
    const h = setup(), e = editor();
    const handler = () => true;
    let installations = 0;
    h.bridge.shortcuts = () => { installations++; return handler; };
    const component = { ...e.component, actionHandlers: new Map(), onExtensionShortcut: undefined as ((data: string) => boolean) | undefined };
    let result = h.host.run(() => component, h.bridge); await tick();
    expect(component.onExtensionShortcut).toBe(handler);
    h.host.stop(); await result;
    const override = () => false;
    component.onExtensionShortcut = override;
    result = h.host.run(() => component, h.bridge); await tick();
    expect(component.onExtensionShortcut).toBe(override);
    expect(installations).toBe(1);
    h.host.stop(); await result;
  });
  it("disposes a component when autocomplete installation fails", async () => {
    const h = setup(), e = editor();
    h.host.setText("draft");
    await expect(h.host.run(() => ({ ...e.component, setAutocompleteProvider() { throw new Error("completion setup"); } }), h.bridge)).rejects.toThrow("completion setup");
    expect(e.disposed()).toBe(1);
    expect(h.host.getText()).toBe("draft");
    expect(h.host.getFactory()).toBeUndefined();
  });
  it("preserves drafts, uses cursor insertion and submits the editor's callback value once", async () => {
    const h = setup(), e = editor();
    h.host.setText("draft");
    const factory = () => e.component;
    const result = h.host.run(factory, h.bridge);
    expect(h.host.getFactory()).toBe(factory);
    await tick(); expect(h.frames.at(-1)).toEqual(["draft"]);
    h.host.paste("cursor:");
    await tick(); expect(h.host.getText()).toBe("cursor:draft");
    h.questions.at(-1)!({ value: "Enter" }); await tick();
    expect(h.submitted).toEqual(["transformed:cursor:draft"]);
    expect(e.history).toEqual(h.submitted);
    expect(h.host.getText()).toBe("");
    h.host.setText("keep"); await tick();
    h.questions.at(-1)!(); await result;
    expect(h.host.getText()).toBe("keep");
    expect(h.host.getFactory()).toBeUndefined();
    expect(e.disposed()).toBe(1);
    expect(h.frames.at(-1)).toBeNull();
  });
  it("replaces the active editor and ignores old submit/change callbacks", async () => {
    const h = setup(), first = editor(), second = editor();
    const one = h.host.run(() => first.component, h.bridge); await tick();
    h.host.setText("preserved");
    const two = h.host.run(() => second.component, h.bridge); await tick(); await one;
    first.component.onSubmit?.("stale"); first.component.setText("stale");
    expect(h.submitted).toEqual([]);
    expect(h.host.getText()).toBe("preserved");
    expect(first.disposed()).toBe(1);
    h.host.stop(); await two;
    expect(second.disposed()).toBe(1);
  });
  it("stacks native autocomplete wrappers and keeps factory errors visible", async () => {
    const h = setup(), e = editor();
    let suggestion = "";
    h.host.addAutocompleteProvider(base => ({ ...base, triggerCharacters: ["#"], getSuggestions: async (...args) => {
      const value = await base.getSuggestions(...args);
      return { prefix: "", items: [...value!.items, { value: "wrapped", label: "wrapped" }] };
    } }));
    h.host.addAutocompleteProvider(base => ({ ...base, triggerCharacters: ["@"] }));
    const result = h.host.run(() => ({ ...e.component, setAutocompleteProvider(provider) {
      expect(provider.triggerCharacters).toEqual(["#", "@"]);
      void provider.getSuggestions([""], 0, 0, { signal: h.controller.signal }).then(value => { suggestion = value!.items.map(item => item.value).join(","); });
    } }), h.bridge);
    await tick(); expect(suggestion).toBe("native,wrapped");
    h.host.stop(); await result;
    await expect(h.host.run(() => { throw new Error("factory failed"); }, h.bridge)).rejects.toThrow("factory failed");
    expect(h.host.getFactory()).toBeUndefined();
  });
  it("retains failed submissions and does not overwrite a newer draft", async () => {
    const h = setup(), e = editor();
    let fail!: (error: Error) => void;
    h.bridge.submit = () => new Promise((_resolve, reject) => { fail = reject; });
    const result = h.host.run(() => e.component, h.bridge); await tick();
    h.host.setText("first"); h.questions.at(-1)!({ value: "Enter" }); await tick();
    fail(new Error("rejected")); await tick();
    expect(h.host.getText()).toBe("transformed:first");
    h.questions.at(-1)!({ value: "Enter" }); await tick();
    h.host.setText("newer"); fail(new Error("late failure")); await tick();
    expect(h.host.getText()).toBe("newer");
    h.questions.at(-1)!({ value: "Enter" }); await tick();
    h.host.setText("newer then cleared"); h.host.setText(""); fail(new Error("after clear")); await tick();
    expect(h.host.getText()).toBe("");
    expect(h.failures).toHaveLength(3);
    h.host.stop(); await result;
  });
});
