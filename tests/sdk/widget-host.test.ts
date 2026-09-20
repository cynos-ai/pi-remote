import { describe, expect, it } from "vitest";
import { WidgetHost } from "../../packages/agent-pi/src/widget-host.js";

const tick = () => new Promise<void>(resolve => queueMicrotask(resolve));

describe("native widget component host", () => {
  it("renders with a native theme, refreshes, deduplicates and disposes stale factories", async () => {
    const host = new WidgetHost();
    const output: string[][] = [];
    const errors: unknown[] = [];
    let refresh = () => {};
    let value = "first";
    let broken = false;
    let disposed = 0;
    host.set("widget", (tui, theme) => {
      refresh = () => tui.requestRender();
      expect(tui.terminal.columns).toBe(80);
      return { render: width => { if (broken) throw new Error("temporary"); return [theme.fg("accent", `${width}:${value}`)]; }, invalidate() {}, dispose() { disposed++; } };
    }, lines => output.push(lines), error => errors.push(error));
    await tick();
    expect(output).toEqual([["80:first"]]);
    refresh(); await tick();
    expect(output).toHaveLength(1);
    value = "next"; refresh(); await tick();
    expect(output.at(-1)).toEqual(["80:next"]);
    broken = true; refresh(); await tick();
    broken = false; refresh(); await tick();
    expect(output.at(-1)).toEqual(["80:next"]);
    refresh(); host.remove("widget"); await tick();
    refresh(); await tick();
    expect(disposed).toBe(1);
    expect(output).toHaveLength(3);
    expect(errors.map(error => (error as Error).message)).toEqual(["temporary"]);
    host.dispose();
  });

  it("reports factory/render/dispose errors while allowing replacement and clearing all widgets", async () => {
    const host = new WidgetHost();
    const errors: unknown[] = [];
    const fail = (error: unknown) => errors.push(error);
    host.set("broken", () => { throw new Error("factory"); }, () => {}, fail);
    host.set("render", () => ({ render() { throw new Error("render"); }, invalidate() {}, dispose() { throw new Error("dispose"); } }), () => {}, fail);
    let disposed = false;
    host.set("other", () => ({ render: () => ["ok"], invalidate() {}, dispose() { disposed = true; } }), () => {}, fail);
    await tick(); host.dispose();
    expect(errors.map(error => (error as Error).message)).toEqual(["factory", "render", "dispose"]);
    expect(disposed).toBe(true);
  });

  it("disposes a replaced factory and reports terminal images instead of leaking escape payloads", async () => {
    const host = new WidgetHost();
    const output: string[][] = [];
    const errors: unknown[] = [];
    let refresh = () => {};
    let disposed = 0;
    const publish = (lines: string[]) => output.push(lines);
    const failure = (error: unknown) => errors.push(error);
    host.set("same", tui => {
      refresh = () => tui.requestRender();
      return { render: () => ["old"], invalidate() {}, dispose() { disposed++; } };
    }, publish, failure);
    host.set("same", () => ({ render: () => ["new"], invalidate() {} }), publish, failure);
    refresh(); await tick();
    expect(output).toEqual([["new"]]);
    expect(disposed).toBe(1);
    host.set("same", () => ({ render: () => ["\u001b_Gpayload\u001b\\"], invalidate() {} }), publish, failure);
    await tick();
    expect((errors[0] as Error).message).toContain("image adapter");
    expect(output).toEqual([["new"]]);
    host.dispose();
  });
});
