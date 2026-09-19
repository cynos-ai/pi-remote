import assert from "node:assert/strict";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { until } from "../e2e/real-process-harness.mjs";
import { createPiAgentSession } from "../../packages/agent-pi/dist/index.js";

const marker = "pi-compact-marker";
const seed = `COMPACT_SEED: Remember the project marker ${marker}. Reply briefly.\n${"Synthetic project context, preserve the marker. ".repeat(60)}`;
const gate = "COMPACT_GATE: Use the bash tool to run bash compact-gate.sh now. The controller will interrupt it externally. Do not edit or bypass the script. Finish briefly.";
const steer = "COMPACT_STEER: Remember that steering was queued. Reply briefly; do not run the gate again.";
const follow = "COMPACT_FOLLOW: Remember that follow-up was queued. Reply briefly; do not run the gate again.";
const instructions = `Preserve the exact project marker ${marker}, queued user instructions and tool outcomes. Keep the summary concise.`;
const after = "COMPACT_AFTER: Use the write tool to write only the project marker remembered from the earlier conversation to compact-result.txt. Do not read other files. Finish briefly.";
const cancelPreparation = `Remember the earlier project marker. Reply briefly without tools.\n${"Synthetic additional context for a separate retained turn. ".repeat(40)}`;

export async function prepareCompactAgent(source, directory) {
  await cp(source, directory, { recursive: true });
  let settings = {};
  try { settings = JSON.parse(await readFile(join(directory, "settings.json"), "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  await writeFile(join(directory, "settings.json"), JSON.stringify({ ...settings,
    defaultProvider: process.env.PI_REMOTE_LIVE_PROVIDER, defaultModel: process.env.PI_REMOTE_LIVE_MODEL,
    // Both sides use this small test context, never the production defaults.
    compaction: { ...settings.compaction, enabled: false, keepRecentTokens: 64, reserveTokens: 2048 }
  }));
}

export async function installCompactCancelExtension(directory) {
  await mkdir(join(directory, "extensions"), { recursive: true });
  await writeFile(join(directory, "extensions", "compact-cancel.js"), `
import { existsSync } from "node:fs";
import { join } from "node:path";
export default function (pi) {
  pi.on("session_before_compact", async (event, ctx) => {
    if (!existsSync(join(ctx.cwd, "cancel-compaction"))) return;
    await ctx.ui.confirm("Compact cancellation probe", "Wait for cancellation", { signal: event.signal });
    return { cancel: true };
  });
}
`);
}

