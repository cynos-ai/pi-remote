import assert from "node:assert/strict";
import { test } from "node:test";
import { selectLiveModels } from "../../scripts/live-model-selection.mjs";

const env = { PI_REMOTE_LIVE_PROVIDER: "synthetic", PI_REMOTE_LIVE_MODEL: "one",
  PI_REMOTE_LIVE_THINKING_PROVIDER: "synthetic", PI_REMOTE_LIVE_THINKING_MODEL: "one" };
test("single model requires explicit selection and cannot claim the second-model case", () => {
  assert.throws(() => selectLiveModels(env));
  const selected = selectLiveModels({ ...env, PI_REMOTE_LIVE_SINGLE_MODEL: "1" });
  assert.equal(selected.distinct, false);
  assert.equal(selected.thinkingCheckId, "AUTO-SDK-thinking-single");
});
test("different model IDs retain the full thinking requirement", () => {
  const selected = selectLiveModels({ ...env, PI_REMOTE_LIVE_THINKING_MODEL: "two" });
  assert.equal(selected.distinct, true);
  assert.equal(selected.thinkingCheckId, "AT03-thinking");
});
