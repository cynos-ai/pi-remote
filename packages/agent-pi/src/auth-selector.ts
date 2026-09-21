import { CredentialSynchronizationError, type AgentSession, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { initializeNativeMenu } from "./model-selector.js";

type Runtime = AgentSession["modelRuntime"];
export type LogoutProvider = { id: string; name: string; authType: "oauth" | "api_key";
  status: { type: "oauth" | "api_key"; source: string } };
const native = await import(new URL("./modes/interactive/components/oauth-selector.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href) as {
  OAuthSelectorComponent: new (mode: "logout", providers: LogoutProvider[],
    select: (id: string) => void, cancel: () => void) => Component & { focused: boolean };
};
const operationSignal = (signal: AbortSignal) => AbortSignal.any([signal, AbortSignal.timeout(15_000)]);

export async function listLogoutProviders(runtime: Runtime, signal: AbortSignal): Promise<LogoutProvider[]> {
  try {
    const stored = await runtime.listCredentials({ signal: operationSignal(signal) });
    return stored.map(({ providerId, type }) => ({ id: providerId, name: runtime.getProvider(providerId)?.name ?? providerId,
      authType: type, status: { type, source: "stored credential" } })).sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    // Credential parser/provider exceptions may contain credential material.
    throw new Error("无法读取已保存凭据，请检查服务端鉴权存储；未执行退出登录");
  }
}

export function createLogoutSelector(keys: KeybindingsManager, providers: LogoutProvider[], done: (provider?: LogoutProvider) => void): Component & { focused: boolean } {
  initializeNativeMenu(keys);
  return new native.OAuthSelectorComponent("logout", providers, id => done(providers.find(provider => provider.id === id)), () => done());
}

export async function removeStoredCredential(runtime: Runtime, providerId: string, signal: AbortSignal): Promise<void> {
  try { await runtime.logout(providerId, { signal: operationSignal(signal) }); }
  catch (error) {
    // eslint-disable-next-line preserve-caught-error -- SDK causes may contain credentials; public errors must not retain them.
    if (error instanceof CredentialSynchronizationError) throw new Error("凭据已移除，但本地模型状态未能同步；请重新加载模型状态，不要把此结果视为删除失败");
    // eslint-disable-next-line preserve-caught-error -- Credential/provider error causes are intentionally excluded from remote diagnostics.
    throw new Error("退出登录未完成，请检查服务端鉴权存储或重试；未确认凭据已移除");
  }
}
