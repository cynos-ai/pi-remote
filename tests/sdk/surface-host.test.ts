import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SurfaceHost } from "../../packages/agent-pi/src/surface-host.js";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const cleanup: Array<() => void> = [];
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose(); });
function setup() {
  const cwd = mkdtempSync(join(tmpdir(), "surface-test-"));
  cleanup.push(() => rmSync(cwd, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", "-b", "initial", cwd]);
  const host = new SurfaceHost(cwd);
  cleanup.push(() => host.dispose());
  return { cwd, host };
}

describe("native header/footer host", () => {
  it("supplies real Git branch notifications, statuses and provider counts", async () => {
    const { cwd, host } = setup();
    const frames: unknown[] = [];
    let disposed = 0;
    host.setStatus("build", "running");
    host.update(2, false);
    host.set("setFooter", (tui, theme, data) => {
      const unsubscribe = data.onBranchChange(() => tui.requestRender());
      return {
        render: width => [theme.fg("accent", `${width}:${data.getGitBranch()}:${data.getExtensionStatuses().get("build")}:${data.getAvailableProviderCount()}`)],
        invalidate() {}, dispose() { disposed++; unsubscribe(); }
      };
    }, value => frames.push(value));
    await tick();
    expect(frames.at(-1)).toEqual(["80:initial:running:2"]);
    execFileSync("git", ["-C", cwd, "symbolic-ref", "HEAD", "refs/heads/changed"]);
    await expect.poll(() => frames.at(-1), { timeout: 5000 }).toEqual(["80:changed:running:2"]);
    host.setStatus("build", undefined); host.update(3, false); await tick();
    expect(frames.at(-1)).toEqual(["80:changed:undefined:3"]);
    host.set("setFooter", undefined, value => frames.push(value));
    expect(disposed).toBe(1);
    expect(frames.at(-1)).toBeNull();
  });

  it("refreshes expandable headers without a render loop and suppresses stale callbacks", async () => {
    const { host } = setup();
    const frames: unknown[] = [];
    let refresh = () => {};
    let expansion = false;
    let disposed = 0;
    host.set("setHeader", tui => {
      refresh = () => tui.requestRender();
      return { render: () => [String(expansion)], invalidate() {},
        setExpanded(value: boolean) { expansion = value; tui.requestRender(); },
        dispose() { disposed++; }
      };
    }, value => frames.push(value));
    await tick(); host.update(1, true); await tick();
    expect(frames).toEqual([["false"], ["true"]]);
    host.set("setHeader", () => ({ render: () => ["replacement"], invalidate() {} }), value => frames.push(value));
    refresh(); await tick();
    expect(frames.at(-1)).toEqual(["replacement"]);
    expect(disposed).toBe(1);
    host.dispose(); refresh(); await tick();
    expect(frames).toHaveLength(3);
  });

  it("reports factory/render/dispose failures and permits explicit reset", async () => {
    const { host } = setup();
    const frames: unknown[] = [];
    const publish = (value: unknown) => frames.push(value);
    host.set("setHeader", () => { throw new Error("factory"); }, publish);
    host.set("setFooter", () => ({ render() { throw new Error("render"); }, invalidate() {}, dispose() { throw new Error("dispose"); } }), publish);
    await tick(); host.set("setFooter", undefined, publish);
    expect(frames).toEqual([{ rendererError: "factory" }, { rendererError: "render" }, { rendererError: "dispose" }, null]);
  });
});
