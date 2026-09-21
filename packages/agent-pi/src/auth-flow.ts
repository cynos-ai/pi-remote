import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { authDisplaySchema, type AuthDisplay } from "@pi-remote/protocol";
import { saveCredential, type LoginProvider } from "./auth-selector.js";

type Interaction = Parameters<AgentSession["modelRuntime"]["login"]>[2];
type Prompt = Parameters<Interaction["prompt"]>[0];
export async function runLoginFlow(runtime: AgentSession["modelRuntime"], provider: LoginProvider, operationId: string, signal: AbortSignal,
  ask: (signal: AbortSignal, requested: (id: string) => void) => Promise<Record<string, unknown> | undefined>,
  cancel: (signal: AbortSignal) => Promise<unknown>, publish: (display: AuthDisplay | null) => void): Promise<void> {
  const controller = new AbortController();
  const flowSignal = AbortSignal.any([signal, controller.signal]);
  let closed = false;
  let display: AuthDisplay = { operationId, title: provider.name.slice(0, 120), links: [] };
  const update = () => {
    if (closed || flowSignal.aborted) return;
    const parsed = authDisplaySchema.safeParse(display);
    if (!parsed.success || Buffer.byteLength(JSON.stringify(display)) > 512 * 1024) throw new Error("Authentication display exceeds supported limits");
    publish(parsed.data);
  };
  const clear = () => publish(null);
  flowSignal.addEventListener("abort", clear, { once: true });
  try {
    flowSignal.throwIfAborted(); update();
    void cancel(flowSignal).then(() => controller.abort()).catch(() => controller.abort());
    await saveCredential(runtime, provider.id, provider.authType, {
      signal: flowSignal,
      notify: event => {
        if (closed || flowSignal.aborted) return;
        if (event.type === "auth_url") display = { ...display, message: event.instructions, links: [{ url: event.url, label: "打开授权页面" }] };
        else if (event.type === "device_code") display = { ...display, userCode: event.userCode, links: [{ url: event.verificationUri, label: "打开设备授权页面" }] };
        else display = { ...display, message: event.message, ...(event.type === "info" && event.links ? { links: event.links.map(link => ({ url: link.url, label: link.label ?? "打开链接" })) } : {}) };
        update();
      },
      prompt: async (prompt: Prompt) => {
        const promptSignal = prompt.signal ? AbortSignal.any([flowSignal, prompt.signal]) : flowSignal;
        promptSignal.throwIfAborted();
        try {
          const response = await ask(promptSignal, interactionId => {
            display = { ...display, prompt: { interactionId, message: prompt.message,
              ...(prompt.type === "select" ? { options: prompt.options.map(({ id, label }) => ({ id, label })) } : {}) } };
            update();
          });
          promptSignal.throwIfAborted();
          if (typeof response?.value !== "string") { controller.abort(); throw new Error("Login cancelled"); }
          if (prompt.type === "select" && !prompt.options.some(option => option.id === response.value)) throw new Error("Invalid authentication selection");
          return response.value;
        } finally { delete display.prompt; update(); }
      }
    });
  } finally {
    closed = true; controller.abort(); flowSignal.removeEventListener("abort", clear); clear();
  }
}
