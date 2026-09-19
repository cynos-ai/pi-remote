import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { RealProcessHarness } from "../e2e/real-process-harness.mjs";
import { root } from "../../scripts/acceptance-evidence.mjs";

// Reuse only the real HTTPS/WSS/process client. Never call the deterministic
// harness factory: that factory installs a local substitute model provider.
export async function runLiveBackend(suite, record, scenario = "basic", options = {}) {
  const h = new RealProcessHarness();
  h.label = `live-${suite}`;
  h.privateEvidence = true;
  h.entry = "tests/sdk/live-server-entry.mjs";
  h.root = await mkdtemp(join(tmpdir(), "pi-live-"));
  h.project = join(h.root, "project");
  let timer;
  let streamProbe;
  let phase = "fixture-startup";
  try {
    await mkdir(h.project);
    await mkdir(join(h.root, "state"));
    const key = join(h.root, "key.pem"), cert = join(h.root, "cert.pem");
    const tls = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert,
      "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost"], { stdio: "ignore" });
    assert.equal(tls.status, 0, "live backend requires openssl");
    h.ca = await readFile(cert);
    h.env = { ...process.env, PI_REMOTE_HOST: "127.0.0.1", PI_REMOTE_PORT: "0",
      PI_REMOTE_STATE_DIR: join(h.root, "state"), PI_REMOTE_DATABASE_FILE: join(h.root, "state", "state.sqlite"),
      PI_REMOTE_PI_DIR: process.env.PI_REMOTE_LIVE_AGENT_DIR, PI_REMOTE_WORKSPACE_ROOT: h.project,
      PI_REMOTE_OWNER_ID: "live-test-owner", PI_REMOTE_OWNER_NAME: "Live test",
      PI_REMOTE_CURSOR_SECRET: randomUUID(), R16_TLS_KEY: key, R16_TLS_CERT: cert };
    if (scenario.startsWith("compact")) {
      const { prepareCompactAgent, installCompactCancelExtension } = await import("./live-compact.mjs");
      h.env.PI_REMOTE_PI_DIR = join(h.root, "compact-agent");
      await prepareCompactAgent(process.env.PI_REMOTE_LIVE_AGENT_DIR, h.env.PI_REMOTE_PI_DIR);
      if (scenario === "compact-cancel") await installCompactCancelExtension(h.env.PI_REMOTE_PI_DIR);
      if (scenario === "compact-cancel-stream") {
        const { summaryStreamProbe } = await import("./summary-stream-probe.mjs");
        streamProbe = await summaryStreamProbe(h.env.PI_REMOTE_PI_DIR, process.env.PI_REMOTE_LIVE_PROVIDER);
      }
    }
    if (scenario === "configuration") {
      h.env.PI_REMOTE_PI_DIR = join(h.root, "configuration-agent");
      await cp(process.env.PI_REMOTE_LIVE_AGENT_DIR, h.env.PI_REMOTE_PI_DIR, { recursive: true });
    }
    // No raw logs/database evidence from the deterministic harness may be saved.
    assert.ok(!process.env.R16_EVIDENCE_DIR, "unset R16_EVIDENCE_DIR for private live tests");
    await h.start();
    const timeout = Number(process.env.PI_REMOTE_LIVE_TIMEOUT_MS ?? 120000);
    h.timeoutMs = timeout;
    // The harness deadline is not a production tool timeout. Terminate this
    // fixture's worker/server if an assertion or model interaction stalls.
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("live backend harness deadline exceeded")), timeout);
    });
    const execute = async () => {
      phase = "pair-project-session";
      const pairing = spawnSync(process.execPath, ["apps/server/dist/cli.js", "pair"], { cwd: root, env: h.env, encoding: "utf8" });
      assert.equal(pairing.status, 0, "private live pairing failed");
      const paired = await h.http("POST", "/v1/pair", { pairingToken: JSON.parse(pairing.stdout).token, deviceName: "live test" });
      h.token = paired.deviceToken;
      const project = await h.http("POST", "/v1/projects", { name: "synthetic live project", rootPath: h.project });
      const ordinary = { provider: process.env.PI_REMOTE_LIVE_PROVIDER, id: process.env.PI_REMOTE_LIVE_MODEL };
      const created = await h.http("POST", `/v1/projects/${project.project.id}/sessions`, { title: "synthetic live task", model: ordinary });
      h.sessionId = created.session.id;
      const stream = await h.connect();
      if (scenario === "configuration") {
        const { runLiveConfiguration } = await import("./live-configuration.mjs");
        await runLiveConfiguration(h, record, value => { phase = value; });
        return;
      }
      if (scenario.startsWith("compact")) {
        const { runLiveCompact, runEmptyCompact, runCompactCancel } = await import("./live-compact.mjs");
        if (scenario.startsWith("compact-cancel")) await runCompactCancel(h, record, value => { phase = value; }, streamProbe);
        else if (options.compactEmptySession) await runEmptyCompact(h, record);
        else await runLiveCompact(h, record, value => { phase = value; }, options.compactQueuedInputs ?? true);
        return;
      }
      if (scenario === "controls") {
        const { runLiveControls } = await import("./live-controls.mjs");
        await runLiveControls(h, stream, record, value => { phase = value; });
        return;
      }
      // Disconnect in the message callback, before another complete fast model
      // turn can overtake a polling loop or worker-PID lookup.
      const disconnected = new Promise(resolve => {
        const onMessage = raw => {
          const frame = JSON.parse(raw.toString());
          if (frame.type === "event" && ["content.delta", "tool.started"].includes(frame.event.type)) {
            stream.socket.off("message", onMessage);
            stream.socket.terminate();
            resolve(frame.event.seq);
          }
        };
        stream.socket.on("message", onMessage);
      });
      await writeFile(join(h.project, "marker.txt"), "pi-live-marker\n");
      const requestKey = randomUUID();
      const payload = { text: "Read marker.txt using the read tool, then use the write tool to copy its exact contents to result.txt. Finish with one short sentence." };
      const receipt = await h.command("prompt", payload, requestKey);
      phase = "first-stream-event";
      await h.workerPid();
      const cursor = await disconnected;
      phase = "command-terminal";
      await h.terminal(receipt.commandId);
      phase = "tool-result-file";
      assert.equal((await readFile(join(h.project, "result.txt"), "utf8")).trim(), "pi-live-marker");
      const replay = await h.connect(cursor);
      phase = "replay-equality";
      const durable = h.query("SELECT seq, type, payload_json FROM events WHERE session_id = ? AND seq > ? ORDER BY seq", h.sessionId, cursor);
      assert.ok(durable.length > 0, "events must exist after disconnect");
      assert.deepEqual(replay.events().map(e => [e.seq, e.type, e.payload]), durable.map(e => [e.seq, e.type, JSON.parse(e.payload_json)]));
      assert.equal((await h.command("prompt", payload, requestKey)).commandId, receipt.commandId);
      record(suite === "realtime" ? "RT-stream-tool" : "AUTO-CMD-prompt-idempotency", "passed", ["real provider + production worker + verified file + HTTPS/WSS", "same-key command returns original receipt"]);
      if (suite === "realtime") record("RT-reconnect-replay", "passed", ["disconnect after live event", "replayed seq/type/payload equal persisted events"]);
      if (suite === "commands") {
        phase = "idle-configuration";
        let snapshot = await h.http("GET", `/v1/sessions/${h.sessionId}/snapshot`);
        const thinking = { provider: process.env.PI_REMOTE_LIVE_THINKING_PROVIDER, id: process.env.PI_REMOTE_LIVE_THINKING_MODEL };
        const changed = await h.command("set_model", { expectedVersion: snapshot.session.version, model: thinking });
        await h.terminal(changed.commandId);
        snapshot = await h.http("GET", `/v1/sessions/${h.sessionId}/snapshot`);
        assert.deepEqual(snapshot.session.model, thinking);
        const level = snapshot.availableThinkingLevels.find(l => l !== "off");
        assert.ok(level, "thinking model exposes a non-off level");
        const configured = await h.command("set_thinking", { expectedVersion: snapshot.session.version, level });
        await h.terminal(configured.commandId);
        snapshot = await h.http("GET", `/v1/sessions/${h.sessionId}/snapshot`);
        assert.equal(snapshot.session.thinkingLevel, level);
        record("AUTO-CMD-idle-config", "passed", ["actual model and thinking projection checked through HTTPS", "streaming/configuration hooks require separate scenario evidence"]);
      }
    };
    await Promise.race([execute(), deadline]);
  } catch (error) {
    // Only fixed local labels are safe to publish. Never serialize provider
    // errors, assertion values, server logs, or response bodies.
    const category = error?.code === "ERR_ASSERTION" ? "assertion" : error?.code === "ENOENT" ? "missing-file" : "execution";
    const diagnostics = [];
    if (h.compactBaseline) diagnostics.push({ nativeCompact: h.compactBaseline });
    if (scenario === "controls") {
      try {
        const { controlDiagnostics } = await import("./live-controls.mjs");
        diagnostics.push(await controlDiagnostics(h));
      } catch { /* Fixture may have failed before session creation. */ }
    }
    try {
      const states = h.query("SELECT state, COUNT(*) AS count FROM commands GROUP BY state");
      for (const { state, count } of states) {
        if (["queued", "dispatching", "accepted", "completed", "cancelled", "failed", "unknown"].includes(state)) diagnostics.push({ commandState: state, count });
      }
      const types = h.query("SELECT type, COUNT(*) AS count FROM events GROUP BY type");
      for (const { type, count } of types) {
        if (["tool.started", "tool.completed", "content.delta", "input.updated", "run.updated"].includes(type)) diagnostics.push({ eventType: type, count });
      }
      const failures = h.query("SELECT payload_json FROM events WHERE type = 'command.updated'")
        .map(row => JSON.parse(row.payload_json).error).filter(Boolean);
      const failureMessages = [...failures.map(error => error.message), error?.message].filter(value => typeof value === "string");
      const safeCodes = ["SDK_OPERATION_FAILED", "WORKER_START_TIMEOUT", "WORKER_HEARTBEAT_TIMEOUT", "WORKER_BUSY", "WORKER_DISCONNECTED", "STALE_RUN"];
      for (const code of safeCodes) if (failures.some(error => error.code === code)) diagnostics.push({ failureCode: code });
      const categories = [
        ["authentication", /unauthori[sz]ed|invalid.api.key|\b401\b/i],
        ["balance", /insufficient|balance|\b402\b/i],
        ["rate-limit", /rate.limit|\b429\b/i],
        ["provider-server", /\b50[0234]\b|server.error/i],
        ["network", /fetch failed|connection|ECONN|ENOTFOUND|ETIMEDOUT|socket/i],
        ["tls", /certificate|CERT_|TLS/i],
        ["timeout", /timeout|timed out/i],
        ["provider-request-timeout", /request.*time.?out|request.*timed out/i],
        ["worker-heartbeat", /heartbeat/i],
        ["worker-busy", /already.*active|worker.*busy/i],
        ["model-config", /model.*not|unsupported|not.found/i]
      ];
      for (const [label, pattern] of categories) {
        if (failureMessages.some(message => pattern.test(message))) diagnostics.push({ failureCategory: label });
      }
      try {
        const lines = (await readFile(join(h.project, "effects"), "utf8")).trim().split("\n");
        diagnostics.push({ sideEffectOrder: lines.slice(0, 20).map(line => ["gate", "steer", "follow"].includes(line) ? line : "other") });
      } catch { /* Side effects may not exist yet. */ }
    } catch { /* Startup may not have created the database. */ }
    record("live-runner", "failed", [phase, category, ...diagnostics], "backend check failed; private error details withheld");
    throw error;
  } finally {
    clearTimeout(timer);
    h.nativeCleanup?.();
    // Discover remaining workers even when startup failed before workerPid().
    if (h.main?.pid) {
      try {
        const ids = (await readFile(`/proc/${h.main.pid}/task/${h.main.pid}/children`, "utf8")).trim().split(/\s+/).filter(Boolean);
        for (const id of ids) h.workers.add(Number(id));
      } catch { /* Fixture has already stopped. */ }
    }
    try { await h.close(); }
    finally { await streamProbe?.close(); }
  }
}
