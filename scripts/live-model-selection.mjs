// A single-model smoke is useful evidence, but cannot satisfy the existing
// two-model AT03 acceptance requirement by running the same model twice.
export function selectLiveModels(env) {
  const ordinary = { provider: env.PI_REMOTE_LIVE_PROVIDER, id: env.PI_REMOTE_LIVE_MODEL };
  const thinking = { provider: env.PI_REMOTE_LIVE_THINKING_PROVIDER, id: env.PI_REMOTE_LIVE_THINKING_MODEL };
  const distinct = ordinary.provider !== thinking.provider || ordinary.id !== thinking.id;
  if (!distinct && env.PI_REMOTE_LIVE_SINGLE_MODEL !== "1") throw new Error("two distinct models required unless single-model smoke is explicitly selected");
  return { ordinary, thinking, distinct,
    thinkingCheckId: distinct ? "AT03-thinking" : "AUTO-SDK-thinking-single" };
}
