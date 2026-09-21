import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPiAgentRuntime, type PiAgentSessionOptions } from "../../packages/agent-pi/src/runtime.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function setup(defaultTrust: "ask" | "always" | "never" = "ask") {
  const root = await mkdtemp(join(tmpdir(), "pi-bootstrap-trust-")); roots.push(root);
  const cwd = join(root, "project"), agentDir = join(root, "agent");
  await mkdir(join(cwd, ".pi", "extensions"), { recursive: true }); await mkdir(join(agentDir, "extensions"), { recursive: true });
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: defaultTrust, editorPaddingX: 1 }));
  await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify({ editorPaddingX: 3 }));
  const marker = join(root, "project-loaded");
  await writeFile(join(cwd, ".pi", "extensions", "project.js"), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'loaded'); export default function() {}`);
  const select = vi.fn<() => Promise<string | undefined>>().mockResolvedValue(undefined);
  const confirm = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
  const input = vi.fn<() => Promise<string | undefined>>().mockResolvedValue("answer");
  const notify = vi.fn(), warning = vi.fn();
  const options: PiAgentSessionOptions = { cwd, agentDir, noTools: "all", projectTrustContextFactory: cwd => ({ cwd, mode: "rpc", hasUI: true,
    ui: { select, confirm, input, notify } }), onProjectTrustError: warning };
  return { root, cwd, agentDir, marker, select, confirm, input, notify, warning, options,
    trustFile: join(agentDir, "trust.json"), hook: (source: string) => writeFile(join(agentDir, "extensions", "trust.js"), source) };
}

describe("native trust bootstrap", () => {
  for (const value of ["always", "never"] as const) it(`uses global ${value} fallback before loading project resources`, async () => {
    const h = await setup(value); const handle = await createPiAgentRuntime(h.options);
    try {
      expect(handle.runtime.services.settingsManager.isProjectTrusted()).toBe(value === "always");
      expect(handle.runtime.services.settingsManager.getEditorPaddingX()).toBe(value === "always" ? 3 : 1);
      expect(h.select).not.toHaveBeenCalled();
      if (value === "always") expect(await readFile(h.marker, "utf8")).toBe("loaded");
      else await expect(readFile(h.marker)).rejects.toThrow();
    } finally { await handle.dispose(); }
  });

  it("waits before loading project code and caches a session-only answer across native replacement", async () => {
    const h = await setup(); let answer!: (value: string) => void;
    h.select.mockImplementation(() => new Promise(resolve => { answer = resolve; }));
    const pending = createPiAgentRuntime(h.options);
    await vi.waitFor(() => expect(h.select).toHaveBeenCalledOnce());
    await expect(readFile(h.marker)).rejects.toThrow();
    answer("Trust (this session only)"); const handle = await pending;
    try {
      expect(await readFile(h.marker, "utf8")).toBe("loaded");
      await expect(readFile(h.trustFile)).rejects.toThrow();
      await handle.runtime.newSession(); await handle.runtime.session.reload();
      expect(h.select).toHaveBeenCalledOnce();
      expect(handle.runtime.services.settingsManager.isProjectTrusted()).toBe(true);
    } finally { await handle.dispose(); }
  });

  it("cancellation preserves no stored decision and skips project resources", async () => {
    const h = await setup(); const handle = await createPiAgentRuntime(h.options);
    try {
      expect(handle.runtime.services.settingsManager.isProjectTrusted()).toBe(false);
      await expect(readFile(h.marker)).rejects.toThrow(); await expect(readFile(h.trustFile)).rejects.toThrow();
    } finally { await handle.dispose(); }
  });

  it("runs global trust hooks before stored/default decisions and remembers the returned result", async () => {
    const h = await setup("never"); await writeFile(h.trustFile, JSON.stringify({ [h.cwd]: false }));
    await h.hook(`export default function(pi) { pi.on('project_trust', async (_event, ctx) => {
      const ok = await ctx.ui.confirm('Hook trust', 'Allow?'); await ctx.ui.input('Hook input'); ctx.ui.notify('Hook evaluated');
      return { trusted: ok ? 'yes' : 'no', remember: true };
    }); }`);
    const handle = await createPiAgentRuntime(h.options);
    try {
      expect(h.confirm).toHaveBeenCalledOnce(); expect(h.input).toHaveBeenCalledOnce(); expect(h.notify).toHaveBeenCalledWith("Hook evaluated");
      expect(h.select).not.toHaveBeenCalled(); expect(JSON.parse(await readFile(h.trustFile, "utf8"))[h.cwd]).toBe(true);
      expect(await readFile(h.marker, "utf8")).toBe("loaded");
    } finally { await handle.dispose(); }
  });

  it("reports hook errors and follows native undecided/default fallback", async () => {
    const h = await setup("never");
    await h.hook(`export default function(pi) { pi.on('project_trust', () => { throw new Error('trust-hook-test'); }); pi.on('project_trust', () => ({ trusted: 'undecided' })); }`);
    const handle = await createPiAgentRuntime(h.options);
    try {
      expect(h.warning).toHaveBeenCalledWith(expect.stringContaining("trust-hook-test"));
      expect(handle.runtime.services.settingsManager.isProjectTrusted()).toBe(false); expect(h.select).not.toHaveBeenCalled();
      await expect(readFile(h.marker)).rejects.toThrow();
    } finally { await handle.dispose(); }
  });

  it("stored decisions precede defaults and storage errors are not silently accepted", async () => {
    const h = await setup("always"); await writeFile(h.trustFile, JSON.stringify({ [h.cwd]: false }));
    const handle = await createPiAgentRuntime(h.options);
    try { expect(handle.runtime.services.settingsManager.isProjectTrusted()).toBe(false); expect(h.select).not.toHaveBeenCalled(); }
    finally { await handle.dispose(); }
    await writeFile(h.trustFile, "broken"); await expect(createPiAgentRuntime(h.options)).rejects.toThrow("Failed to read trust store");
  });
});
