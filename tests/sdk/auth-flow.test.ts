import { expect, it, vi } from "vitest";
import { runLoginFlow } from "../../packages/agent-pi/src/auth-flow.js";
import type { AuthDisplay } from "../../packages/protocol/src/index.js";

type Runtime = Parameters<typeof runLoginFlow>[0];
type Interaction = Parameters<Runtime["login"]>[2];
const provider = { id: "test-oauth", name: "Test OAuth", authType: "oauth" as const, interactive: true };
const holdCancel = (signal: AbortSignal) => new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));

it("clears transient prompts after provider cancellation and suppresses late notifications", async () => {
  let interaction!: Interaction;
  const runtime = { login: async (_id: string, _method: string, input: Interaction) => {
    interaction = input;
    input.notify({ type: "auth_url", url: "https://example.test/?private=state" });
    const controller = new AbortController();
    const pending = input.prompt({ type: "manual_code", message: "Private callback hint", signal: controller.signal });
    controller.abort();
    await pending;
  } } as unknown as Runtime;
  const publish = vi.fn<(view: AuthDisplay | null) => void>();
  await expect(runLoginFlow(runtime, provider, "op", new AbortController().signal,
    (signal, requested) => { requested("interaction"); return new Promise(resolve => signal.addEventListener("abort", () => resolve(undefined), { once: true })); },
    holdCancel, publish)).rejects.toThrow("OAuth 登录未完成");
  expect(publish).toHaveBeenLastCalledWith(null);
  const count = publish.mock.calls.length;
  interaction.notify({ type: "progress", message: "late-secret" });
  expect(publish).toHaveBeenCalledTimes(count);
});

it("rejects non-web auth links without returning their content in an error", async () => {
  const runtime = { login: async (_id: string, _method: string, input: Interaction) => input.notify({ type: "auth_url", url: "javascript:private-secret" }) } as unknown as Runtime;
  const publish = vi.fn();
  await expect(runLoginFlow(runtime, provider, "op", new AbortController().signal, async () => undefined, holdCancel, publish)).rejects.toThrow("未确认凭据已保存");
  expect(JSON.stringify(publish.mock.calls)).not.toContain("javascript");
  expect(publish).toHaveBeenLastCalledWith(null);
});
