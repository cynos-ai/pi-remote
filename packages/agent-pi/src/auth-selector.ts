import { CredentialSynchronizationError, type AgentSession, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { initializeNativeMenu } from "./model-selector.js";

type Runtime = AgentSession["modelRuntime"];
export type LogoutProvider = { id: string; name: string; authType: "oauth" | "api_key";
  status: { type: "oauth" | "api_key"; source: string } };
const native = await import(new URL("./modes/interactive/components/oauth-selector.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href) as {
  OAuthSelectorComponent: new (mode: "logout" | "login", providers: Array<{ id: string; name: string; authType: "oauth" | "api_key"; status?: { type: "oauth" | "api_key"; source: string } }>,
    select: (id: string) => void, cancel: () => void) => Component & { focused: boolean };
};
const operationSignal = (signal: AbortSignal) => AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
const modelDefaults = await import(new URL("./core/model-resolver.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href) as {
  defaultModelPerProvider: Record<string, string | undefined>;
};

export async function selectDefaultAfterLogin(session: AgentSession, providerId: string, previousModel: AgentSession["model"]): Promise<string | undefined> {
  if (!previousModel || previousModel.provider !== "unknown" || previousModel.id !== "unknown" || previousModel.api !== "unknown") return;
  const defaultId = modelDefaults.defaultModelPerProvider[providerId];
  const model = session.modelRuntime.getAvailableSnapshot().find(m => m.provider === providerId && m.id === defaultId);
  if (!model) return "凭据已保存；该 provider 的默认模型不可用，请通过 /model 选择模型";
  try { await session.setModel(model, { persist: true }); }
  catch { return "凭据已保存，但选择默认模型失败；请通过 /model 选择模型"; }
}

export async function refreshLoginCatalog(runtime: Runtime, id: string, signal: AbortSignal): Promise<boolean> {
  try {
    const result = await runtime.refresh({ providers: [id], signal: operationSignal(signal) });
    return !result.aborted && result.errors.size === 0;
  } catch { return false; }
}

export type ApiKeyProvider = { id: string; name: string; authType: "api_key"; interactive: boolean };
export type LoginProvider = Omit<ApiKeyProvider, "authType"> & { authType: "api_key" | "oauth" };
export function listLoginProviders(runtime: Runtime, authType: LoginProvider["authType"]): LoginProvider[] {
  if (authType === "api_key") return listApiKeyProviders(runtime);
  return runtime.getProviders().filter(p => p.auth.oauth).map(p => ({ id: p.id, name: p.name, authType, interactive: true })).sort((a, b) => a.name.localeCompare(b.name));
}
export function listApiKeyProviders(runtime: Runtime): ApiKeyProvider[] {
  return runtime.getProviders().filter(p => p.auth.apiKey).map(p => ({ id: p.id, name: p.name,
    authType: "api_key" as const, interactive: !!p.auth.apiKey?.login })).sort((a, b) => a.name.localeCompare(b.name));
}
export function createLoginSelector(keys: KeybindingsManager, providers: LoginProvider[], done: (provider?: LoginProvider) => void) {
  initializeNativeMenu(keys);
  return new native.OAuthSelectorComponent("login", providers, id => done(providers.find(p => p.id === id)), () => done());
}
export async function saveApiKey(runtime: Runtime, id: string, interaction: Parameters<Runtime["login"]>[2]): Promise<void> {
  return saveCredential(runtime, id, "api_key", interaction);
}
export async function saveCredential(runtime: Runtime, id: string, method: LoginProvider["authType"], interaction: Parameters<Runtime["login"]>[2]): Promise<void> {
  const label = method === "api_key" ? "API key" : "OAuth";
  try { await runtime.login(id, method, interaction); }
  catch (error) {
    // eslint-disable-next-line preserve-caught-error -- Credential-bearing causes must never cross the remote boundary.
    if (error instanceof CredentialSynchronizationError) throw new Error(`${label} 已保存，但本地模型状态同步失败；请重新加载模型状态，不要重复登录`);
    // eslint-disable-next-line preserve-caught-error -- Provider errors may quote the secret answer.
    throw new Error(`${label} 登录未完成或已取消；未确认凭据已保存`);
  }
}

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
