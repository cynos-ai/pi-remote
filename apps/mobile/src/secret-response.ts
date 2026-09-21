import type { InteractionProjection, InteractionResponse } from "@pi-remote/protocol";
import { makeIdempotencyKey, type PiRemoteApi } from "./api/client";
import type { MobileCache } from "./storage/local-cache";

/** Only request identity survives a restart. Answers never enter the offline command store. */
export async function submitSecretResponse(api: PiRemoteApi, cache: MobileCache, account: string,
  sessionId: string, interaction: InteractionProjection, response: InteractionResponse) {
  if (!interaction.sensitive) throw new Error("Expected a sensitive interaction");
  const resource = `secret-response:${sessionId}:${interaction.interactionId}`;
  const saved = await cache.getResource<{ key: string }>(account, resource);
  const key = saved?.value.key ?? makeIdempotencyKey();
  await cache.saveResource(account, resource, { key });
  try {
    return await api.submitCommandWithRetry(sessionId, { kind: "respond", payload: {
      interactionId: interaction.interactionId, operationId: interaction.operationId, response
    } }, key);
  } catch {
    // Never surface a provider/server error that might quote the submitted value.
    throw new Error("秘密回答未确认，输入已清空且未保存。请等待状态刷新；若表单仍待回答，可重新输入同一内容确认原请求，或关闭登录后重新开始。");
  }
}
