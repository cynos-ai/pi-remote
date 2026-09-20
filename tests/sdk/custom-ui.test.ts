import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCustomUi } from "../../packages/agent-pi/src/custom-ui.js";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const temporaryAgents: string[] = [];
afterEach(() => { for (const directory of temporaryAgents.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function bridge() {
  const agentDir = mkdtempSync(join(tmpdir(), "custom-ui-test-"));
  temporaryAgents.push(agentDir);
  const controller = new AbortController();
  const frames: Array<string[] | null> = [];
  const questions: Array<{ kind: string; answer(value?: Record<string, unknown>): void }> = [];
  return { controller, frames, questions, options: {
    agentDir,
    signal: controller.signal,
    publish: (lines: string[] | null) => { frames.push(lines); },
    ask: (kind: "select" | "input", _keys: string[] | undefined, signal: AbortSignal) => new Promise<Record<string, unknown> | undefined>(resolve => {
      const abort = () => resolve(undefined);
      signal.addEventListener("abort", abort, { once: true });
      questions.push({ kind, answer: value => { signal.removeEventListener("abort", abort); resolve(value); } });
      if (signal.aborted) abort();
    })
  } };
}

describe("native custom component input lifecycle", () => {
  it("handles synchronous done and factory/render failures without leaving controls", async () => {
    const immediate = bridge();
    let disposed = 0;
    expect(await runCustomUi((_tui, _theme, _keys, done) => {
      done("ready");
      return { render: () => ["unused"], invalidate() {}, dispose() { disposed++; } };
    }, immediate.options)).toBe("ready");
    await tick();
    expect(disposed).toBe(1);
    expect(immediate.questions).toEqual([]);
    const failure = bridge();
    await expect(runCustomUi(() => { throw new Error("factory failed"); }, failure.options)).rejects.toThrow("factory failed");
    const renderFailure = bridge();
    await expect(runCustomUi(() => ({ render() { throw new Error("render failed"); }, invalidate() {}, dispose() { disposed++; } }), renderFailure.options)).rejects.toThrow("render failed");
    expect(disposed).toBe(2);
    expect(renderFailure.frames.at(-1)).toBeNull();
  });
  it("delivers keys/text and returns the original done value once, with focus and native keybindings", async () => {
    const h = bridge();
    let disposed = 0;
    const inputs: string[] = [];
    const expected = { chosen: "original object" };
    let focused = false;
    const result = runCustomUi((tui, theme, keys, done) => ({
      get focused() { return focused; },
      set focused(value: boolean) { focused = value; },
      render() { return [theme.fg("accent", `inputs:${inputs.length}`)]; },
      invalidate() {},
      handleInput(data) {
        expect(focused).toBe(true);
        expect(typeof keys.getEffectiveConfig()).toBe("object");
        inputs.push(data); tui.requestRender();
        if (data === "\r") { done(expected); done("ignored"); }
      },
      dispose() { disposed++; }
    }), h.options);
    await tick(); h.questions.at(-1)!.answer({ value: "↓" });
    await tick(); h.questions.at(-1)!.answer({ value: "输入文本" });
    await tick(); expect(h.questions.at(-1)!.kind).toBe("input");
    h.questions.at(-1)!.answer({ value: "hello中文" });
    await tick(); h.questions.at(-1)!.answer({ value: "Enter" });
    expect(await result).toBe(expected);
    expect(inputs).toEqual(["\u001b[B", "hello中文", "\r"]);
    expect(disposed).toBe(1);
    expect(h.frames[0]).toEqual(["inputs:0"]);
    expect(h.frames.at(-1)).toBeNull();
  });

  it("allows asynchronous done while a form waits and cancels a slow factory without leaking it", async () => {
    const h = bridge();
    let done!: (value: unknown) => void;
    let disposed = 0;
    const result = runCustomUi((_tui, _theme, _keys, complete) => {
      done = complete;
      return { render: () => ["waiting"], invalidate() {}, dispose() { disposed++; } };
    }, h.options);
    await tick(); done(42);
    expect(await result).toBe(42);
    expect(disposed).toBe(1);

    const slow = bridge();
    let release!: (value: { render(): string[]; invalidate(): void; dispose(): void }) => void;
    const pending = runCustomUi(() => new Promise(resolve => { release = resolve; }), slow.options);
    await tick(); slow.controller.abort();
    expect(await pending).toBeUndefined();
    release({ render: () => ["late"], invalidate() {}, dispose() { disposed++; } });
    await tick();
    expect(disposed).toBe(2);
    expect(slow.frames).toEqual([null]);
    expect(slow.questions).toEqual([]);
  });

  it("routes Escape to the component, distinguishes cancelling text entry, and cleans up input errors", async () => {
    const h = bridge();
    const input: string[] = [];
    let disposed = 0;
    const result = runCustomUi(() => ({
      render: () => ["controls"], invalidate() {},
      handleInput(data) { input.push(data); if (data === "\r") throw new Error("input failed"); },
      dispose() { disposed++; }
    }), h.options);
    const rejection = expect(result).rejects.toThrow("input failed");
    await tick(); h.questions.at(-1)!.answer({ value: "Esc" });
    await tick(); h.questions.at(-1)!.answer({ value: "输入文本" });
    await tick(); h.questions.at(-1)!.answer();
    await tick(); h.questions.at(-1)!.answer({ value: "Enter" });
    await rejection;
    expect(input).toEqual(["\u001b", "\r"]);
    expect(disposed).toBe(1);
    expect(h.frames.at(-1)).toBeNull();
  });
});
