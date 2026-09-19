import assert from "node:assert/strict";
import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createPiAgentSession } from "../../packages/agent-pi/dist/index.js";
import { selectLiveModels } from "../../scripts/live-model-selection.mjs";
import { until } from "../e2e/real-process-harness.mjs";

const after = "CONFIG_AFTER: Use the write tool to write exactly config-restored to config-result.txt. Finish briefly.";
const modelOf = session => ({ provider: session.model.provider, id: session.model.id });
async function assertFileModel(file, model) {
  const entries = (await readFile(file, "utf8")).trim().split("\n").map(JSON.parse);
  const last = entries.findLast(e => e.type === "message" && e.message?.role === "assistant").message;
  if (last.stopReason === "error") throw new Error(last.errorMessage ?? "native provider response failed");
  assert.equal(last.stopReason, "stop");
  assert.equal(last.model, model.id);
  assert.equal(last.provider, model.provider);
}
export async function installModelErrorExtension(agentDir) {
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await writeFile(join(agentDir, "extensions", "model-error.js"), `
import { existsSync } from "node:fs";
import { join } from "node:path";
export default function(pi) {
  pi.on("model_select", () => {
    if (existsSync(join(${JSON.stringify(agentDir)}, "arm-model-error"))) throw new Error("synthetic model-select failure");
  });
}
`);
}

