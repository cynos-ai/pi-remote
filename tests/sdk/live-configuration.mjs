import assert from "node:assert/strict";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createPiAgentSession } from "../../packages/agent-pi/dist/index.js";
import { selectLiveModels } from "../../scripts/live-model-selection.mjs";
import { until } from "../e2e/real-process-harness.mjs";

const prompt = "CONFIG_GATE: Use the bash tool to run exactly bash config-gate.sh. The controller will stop it. Do not edit or bypass the script. Finish briefly.";
const after = "CONFIG_AFTER: Use the write tool to write exactly config-restored to config-result.txt. Finish briefly.";
async function prepare(project) {
  await mkdir(project, { recursive: true });
  await writeFile(join(project, "config-gate.sh"), "#!/bin/bash\nprintf entered > config-entered\nfor i in $(seq 1 1200); do sleep 0.1; done\nexit 1\n");
}
async function waitGate(project, timeout) {
  await until(async () => {
    try { return (await readFile(join(project, "config-entered"), "utf8")) === "entered"; }
    catch (error) { if (error.code === "ENOENT") return false; throw error; }
  }, "configuration Bash gate", timeout);
}
const modelOf = session => ({ provider: session.model.provider, id: session.model.id });
const history = async path => (await readFile(path, "utf8")).trim().split("\n").map(JSON.parse);
function assertLastModel(entries, model) {
  const message = entries.findLast(e => e.type === "message" && e.message?.role === "assistant").message;
  assert.equal(message.stopReason, "stop");
  assert.equal(message.model, model.id);
  assert.equal(message.provider, model.provider);
}

export async function runLiveConfiguration(h, record, setPhase) {
  const { ordinary, thinking, distinct } = selectLiveModels(process.env);
  const nativeProject = join(h.root, "native-config-project");
  await prepare(nativeProject);
  await prepare(h.project);
  const nativeDir = join(h.root, "native-config-agent");
  await cp(h.env.PI_REMOTE_PI_DIR, nativeDir, { recursive: true });
  const defaults = await readFile(join(h.env.PI_REMOTE_PI_DIR, "settings.json"), "utf8");
  let native = await createPiAgentSession({ cwd: nativeProject, agentDir: nativeDir, sessionDir: join(h.root, "native-config-sessions") });
  h.nativeCleanup = () => { void native.session.abort().catch(() => {}); native.dispose(); };
  let clamped;
  let level;
  try {
    await native.session.setModel(native.services.modelRuntime.getModel(ordinary.provider, ordinary.id), { persist: false });
    setPhase("configuration-native-gate");
    const active = native.session.prompt(prompt);
    void active.catch(() => {});
    await waitGate(nativeProject, h.timeoutMs);
    assert.equal(native.session.isStreaming, true);
    native.session.setThinkingLevel("xhigh", { persist: false });
    clamped = native.session.thinkingLevel;
    await native.session.setModel(native.services.modelRuntime.getModel(thinking.provider, thinking.id), { persist: false });
    native.session.setThinkingLevel("low", { persist: false });
    level = native.session.thinkingLevel;
    assert.equal(native.session.isStreaming, true);
    assert.deepEqual(modelOf(native.session), thinking);
    await native.session.abort();
    await active;
    const sessionFile = native.sessionManager.getSessionFile();
    native.dispose();
    setPhase("configuration-native-reopen");
    native = await createPiAgentSession({ cwd: nativeProject, agentDir: nativeDir, sessionFile, persistenceState: "persisted" });
    assert.deepEqual(modelOf(native.session), thinking);
    assert.equal(native.session.thinkingLevel, level);
    await native.session.prompt(after);
    assertLastModel(native.sessionManager.getEntries(), thinking);
    assert.equal((await readFile(join(nativeProject, "config-result.txt"), "utf8")).trim(), "config-restored");
    assert.ok((await readFile(join(nativeDir, "settings.json"), "utf8")) === defaults, "nonpersisted native changes must not replace defaults");
  } finally { await native.session.abort(); native.dispose(); h.nativeCleanup = undefined; }

  setPhase("configuration-backend-gate");
  const active = await h.command("prompt", { text: prompt });
  await h.workerPid();
  await waitGate(h.project, h.timeoutMs);
  const snapshot = () => h.http("GET", `/v1/sessions/${h.sessionId}/snapshot`);
  let state = await snapshot();
  const update = async (kind, payload) => {
    const receipt = await h.command(kind, { expectedVersion: state.session.version, ...payload });
    await h.terminal(receipt.commandId);
    assert.equal(h.query("SELECT status FROM runs WHERE id = ?", active.runId)[0].status, "running", "configuration must finish while the tool is still running");
    state = await snapshot();
  };
  await update("set_thinking", { level: "xhigh" });
  assert.equal(state.session.thinkingLevel, clamped);
  await update("set_model", { model: thinking });
  await update("set_thinking", { level: "low" });
  assert.deepEqual(state.session.model, thinking);
  assert.equal(state.session.thinkingLevel, level);
  await h.terminal((await h.command("abort", { targetRunId: active.runId })).commandId);
  await h.terminal(active.commandId, "cancelled");
  const file = h.query("SELECT pi_session_file FROM sessions WHERE id = ?", h.sessionId)[0].pi_session_file;
  setPhase("configuration-backend-restart");
  await h.killMain();
  await h.start();
  state = await snapshot();
  assert.deepEqual(state.session.model, thinking);
  assert.equal(state.session.thinkingLevel, level);
  await h.terminal((await h.command("prompt", { text: after })).commandId);
  assertLastModel(await history(file), thinking);
  assert.equal((await readFile(join(h.project, "config-result.txt"), "utf8")).trim(), "config-restored");
  assert.ok((await readFile(join(h.env.PI_REMOTE_PI_DIR, "settings.json"), "utf8")) === defaults, "nonpersisted backend changes must not replace defaults");
  record("AUTO-CMD-active-config-recovery", "passed", ["native/backend configuration completes during an active Bash tool", "native thinking clamp compared; session model/level survive native reopen and backend SIGKILL/restart", "subsequent actual assistant model and written file verified; defaults unchanged", { distinctModels: distinct, requestedLevel: "xhigh", clampedLevel: clamped, restoredLevel: level }, "single-model reselection does not prove two-model switching; not token-stream timing, persist=true or model_select error coverage"]);
}
