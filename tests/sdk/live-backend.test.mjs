import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { localHttpProvider } from "./local-http-provider.mjs";
import { runLiveBackend } from "./live-backend.mjs";
import { controlDiagnostics } from "./live-controls.mjs";

test("control diagnostics retain delivery structure without private content", async t => {
  const directory = await mkdtemp(join(tmpdir(), "pi-control-diagnostics-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const history = join(directory, "session.jsonl");
  await writeFile(history, JSON.stringify({ type: "message", message: { role: "user", content: "CONTROL_STEER synthetic-private-value" } }));
  const rows = [
    { type: "input.updated", payload: { state: "consumed", delivery: "steer", content: "synthetic-private-value" } },
    { type: "tool.started", payload: { toolCallId: "one", toolName: "bash", args: { command: "printf steer; synthetic-private-value" } } },
    { type: "tool.finished", payload: { toolCallId: "one", isError: false, output: { text: "synthetic-private-value" } } }
  ];
  const trace = await controlDiagnostics({ sessionId: "fixture", query: sql => sql.includes("FROM sessions")
    ? [{ pi_session_file: history }] : rows.map(row => ({ type: row.type, payload_json: JSON.stringify(row.payload) })) });
  assert.deepEqual(trace.nativeUsers, [{ markers: ["CONTROL_STEER"] }]);
  assert.deepEqual(trace.inputs, [{ state: "consumed", delivery: "steer" }]);
  assert.deepEqual(trace.tools, [{ tool: "bash", gate: "none", effectLabels: ["steer"], isError: false }]);
  assert.ok(!JSON.stringify(trace).includes("synthetic-private-value"));
});

// Tests the runner against a deterministic transport only. These results never
// populate a live-* acceptance report or count as external-provider evidence.
for (const [suite, scenario] of [["commands", "basic"], ["realtime", "basic"], ["commands", "controls"]]) {
  test(`live ${suite}/${scenario} runner: real backend and synthetic model transport`, { timeout: 240000 }, async () => {
    const provider = await localHttpProvider({ toolCopy: scenario === "basic", controls: scenario === "controls" });
    const agentDir = await mkdtemp(join(tmpdir(), "pi-runner-agent-"));
    const previous = { ...process.env };
    try {
      await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { "runner-local": {
        baseUrl: provider.baseUrl, api: "openai-completions", apiKey: "synthetic-not-a-credential",
        models: [
          { id: "ordinary", contextWindow: 128000, maxTokens: 4096 },
          { id: "thinking", reasoning: true, contextWindow: 128000, maxTokens: 4096 }
        ]
      } } }));
      await writeFile(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }));
      process.env.PI_REMOTE_LIVE_AGENT_DIR = agentDir;
      process.env.PI_REMOTE_LIVE_PROVIDER = "runner-local";
      process.env.PI_REMOTE_LIVE_MODEL = "ordinary";
      process.env.PI_REMOTE_LIVE_THINKING_PROVIDER = "runner-local";
      process.env.PI_REMOTE_LIVE_THINKING_MODEL = "thinking";
      process.env.PI_REMOTE_LIVE_TIMEOUT_MS = "180000";
      delete process.env.R16_EVIDENCE_DIR;
      const checks = [];
      await runLiveBackend(suite, (id, status, evidence) => checks.push({ id, status, evidence }), scenario);
      assert.equal(checks.length, 2);
      assert.ok(checks.every(c => c.status === "passed"));
      if (scenario === "basic") assert.equal(provider.requests.length, 3, "read + write + final answer, no idempotent replay call");
      else assert.ok(provider.requests.every(body => !JSON.stringify(body.messages).includes("UNCONSUMED_DRAFT")), "returned drafts never reach provider");
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
      Object.assign(process.env, previous);
      await provider.close();
      await rm(agentDir, { recursive: true, force: true });
    }
  });
}
