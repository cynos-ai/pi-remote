import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createTrustSelector } from "../../packages/agent-pi/src/trust-selector.js";
import { saveProjectTrust } from "../../packages/agent-pi/src/project-trust.js";
import { createPiAgentSession } from "../../packages/agent-pi/src/runtime.js";

let KeybindingsManager: new () => Parameters<typeof createTrustSelector>[0];
beforeAll(async () => {
  ({ KeybindingsManager } = await import(pathToFileURL(resolve("packages/agent-pi/node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js")).href));
});
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-trust-menu-")); roots.push(root);
  const agentDir = join(root, "agent"), cwd = join(root, "project");
  await mkdir(agentDir); await mkdir(cwd);
  const done = vi.fn<Parameters<typeof createTrustSelector>[4]>();
  const open = () => createTrustSelector(new KeybindingsManager(), agentDir, cwd, true, done);
  return { root, agentDir, cwd, done, open, file: join(agentDir, "trust.json") };
}

describe("native project trust menu", () => {
  it("cancels without saving and applies native parent inheritance updates", async () => {
    const h = await fixture();
    h.open().handleInput?.("\u001b"); expect(h.done).toHaveBeenLastCalledWith();
    await expect(readFile(h.file)).rejects.toThrow();
    await writeFile(h.file, JSON.stringify({ [h.cwd]: false, unrelated: false }));
    const selector = h.open();
    expect(selector.render(120).join("\n")).toContain("untrusted");
    selector.handleInput?.("\u001b[A"); selector.handleInput?.("\r");
    const selection = h.done.mock.lastCall![0]!;
    expect(selection.updates).toEqual([{ path: h.root, decision: true }, { path: h.cwd, decision: null }]);
    saveProjectTrust(h.agentDir, selection);
    expect(JSON.parse(await readFile(h.file, "utf8"))).toEqual({ [h.root]: true, unrelated: false });
    expect(h.open().render(120).join("\n")).toContain("inherited from");
  });

  it("surfaces corrupt/read and write failures without claiming a save", async () => {
    const h = await fixture();
    await writeFile(h.file, "invalid"); expect(h.open).toThrow("Failed to read trust store");
    await rm(h.file); await mkdir(h.file);
    expect(() => saveProjectTrust(h.agentDir, { trusted: true, updates: [{ path: h.cwd, decision: true }] })).toThrow();
  });

  it("saved decisions take effect on a fresh runtime, not the current runtime or reload", async () => {
    const h = await fixture();
    await mkdir(join(h.cwd, ".pi")); await writeFile(join(h.cwd, ".pi", "settings.json"), JSON.stringify({ editorPaddingX: 3 }));
    await writeFile(join(h.agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always", editorPaddingX: 1 }));
    const options = { cwd: h.cwd, agentDir: h.agentDir, noTools: "all" as const };
    const first = await createPiAgentSession(options);
    try {
      expect(first.services.settingsManager.isProjectTrusted()).toBe(true);
      expect(first.services.settingsManager.getEditorPaddingX()).toBe(3);
      saveProjectTrust(h.agentDir, { trusted: false, updates: [{ path: h.cwd, decision: false }] });
      expect(first.services.settingsManager.isProjectTrusted()).toBe(true);
      await first.session.reload();
      expect(first.services.settingsManager.isProjectTrusted()).toBe(true);
      const second = await createPiAgentSession(options);
      try {
        expect(second.services.settingsManager.isProjectTrusted()).toBe(false);
        expect(second.services.settingsManager.getEditorPaddingX()).toBe(1);
      } finally { second.dispose(); }
    } finally { first.dispose(); }
  });
});