export async function runCompactCancel(h, record, setPhase) {
  const project = join(h.root, "native-cancel-project");
  await mkdir(project);
  await writeFile(join(project, "cancel-compaction"), "probe");
  await writeFile(join(h.project, "cancel-compaction"), "probe");
  const native = await createPiAgentSession({ cwd: project, agentDir: h.env.PI_REMOTE_PI_DIR,
    sessionDir: join(h.root, "native-cancel-sessions"), resourceLoaderOptions: { noThemes: true } });
  h.nativeCleanup = () => { void native.session.abort().catch(() => {}); native.dispose(); };
  let notifyHook;
  const hookReady = new Promise(resolve => { notifyHook = resolve; });
  const endings = [];
  const unsubscribe = native.onEvent(event => { if (event.type === "compaction_end") endings.push(event); });
  try {
    await native.bindExtensions({ mode: "rpc", uiContext: {
      confirm: (_title, _message, options) => new Promise(resolve => {
        notifyHook();
        if (options.signal.aborted) resolve(false);
        else options.signal.addEventListener("abort", () => resolve(false), { once: true });
      })
    } });
    setPhase("compact-cancel-native-seed");
    await native.session.prompt(seed);
    await native.session.prompt(cancelPreparation);
    const pending = native.session.compact(instructions);
    void pending.catch(() => {});
    setPhase("compact-cancel-native-hook");
    await Promise.race([
      hookReady,
      pending.then(() => { throw new Error("native compact completed before cancellation hook"); })
    ]);
    native.session.abortCompaction();
    await assert.rejects(pending, /Compaction cancelled/);
    assert.equal(endings.length, 1);
    assert.equal(endings[0].aborted, true);
    assert.equal(native.sessionManager.getEntries().filter(e => e.type === "compaction").length, 0);
    await native.session.prompt(after);
    assert.equal((await readFile(join(project, "compact-result.txt"), "utf8")).trim(), marker);
  } finally { unsubscribe(); await native.session.abort(); native.dispose(); h.nativeCleanup = undefined; }

  setPhase("compact-cancel-backend-seed");
  await h.terminal((await h.command("prompt", { text: seed })).commandId);
  await h.terminal((await h.command("prompt", { text: cancelPreparation })).commandId);
  const before = await h.http("GET", `/v1/sessions/${h.sessionId}/snapshot`);
  const compact = await h.command("compact", { expectedVersion: before.session.version, instructions });
  setPhase("compact-cancel-backend-hook");
  await until(() => h.query("SELECT type FROM events WHERE type = 'interaction.requested'").length > 0, "backend before-compact hook", h.timeoutMs);
  await h.terminal((await h.command("abort", { targetRunId: compact.runId })).commandId);
  await h.terminal(compact.commandId, "cancelled");
  assert.equal(h.query("SELECT status FROM runs WHERE id = ?", compact.runId)[0].status, "aborted");
  const mapping = h.query("SELECT pi_session_file FROM sessions WHERE id = ?", h.sessionId)[0];
  const entries = (await readFile(mapping.pi_session_file, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(entries.filter(e => e.type === "compaction").length, 0);
  const cancelled = await h.http("GET", `/v1/sessions/${h.sessionId}/snapshot`);
  assert.deepEqual(cancelled.pendingInteractions, []);
  assert.deepEqual(cancelled.liveItems, []);
  await h.terminal((await h.command("prompt", { text: after })).commandId);
  assert.equal((await readFile(join(h.project, "compact-result.txt"), "utf8")).trim(), marker);
  record("AUTO-CMD-compact-cancel-before-summary", "passed", ["direct SDK abortCompaction and targeted backend abort during native before-compact hook", "cancelled summary not persisted; dialog closed; old context usable on both sides", "does not cover cancellation during provider summary streaming"]);
}

async function prepareProject(directory) {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "compact-gate.sh"), "#!/bin/bash\nset -eu\nprintf entered > compact-entered\nfor i in $(seq 1 1200); do sleep 0.1; done\nexit 1\n");
}
async function waitGate(directory, timeout) {
  await until(async () => {
    try { return (await readFile(join(directory, "compact-entered"), "utf8")) === "entered"; }
    catch (error) { if (error.code === "ENOENT") return false; throw error; }
  }, "compact gate entered", timeout);
}
const users = entries => entries.filter(e => e.type === "message" && e.message?.role === "user")
  .flatMap(e => ["COMPACT_SEED", "COMPACT_GATE", "COMPACT_STEER", "COMPACT_FOLLOW", "COMPACT_AFTER"].filter(m => JSON.stringify(e.message.content).includes(m)));
const assistants = entries => entries.filter(e => e.type === "message" && e.message?.role === "assistant").map(e => e.message.stopReason);

export async function runEmptyCompact(h, record) {
  const project = join(h.root, "native-empty-project");
  await mkdir(project);
  const native = await createPiAgentSession({ cwd: project, agentDir: h.env.PI_REMOTE_PI_DIR,
    sessionDir: join(h.root, "native-empty-sessions"), resourceLoaderOptions: { noThemes: true } });
  try { await assert.rejects(native.session.compact(), /Nothing to compact/); }
  finally { native.dispose(); }
  const snapshot = await h.http("GET", `/v1/sessions/${h.sessionId}/snapshot`);
  const receipt = await h.command("compact", { expectedVersion: snapshot.session.version });
  const result = await h.terminal(receipt.commandId, "failed");
  assert.equal(result.error.code, "SDK_OPERATION_FAILED");
  const failure = h.query("SELECT payload_json FROM events WHERE type = 'command.updated'")
    .map(row => JSON.parse(row.payload_json)).find(p => p.commandId === receipt.commandId && p.state === "failed");
  assert.match(failure.error.message, /Nothing to compact/);
  assert.equal(h.query("SELECT status FROM runs WHERE id = ?", receipt.runId)[0].status, "failed");
  const failed = await h.http("GET", `/v1/sessions/${h.sessionId}/snapshot`);
  assert.equal(failed.queue.state, "ready");
  assert.deepEqual(failed.liveItems, []);
  await h.terminal((await h.command("prompt", { text: seed })).commandId);
  record("compact-empty-history-regression", "passed", ["native/backend both reject empty history; new prompt remains available"]);
}

