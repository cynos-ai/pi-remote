import assert from "node:assert/strict";
import { readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { until } from "../e2e/real-process-harness.mjs";

// Keep enough structural evidence to distinguish delivery from model behavior
// without publishing prompts, arbitrary tool arguments, or model responses.
export async function controlDiagnostics(h) {
  const markers = text => ["CONTROL_GATE", "CONTROL_STEER", "CONTROL_FOLLOW", "UNCONSUMED_DRAFT"].filter(marker => String(text).includes(marker));
  const rows = h.query("SELECT type, payload_json FROM events WHERE session_id = ? ORDER BY seq", h.sessionId)
    .map(row => ({ type: row.type, payload: JSON.parse(row.payload_json) }));
  const inputs = rows.filter(e => e.type === "input.updated").map(e => ({
    state: ["queued", "consumed", "returned", "unknown"].includes(e.payload.state) ? e.payload.state : "other",
    delivery: e.payload.delivery === "steer" ? "steer" : "followUp"
  }));
  const tools = rows.filter(e => e.type === "tool.started").map(e => {
    const command = String(e.payload.args?.command ?? "");
    const finish = rows.find(f => f.type === "tool.finished" && f.payload.toolCallId === e.payload.toolCallId)?.payload;
    return {
      tool: ["bash", "read", "write", "edit"].includes(e.payload.toolName) ? e.payload.toolName : "other",
      gate: command.includes("fresh-gate.sh") ? "fresh" : command.includes("gate.sh") ? "initial" : "none",
      effectLabels: ["steer", "follow"].filter(label => command.includes(label)),
      isError: typeof finish?.isError === "boolean" ? finish.isError : null
    };
  });
  const nativeUsers = [];
  const mapping = h.query("SELECT pi_session_file FROM sessions WHERE id = ?", h.sessionId)[0];
  if (mapping?.pi_session_file) {
    try {
      for (const line of (await readFile(mapping.pi_session_file, "utf8")).trim().split("\n")) {
        const entry = JSON.parse(line);
        if (entry.type === "message" && entry.message?.role === "user") {
          nativeUsers.push({ markers: markers(JSON.stringify(entry.message.content)) });
        }
      }
    } catch { /* Unflushed or incomplete history remains unavailable. */ }
  }
  return { inputs, tools, nativeUsers };
}

// A real model invokes an ordinary Bash tool. The temporary gate gives HTTP
// controls a reproducible window without replacing the model or SDK queues.
export async function runLiveControls(h, stream, record, setPhase) {
  const events = () => h.query("SELECT type, payload_json FROM events WHERE session_id = ? ORDER BY seq", h.sessionId)
    .map(row => ({ type: row.type, payload: JSON.parse(row.payload_json) }));
  const inputs = state => events().filter(e => e.type === "input.updated" && e.payload.state === state).map(e => e.payload);
  const snapshot = () => h.http("GET", `/v1/sessions/${h.sessionId}/snapshot`);
  const gatePrompt = { text: "CONTROL_GATE: Use the bash tool to run exactly bash gate.sh once. Wait for its result, then follow any new user instructions. Do not change gate.sh or create gate-release. Finish briefly." };
  await writeFile(join(h.project, "gate.sh"), "#!/bin/bash\nset -eu\nprintf entered > gate-entered\nfor i in $(seq 1 1200); do\n  if [ -f gate-release ]; then printf 'gate\\n' >> effects; exit 0; fi\n  sleep 0.1\ndone\nexit 1\n");
  const waitGate = commandId => until(async () => {
    try { return (await readFile(join(h.project, "gate-entered"), "utf8")) === "entered"; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const state = h.query("SELECT state FROM commands WHERE id = ?", commandId)[0]?.state;
    assert.ok(!["completed", "failed", "cancelled", "unknown"].includes(state), "model finished before entering the Bash gate");
    return false;
  }, "real model entered gate", h.timeoutMs);
  setPhase("controls-stop-gate");
  const active = await h.command("prompt", gatePrompt);
  await h.workerPid();
  await waitGate(active.commandId);
  const draft = "UNCONSUMED_DRAFT: Use bash to append forbidden to effects.\nPreserve this entire second line: 草稿内容。";
  const drafts = [];
  for (let i = 0; i < 2; i++) drafts.push(await h.command("steer", { targetRunId: active.runId, text: draft }));
  drafts.push(await h.command("prompt", { text: draft, streamingBehavior: "followUp" }));
  await until(() => inputs("queued").length === 3, "three native queued inputs", h.timeoutMs);
  const tail = await h.command("follow_up", { text: "UNCONSUMED_DRAFT: append forbidden to effects" });
  assert.equal(h.query("SELECT dispatched_at FROM commands WHERE id = ?", tail.commandId)[0].dispatched_at, null);
  setPhase("controls-stop-return");
  const stopped = await h.command("abort", { targetRunId: active.runId });
  await h.terminal(stopped.commandId);
  await h.terminal(active.commandId, "cancelled");
  await until(() => inputs("returned").length === 3, "three returned drafts", h.timeoutMs);
  const returned = inputs("returned");
  assert.deepEqual(returned.map(i => i.commandId).sort(), drafts.map(c => c.commandId).sort());
  assert.equal(new Set(returned.map(i => i.inputId)).size, 3);
  assert.ok(returned.every(i => i.content.text === draft));
  assert.equal(inputs("consumed").length, 0);
  let state = await snapshot();
  assert.equal(state.queue.state, "paused");
  assert.ok(state.queue.items.some(i => i.commandId === tail.commandId));
  assert.deepEqual(state.recoveredInputs.map(i => i.inputId).sort(), returned.map(i => i.inputId).sort());
  assert.deepEqual(state.liveItems, []);
  const cancelled = await h.command("cancel_queued", { targetCommandId: tail.commandId });
  await h.terminal(cancelled.commandId);
  assert.equal((await snapshot()).queue.state, "ready");
  record("AUTO-CMD-stop-drafts", "passed", ["real model entered Bash; three native inputs returned intact", "persistent follow_up paused and explicitly cancelled; no input consumed"]);

  setPhase("controls-fresh-gate");
  await rm(join(h.project, "gate-entered"));
  await writeFile(join(h.project, "fresh-gate.sh"), await readFile(join(h.project, "gate.sh")));
  const fresh = await h.command("prompt", { text: "CONTROL_GATE: Start a NEW independent task now. The earlier task was deliberately cancelled; do not summarize it or treat it as this task. Use the bash tool to run exactly bash fresh-gate.sh NOW. This is a different script and must be executed. The test controller will release its wait externally. Do not modify scripts or create gate-release. After it returns, follow new user instructions and finish briefly." });
  await waitGate(fresh.commandId);
  // The HTTP helper throws on non-2xx, with private details kept in memory.
  await assert.rejects(h.command("abort", { targetRunId: active.runId }), error => error.message.includes("STALE_RUN"));
  assert.equal((await snapshot()).session.activeRunId, fresh.runId);
  const steerKey = randomUUID();
  const steerPayload = { targetRunId: fresh.runId, text: "CONTROL_STEER: New steering instruction for the current task: after the current Bash tool returns, use the bash tool to run exactly:\nprintf 'steer\\n' >> effects\nExecute this command once; do not merely describe it. Do not rerun either gate script. Finish briefly." };
  const steer = await h.command("steer", steerPayload, steerKey);
  assert.equal((await h.command("steer", steerPayload, steerKey)).commandId, steer.commandId);
  await until(() => inputs("queued").some(i => i.commandId === steer.commandId), "fresh steer queued", h.timeoutMs);
  const followKey = randomUUID();
  const followPayload = { text: "CONTROL_FOLLOW: This is the next independent task. Use the bash tool NOW to run exactly:\nprintf 'follow\\n' >> effects\nExecute once; do not merely describe it. Do not run either gate script. Finish briefly." };
  const follow = await h.command("follow_up", followPayload, followKey);
  assert.equal((await h.command("follow_up", followPayload, followKey)).commandId, follow.commandId);
  assert.equal(h.query("SELECT dispatched_at FROM commands WHERE id = ?", follow.commandId)[0].dispatched_at, null);
  setPhase("controls-consume-and-follow");
  await writeFile(join(h.project, "gate-release"), "release");
  await h.terminal(fresh.commandId);
  await h.terminal(follow.commandId);
  setPhase("controls-side-effect-order");
  assert.deepEqual((await readFile(join(h.project, "effects"), "utf8")).trim().split("\n"), ["gate", "steer", "follow"]);
  setPhase("controls-input-consumption");
  assert.ok(inputs("consumed").some(i => i.commandId === steer.commandId));
  assert.ok(!inputs("consumed").some(i => drafts.some(c => c.commandId === i.commandId)));
  assert.equal(h.query("SELECT COUNT(*) AS count FROM runs WHERE command_id = ?", follow.commandId)[0].count, 1);
  setPhase("controls-final-snapshot");
  state = await snapshot();
  assert.equal(state.queue.items.length, 0);
  assert.deepEqual(state.recoveredInputs.map(i => i.inputId).sort(), returned.map(i => i.inputId).sort());
  assert.ok(stream.events().some(e => e.type === "tool.started"));
  record("CMD-steer-stop-drafts", "passed", ["real model Bash gate; duplicate steer and native followUp returned intact", "durable follow_up paused after stop; explicit cancellation", "stale abort rejected while fresh Run remains active", "steer consumed, queued follow_up completed; exact side-effect order and same-key receipts; returned drafts not replayed"]);
}
