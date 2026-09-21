import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createLogoutSelector, listLogoutProviders, removeStoredCredential, saveApiKey, createLoginSelector, listApiKeyProviders } from "../../packages/agent-pi/src/auth-selector.js";
import { createPiAgentSession } from "../../packages/agent-pi/src/runtime.js";

type Runtime = Parameters<typeof listLogoutProviders>[0];
let KeybindingsManager: new () => Parameters<typeof createLogoutSelector>[0];
let CredentialSynchronizationError: new (id: string, operation: "login" | "logout", credential: unknown, options: ErrorOptions) => Error;
beforeAll(async () => {
  ({ KeybindingsManager } = await import(pathToFileURL(resolve("packages/agent-pi/node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js")).href));
  ({ CredentialSynchronizationError } = await import(pathToFileURL(resolve("packages/agent-pi/node_modules/@earendil-works/pi-coding-agent/dist/core/model-runtime.js")).href));
});
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const signal = () => new AbortController().signal;

describe("native stored credential logout", () => {
  it("offers native API key providers including ambient auth and supports search/cancel", () => {
    const runtime = { getProviders: () => [
      { id: "oauth-only", name: "OAuth", auth: { oauth: {} } },
      { id: "key", name: "Key", auth: { apiKey: { login: () => undefined } } },
      { id: "ambient", name: "Ambient", auth: { apiKey: {} } }
    ] } as unknown as Runtime;
    const providers = listApiKeyProviders(runtime);
    expect(providers.map(p => [p.id, p.interactive])).toEqual([["ambient", false], ["key", true]]);
    const done = vi.fn();
    const menu = createLoginSelector(new KeybindingsManager(), providers, done);
    menu.handleInput?.("key"); menu.handleInput?.("\r");
    expect(done).toHaveBeenLastCalledWith(providers[1]);
    createLoginSelector(new KeybindingsManager(), providers, done).handleInput?.("\u001b");
    expect(done).toHaveBeenLastCalledWith();
  });
  it("does not expose login credentials or provider failures in public errors", async () => {
    const sentinel = "synthetic-login-exception-secret";
    const runtime = { login: vi.fn().mockRejectedValue(new Error(sentinel)) } as unknown as Runtime;
    try {
      await saveApiKey(runtime, "test", { signal: signal(), prompt: async () => sentinel, notify: () => undefined });
      throw new Error("expected failure");
    } catch (error) {
      expect(String(error)).toContain("未确认凭据已保存");
      expect(String(error)).not.toContain(sentinel);
      expect(error).not.toHaveProperty("cause");
      expect(error).not.toHaveProperty("credential");
    }
    vi.mocked(runtime.login).mockRejectedValue(new CredentialSynchronizationError("test", "login", { type: "api_key", key: sentinel }, { cause: new Error(sentinel) }));
    try {
      await saveApiKey(runtime, "test", { signal: signal(), prompt: async () => sentinel, notify: () => undefined });
      throw new Error("expected synchronization failure");
    } catch (error) {
      expect(String(error)).toContain("API key 已保存");
      expect(String(error)).not.toContain(sentinel);
      expect(error).not.toHaveProperty("cause");
      expect(error).not.toHaveProperty("credential");
    }
  });
  it("lists metadata only, sorts native names and preserves search/cancel semantics", async () => {
    const runtime = { listCredentials: vi.fn().mockResolvedValue([{ providerId: "z", type: "oauth" }, { providerId: "unknown", type: "api_key" }]),
      getProvider: (id: string) => id === "z" ? { name: "Alpha" } : undefined } as unknown as Runtime;
    const providers = await listLogoutProviders(runtime, signal());
    expect(providers.map(p => p.name)).toEqual(["Alpha", "unknown"]);
    const done = vi.fn();
    const menu = createLogoutSelector(new KeybindingsManager(), providers, done);
    menu.handleInput?.("unknown"); menu.handleInput?.("\r");
    expect(done).toHaveBeenLastCalledWith(providers[1]);
    createLogoutSelector(new KeybindingsManager(), providers, done).handleInput?.("\u001b");
    expect(done).toHaveBeenLastCalledWith();
  });

  it("removes a real stored key, refreshes availability and leaves models config intact", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-logout-")); roots.push(cwd);
    const agentDir = join(cwd, "agent"); await mkdir(agentDir);
    const auth = join(agentDir, "auth.json"), models = join(agentDir, "models.json");
    await writeFile(auth, JSON.stringify({ "test-saved": { type: "api_key", key: "synthetic-unit-credential" }, keep: { type: "api_key", key: "synthetic-keep" } }));
    const config = JSON.stringify({ providers: { "test-saved": { baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", models: [{ id: "test", contextWindow: 32000, maxTokens: 1024 }] } } });
    await writeFile(models, config);
    const handle = await createPiAgentSession({ cwd, agentDir, noTools: "all" });
    try {
      const runtime = handle.session.modelRuntime;
      expect((await listLogoutProviders(runtime, signal())).map(p => p.id)).toContain("test-saved");
      expect(runtime.getAvailableSnapshot().some(m => m.provider === "test-saved")).toBe(true);
      await removeStoredCredential(runtime, "test-saved", signal());
      expect(JSON.parse(await readFile(auth, "utf8"))).toEqual({ keep: { type: "api_key", key: "synthetic-keep" } });
      expect(runtime.getAvailableSnapshot().some(m => m.provider === "test-saved")).toBe(false);
      expect(await readFile(models, "utf8")).toBe(config);
    } finally { handle.dispose(); }
  });

  it("reports removal versus synchronization failures without exposing original errors", async () => {
    const leaked = "synthetic-secret-must-not-leak";
    const runtime = { logout: vi.fn().mockRejectedValue(new Error(leaked)), listCredentials: vi.fn().mockRejectedValue(new Error(leaked)) } as unknown as Runtime;
    await expect(removeStoredCredential(runtime, "test", signal())).rejects.toThrow("未确认凭据已移除");
    await expect(listLogoutProviders(runtime, signal())).rejects.toThrow("无法读取已保存凭据");
    vi.mocked(runtime.logout).mockRejectedValue(new CredentialSynchronizationError("test", "logout", undefined, { cause: new Error(leaked) }));
    try { await removeStoredCredential(runtime, "test", signal()); throw new Error("expected error"); }
    catch (error) {
      expect(String(error)).toContain("凭据已移除"); expect(String(error)).not.toContain(leaked);
      expect(error).not.toHaveProperty("cause"); expect(error).not.toHaveProperty("credential");
    }
  });

  it("passes editor cancellation into credential operations", async () => {
    const controller = new AbortController(); controller.abort();
    const runtime = { logout: vi.fn(async (_id: string, options: { signal: AbortSignal }) => { options.signal.throwIfAborted(); }) } as unknown as Runtime;
    await expect(removeStoredCredential(runtime, "test", controller.signal)).rejects.toThrow("退出登录未完成");
    expect(vi.mocked(runtime.logout).mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
});