export async function runLiveCompact(h, record, setPhase, withQueuedInputs = true) {
  setPhase("compact-native-baseline");
  const project = join(h.root, "native-project");
  await prepareProject(project);
  const native = await createPiAgentSession({ cwd: project, agentDir: h.env.PI_REMOTE_PI_DIR,
    sessionDir: join(h.root, "native-sessions"), resourceLoaderOptions: { noThemes: true } });
  h.nativeCleanup = () => { void native.session.abort().catch(() => {}); native.dispose(); };
  let baseline;
  try {
    setPhase("compact-native-seed");
    await native.session.prompt(seed);
    const offset = native.sessionManager.getEntries().length;
    const active = native.session.prompt(gate);
    setPhase("compact-native-gate");
    await waitGate(project, h.timeoutMs);
    if (withQueuedInputs) {
      await native.session.steer(steer);
      await native.session.followUp(follow);
    }
    assert.equal(native.session.getSteeringMessages().length, withQueuedInputs ? 1 : 0);
    assert.equal(native.session.getFollowUpMessages().length, withQueuedInputs ? 1 : 0);
    setPhase("compact-native-summary");
    const result = await native.session.compact(instructions);
    await active;
    assert.ok(result.summary.includes(marker));
    const entries = native.sessionManager.getEntries();
    baseline = { users: users(entries), pendingSteer: native.session.getSteeringMessages().length,
      pendingFollow: native.session.getFollowUpMessages().length,
      lastGateStopReason: assistants(entries.slice(offset)).at(-1) };
    h.compactBaseline = baseline;
    assert.equal(entries.filter(e => e.type === "compaction").length, 1);
    setPhase("compact-native-context");
    await native.session.prompt(after);
    assert.equal((await readFile(join(project, "compact-result.txt"), "utf8")).trim(), marker);
  } finally { await native.session.abort(); native.dispose(); h.nativeCleanup = undefined; }

  setPhase("compact-backend-seed");
  await prepareProject(h.project);
  await h.terminal((await h.command("prompt", { text: seed })).commandId);
  const active = await h.command("prompt", { text: gate });
  await h.workerPid();
  await waitGate(h.project, h.timeoutMs);
  if (withQueuedInputs) {
    const first = await h.command("steer", { targetRunId: active.runId, text: steer });
    const second = await h.command("prompt", { text: follow, streamingBehavior: "followUp" });
    await until(() => h.query("SELECT payload_json FROM events WHERE type = 'input.updated'")
      .filter(row => { const p = JSON.parse(row.payload_json); return p.state === "queued" && [first.commandId, second.commandId].includes(p.commandId); }).length === 2,
    "two backend native inputs queued", h.timeoutMs);
  }
  const snapshot = await h.http("GET", `/v1/sessions/${h.sessionId}/snapshot`);
  setPhase("compact-backend-completion");
  const compact = await h.command("compact", { expectedVersion: snapshot.session.version, instructions });
  await h.terminal(compact.commandId);
  const mapping = h.query("SELECT pi_session_file FROM sessions WHERE id = ?", h.sessionId)[0];
  const entries = (await readFile(mapping.pi_session_file, "utf8")).trim().split("\n").map(JSON.parse);
  const compactEntries = entries.filter(e => e.type === "compaction");
  assert.equal(compactEntries.length, 1);
  assert.ok(compactEntries[0].summary.includes(marker));
  const state = await h.http("GET", `/v1/sessions/${h.sessionId}/snapshot`);
  setPhase("compact-native-comparison");
  assert.deepEqual(users(entries), baseline.users);
  assert.equal(state.pendingInputs.filter(i => i.delivery === "steer").length, baseline.pendingSteer);
  assert.equal(state.pendingInputs.filter(i => i.delivery === "followUp").length, baseline.pendingFollow);
  assert.equal(state.recoveredInputs.length, 0, "compact must not use stop's clearQueue path");
  const oldRun = h.query("SELECT status FROM runs WHERE id = ?", active.runId)[0];
  const expected = ["aborted", "toolUse"].includes(baseline.lastGateStopReason) ? "aborted" : baseline.lastGateStopReason === "error" ? "failed" : "completed";
  assert.equal(oldRun.status, expected, "old Run outcome must reflect the native queue path");
  const later = await h.command("prompt", { text: after });
  await h.terminal(later.commandId);
  assert.equal((await readFile(join(h.project, "compact-result.txt"), "utf8")).trim(), marker);
  record("AUTO-CMD-compact-native-queue", "passed", ["direct SDK compact and production backend with the same isolated config", "native queued input fate, old Run outcome and persisted compaction compared", "real summary retained marker; subsequent write verified on both sides", { withQueuedInputs, ...baseline }]);
}
