import { afterEach, describe, expect, it, vi } from "vitest";
import { findEditorModel } from "../../packages/agent-pi/src/model-selector.js";

afterEach(() => vi.useRealTimers());
type Session = Parameters<typeof findEditorModel>[0];
const model = (provider: string, id: string) => ({ provider, id }) as NonNullable<Session["model"]>;
function setup(models: NonNullable<Session["model"]>[]) {
  const scoped: Array<Session["scopedModels"][number]> = [];
  const refresh = vi.fn<(options: { signal: AbortSignal }) => Promise<{ errors: Map<string, Error>; aborted: boolean }>>()
    .mockResolvedValue({ errors: new Map(), aborted: false });
  const session = { scopedModels: scoped, modelRuntime: { getAvailableSnapshot: () => models, refresh } } as unknown as Session;
  return { session, scoped, refresh, controller: new AbortController(), notify: vi.fn() };
}

describe("native editor model references and refresh lifetime", () => {
  it("keeps ambiguous ids unresolved and searches only the native scope", async () => {
    const models = [model("one", "same"), model("two", "same")];
    const h = setup(models);
    h.scoped.push(...models.map(model => ({ model, thinkingLevel: "off" as const })));
    expect(await findEditorModel(h.session, "same", h.controller.signal, h.notify)).toBeUndefined();
    expect(await findEditorModel(h.session, "TWO/SAME", h.controller.signal, h.notify)).toBe(models[1]);
    expect(await findEditorModel(h.session, "missing", h.controller.signal, h.notify)).toBeUndefined();
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it("rechecks refreshed catalogs and reports failures while preserving cached matches", async () => {
    const models: NonNullable<Session["model"]>[] = [];
    const h = setup(models), discovered = model("one", "new");
    h.refresh.mockImplementation(async () => {
      models.push(discovered);
      return { errors: new Map([["unavailable", new Error("offline")]]), aborted: false };
    });
    expect(await findEditorModel(h.session, "one/new", h.controller.signal, h.notify)).toBe(discovered);
    expect(h.notify).toHaveBeenCalledWith(expect.stringContaining("unavailable"), "warning");
  });

  it("detaches an aborted editor from a shared refresh without cancelling another editor", async () => {
    const models: NonNullable<Session["model"]>[] = [];
    const h = setup(models), other = new AbortController();
    let finish!: (result: { errors: Map<string, Error>; aborted: boolean }) => void;
    let sharedSignal!: AbortSignal;
    h.refresh.mockImplementation(({ signal }) => { sharedSignal = signal; return new Promise(resolve => { finish = resolve; }); });
    const first = findEditorModel(h.session, "one/new", h.controller.signal, h.notify);
    const second = findEditorModel(h.session, "one/new", other.signal, vi.fn());
    h.controller.abort(); expect(await first).toBeUndefined();
    expect(sharedSignal.aborted).toBe(false);
    const discovered = model("one", "new"); models.push(discovered);
    finish({ errors: new Map(), aborted: false });
    expect(await second).toBe(discovered);
    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(h.notify).not.toHaveBeenCalledWith(expect.anything(), "warning");
  });

  it("bounds refresh by the native timeout and releases the last subscriber", async () => {
    vi.useFakeTimers();
    const h = setup([]); let signal!: AbortSignal;
    h.refresh.mockImplementation(options => { signal = options.signal; return new Promise(() => {}); });
    const result = findEditorModel(h.session, "missing", h.controller.signal, h.notify);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await result).toBeUndefined(); expect(signal.aborted).toBe(true);
    expect(h.notify).toHaveBeenCalledWith(expect.stringContaining("超时"), "warning");
    expect(vi.getTimerCount()).toBe(0);
  });
});
