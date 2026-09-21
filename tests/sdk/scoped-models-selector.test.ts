import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createScopedModelsSelector } from "../../packages/agent-pi/src/scoped-models-selector.js";

type Args = Parameters<typeof createScopedModelsSelector>;
let KeybindingsManager: new () => Args[1];
beforeAll(async () => {
  ({ KeybindingsManager } = await import(pathToFileURL(resolve("packages/agent-pi/node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js")).href));
});
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).forEach(fn => fn()); vi.useRealTimers(); });
function setup(patterns?: string[]) {
  const models = ["first", "second", "third"].map(id => ({ id, provider: "test", name: id, reasoning: true })) as NonNullable<Args[2]["model"]>[];
  let finish!: (value: { errors: Map<string, Error>; aborted: boolean }) => void;
  let signal!: AbortSignal;
  const refresh = vi.fn((options: { signal: AbortSignal }) => { signal = options.signal; return new Promise<{ errors: Map<string, Error>; aborted: boolean }>(resolve => { finish = resolve; }); });
  const setScopedModels = vi.fn();
  const session = { scopedModels: [], setScopedModels, modelRuntime: { getAvailableSnapshot: () => models, refresh } } as unknown as Args[2];
  const persist = vi.fn(), done = vi.fn(), scopeChanged = vi.fn();
  const selector = createScopedModelsSelector({ requestRender: vi.fn() } as unknown as Args[0], new KeybindingsManager(), session,
    { getEnabledModels: () => patterns } as Args[3], () => true, persist, done, scopeChanged);
  cleanup.push(() => selector.dispose());
  return { models, selector, setScopedModels, persist, done, scopeChanged, signal: () => signal,
    finish: () => finish({ errors: new Map(), aborted: false }), frame: () => selector.render(120).join("\n") };
}

describe("native scoped model menu", () => {
  it("keeps user edits when refresh resolves and never saves implicitly", async () => {
    const h = setup(["test/*"]);
    h.selector.handleInput?.("\r"); // Disable first while refresh is pending.
    h.models.push({ ...h.models[0]!, id: "later", name: "later" });
    h.finish(); await tick();
    expect(h.setScopedModels.mock.lastCall?.[0].map((item: { model: { id: string } }) => item.model.id)).toEqual(["second", "third"]);
    expect(h.persist).not.toHaveBeenCalled();
    expect(h.scopeChanged).toHaveBeenCalledTimes(2);
    h.selector.handleInput?.("\u0013");
    expect(h.persist).toHaveBeenLastCalledWith(["test/second", "test/third"]);
  });

  it("retains missing configured entries and native order until explicitly saved", async () => {
    const h = setup(["test/missing", "test/second", "test/first"]);
    h.finish(); await tick();
    expect(h.frame()).toContain("unavailable");
    expect(h.setScopedModels.mock.lastCall?.[0].map((item: { model: { id: string } }) => item.model.id)).toEqual(["second", "first"]);
    h.selector.handleInput?.("\u0013");
    expect(h.persist).toHaveBeenLastCalledWith(["test/second", "test/first", "test/missing"]);
    h.selector.handleInput?.("\u001b[1;3B"); // Native Alt+Down reorders the selected enabled model.
    h.selector.handleInput?.("\u0013");
    expect(h.persist).toHaveBeenLastCalledWith(["test/first", "test/second", "test/missing"]);
    h.selector.handleInput?.("\u0018");
    expect(h.setScopedModels).toHaveBeenLastCalledWith([]);
    h.selector.handleInput?.("\u0013"); expect(h.persist).toHaveBeenLastCalledWith([]);
    h.selector.handleInput?.("\u0001"); h.selector.handleInput?.("\u0013");
    expect(h.persist).toHaveBeenLastCalledWith(undefined);
  });

  it("disposal aborts refresh and ignores stale changes and saves", async () => {
    const h = setup(["test/first"]); h.selector.dispose(); await tick();
    expect(h.signal().aborted).toBe(true);
    h.finish(); await tick(); h.selector.handleInput?.("\r"); h.selector.handleInput?.("\u0013");
    expect(h.setScopedModels).not.toHaveBeenCalled(); expect(h.persist).not.toHaveBeenCalled();
    expect(h.scopeChanged).not.toHaveBeenCalled();
  });

  it("times out catalog refresh while retaining the cached menu", async () => {
    vi.useFakeTimers(); const h = setup();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.signal().aborted).toBe(true); expect(h.frame()).toContain("timed out");
    h.selector.handleInput?.("\r"); expect(h.setScopedModels).toHaveBeenCalled();
  });
});