export async function runLiveDefaults(h, record, setPhase) {
  const { ordinary, thinking, distinct } = selectLiveModels(process.env);
  const nativeDir = join(h.root, "native-defaults-agent");
  await cp(h.env.PI_REMOTE_PI_DIR, nativeDir, { recursive: true });
  await installModelErrorExtension(nativeDir);
  const handles = [];
  const makeNative = async name => {
    const cwd = join(h.root, name);
    await mkdir(cwd);
    const handle = await createPiAgentSession({ cwd, agentDir: nativeDir, sessionDir: join(h.root, "native-defaults-sessions") });
    handles.push(handle);
    return handle;
  };
  h.nativeCleanup = () => { for (const handle of handles) { void handle.session.abort().catch(() => {}); handle.dispose(); } };
  let level;
  let sessionLevel;
  let hookObserved = false;
  try {
    setPhase("defaults-native-persist");
    const native = await makeNative("native-defaults-primary");
    const neighbor = await makeNative("native-defaults-neighbor");
    await neighbor.session.setModel(neighbor.services.modelRuntime.getModel(ordinary.provider, ordinary.id), { persist: false });
    neighbor.session.setThinkingLevel("off", { persist: false });
    await native.session.setModel(native.services.modelRuntime.getModel(thinking.provider, thinking.id), { persist: true });
    native.session.setThinkingLevel("low", { persist: true });
    await native.services.settingsManager.flush();
    level = native.session.thinkingLevel;
    const defaults = JSON.parse(await readFile(join(nativeDir, "settings.json"), "utf8"));
    assert.equal(defaults.defaultModel, thinking.id);
    assert.equal(defaults.defaultProvider, thinking.provider);
    assert.equal(defaults.defaultThinkingLevel, level);
    assert.deepEqual(modelOf(neighbor.session), ordinary);
    assert.equal(neighbor.session.thinkingLevel, "off");
    setPhase("defaults-native-inherit");
    const fresh = await makeNative("native-defaults-fresh");
    assert.deepEqual(modelOf(fresh.session), thinking);
    assert.equal(fresh.session.thinkingLevel, level);
    native.session.setThinkingLevel("medium", { persist: false });
    sessionLevel = native.session.thinkingLevel;
    assert.notEqual(sessionLevel, level, "empty recovery must differ from saved defaults");
    setPhase("defaults-native-fresh-prompt");
    await fresh.session.prompt(after);
    await assertFileModel(fresh.sessionManager.getSessionFile(), thinking);
    assert.equal((await readFile(join(h.root, "native-defaults-fresh", "config-result.txt"), "utf8")).trim(), "config-restored");
    setPhase("defaults-native-neighbor-prompt");
    await neighbor.session.prompt(after);
    await assertFileModel(neighbor.sessionManager.getSessionFile(), ordinary);
    assert.equal((await readFile(join(h.root, "native-defaults-neighbor", "config-result.txt"), "utf8")).trim(), "config-restored");
    if (distinct) {
      setPhase("defaults-native-hook-error");
      const errors = [];
      await native.bindExtensions({ mode: "rpc", onError: error => errors.push(error) });
      await writeFile(join(nativeDir, "arm-model-error"), "armed");
      await native.session.setModel(native.services.modelRuntime.getModel(ordinary.provider, ordinary.id), { persist: false });
      assert.deepEqual(modelOf(native.session), ordinary);
      assert.ok(errors.some(error => error.event === "model_select" && error.error.includes("synthetic model-select failure")));
      hookObserved = true;
    }
  } finally { for (const handle of handles) { await handle.session.abort(); handle.dispose(); } h.nativeCleanup = undefined; }

  setPhase("defaults-backend-persist");
  const primaryId = h.sessionId;
  const projectId = h.query("SELECT project_id FROM sessions WHERE id = ?", primaryId)[0].project_id;
  const neighbor = (await h.http("POST", `/v1/projects/${projectId}/sessions`, { title: "loaded neighbor", model: ordinary, thinkingLevel: "off" })).session.id;
  await h.http("GET", `/v1/models?sessionId=${neighbor}`);
  const snapshot = id => h.http("GET", `/v1/sessions/${id}/snapshot`);
  let state = await snapshot(primaryId);
  const change = async (kind, payload) => {
    const receipt = await h.command(kind, { expectedVersion: state.session.version, ...payload });
    await h.terminal(receipt.commandId);
    state = await snapshot(primaryId);
    return receipt;
  };
  await change("set_model", { model: thinking, persist: true });
  await change("set_thinking", { level: "low", persist: true });
  const defaults = JSON.parse(await readFile(join(h.env.PI_REMOTE_PI_DIR, "settings.json"), "utf8"));
  assert.equal(defaults.defaultModel, thinking.id);
  assert.equal(defaults.defaultProvider, thinking.provider);
  assert.equal(defaults.defaultThinkingLevel, level);
  assert.deepEqual((await snapshot(neighbor)).session.model, ordinary);
  assert.equal((await snapshot(neighbor)).session.thinkingLevel, "off");
  const fresh = (await h.http("POST", `/v1/projects/${projectId}/sessions`, { title: "new default session" })).session.id;
  await h.http("GET", `/v1/models?sessionId=${fresh}`);
  assert.deepEqual((await snapshot(fresh)).session.model, thinking);
  assert.equal((await snapshot(fresh)).session.thinkingLevel, level);
  await change("set_thinking", { level: "medium" });
  assert.equal(state.session.thinkingLevel, sessionLevel);
  assert.equal(JSON.parse(await readFile(join(h.env.PI_REMOTE_PI_DIR, "settings.json"), "utf8")).defaultThinkingLevel, level);
  const mapping = h.query("SELECT pi_session_file, pi_persistence_state FROM sessions WHERE id = ?", primaryId)[0];
  assert.equal(mapping.pi_persistence_state, "unflushed");
  await assert.rejects(access(mapping.pi_session_file), { code: "ENOENT" });
  // Exercise the already-loaded neighbor before enabling collection.
  h.sessionId = neighbor;
  await h.terminal((await h.command("prompt", { text: after })).commandId);
  await assertFileModel(h.query("SELECT pi_session_file FROM sessions WHERE id = ?", neighbor)[0].pi_session_file, ordinary);
  assert.equal((await readFile(join(h.project, "config-result.txt"), "utf8")).trim(), "config-restored");
  await rm(join(h.project, "config-result.txt"));
  assert.equal((await snapshot(neighbor)).session.thinkingLevel, "off");
  h.sessionId = primaryId;
  const pids = (await readFile(`/proc/${h.main.pid}/task/${h.main.pid}/children`, "utf8")).trim().split(/\s+/).filter(Boolean);
  assert.ok(pids.length > 0);
  for (const pid of pids) h.workers.add(Number(pid));
  setPhase("defaults-backend-empty-reap");
  await writeFile(join(h.root, "state", "reap-enabled"), "enabled");
  await until(async () => {
    const current = (await readFile(`/proc/${h.main.pid}/task/${h.main.pid}/children`, "utf8")).trim().split(/\s+/);
    return pids.every(pid => !current.includes(pid));
  }, "all idle workers gracefully collected", h.timeoutMs);
  await rm(join(h.root, "state", "reap-enabled"));
  await assert.rejects(access(mapping.pi_session_file), { code: "ENOENT" });
  await h.http("GET", `/v1/models?sessionId=${primaryId}`);
  state = await snapshot(primaryId);
  assert.deepEqual(state.session.model, thinking);
  assert.equal(state.session.thinkingLevel, sessionLevel);
  const reloadedPid = await h.workerPid();
  assert.ok(!pids.includes(String(reloadedPid)));
  await h.terminal((await h.command("prompt", { text: after })).commandId);
  await assertFileModel(h.query("SELECT pi_session_file FROM sessions WHERE id = ?", primaryId)[0].pi_session_file, thinking);
  assert.equal((await readFile(join(h.project, "config-result.txt"), "utf8")).trim(), "config-restored");
  record("AUTO-CMD-persist-empty-recovery", "passed", ["persist=true settings readable at command completion; new sessions inherit defaults", "already-loaded neighbor retains its model and off level through actual prompt", "empty history file missing before and after graceful idle reap; reload retains config distinct from defaults and subsequent prompt succeeds", { distinctModels: distinct, defaultLevel: level, restoredLevel: sessionLevel }]);
  if (distinct) {
    setPhase("defaults-backend-hook-error");
    await writeFile(join(h.env.PI_REMOTE_PI_DIR, "arm-model-error"), "armed");
    state = await snapshot(primaryId);
    const receipt = await change("set_model", { model: ordinary });
    assert.deepEqual(state.session.model, ordinary);
    const notice = await until(() => h.query("SELECT operation_id, payload_json FROM events WHERE session_id = ? AND type = 'runtime.notice'", primaryId)
      .find(row => JSON.parse(row.payload_json).message.includes("synthetic model-select failure")), "model-select failure notice", h.timeoutMs);
    const operation = h.query("SELECT payload_json FROM events WHERE session_id = ? AND type = 'operation.updated'", primaryId)
      .map(row => JSON.parse(row.payload_json)).find(payload => payload.commandId === receipt.commandId);
    assert.equal(notice.operation_id, operation.operationId);
    assert.equal(hookObserved, true);
    record("AUTO-CMD-model-select-error", "passed", ["native setModel resolves with changed model and emits extension error", "backend completed command retains actual model and related operation notice, no false rollback"]);
  } else record("AUTO-CMD-model-select-error", "not_run", [], "single-model selection does not emit native model_select; two distinct models required");
}
