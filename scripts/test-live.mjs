import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { strict as assert } from "node:assert";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { clearTimeout, setTimeout } from "node:timers";
import { tmpdir } from "node:os";
import { aggregate, importEvidence, liveCases, plan, sourceIdentity } from "./acceptance-evidence.mjs";
import { selectLiveModels } from "./live-model-selection.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const suite = argument("--suite") ?? "sdk";
const scenario = argument("--scenario") ?? "basic";
if (!["basic", "controls", "configuration", "compact", "compact-cancel", "compact-cancel-stream"].includes(scenario) || (scenario !== "basic" && suite !== "commands")) {
  console.error("controls/compact scenarios require --suite commands");
  process.exit(2);
}
if (!Object.hasOwn(liveCases, suite)) {
  console.error("unsupported live suite; use sdk, commands or realtime");
  process.exit(2);
}
const scope = `live-${suite}`;
const identity = await sourceIdentity();
if (process.argv.includes("--plan")) {
  console.log(JSON.stringify(plan(scope, identity), null, 2));
  process.exit(0);
}
const reportDir = join(process.env.PI_REMOTE_ACCEPTANCE_REPORT_DIR || join(root, "test-results"), scope);
await mkdir(reportDir, { recursive: true });
const report = {
  schemaVersion: 1, scope, ...identity, recordedAt: new Date().toISOString(),
  suite, scenario,
  status: "not_run",
  environment: { os: process.platform, node: process.version, sdk: "0.85.1" },
  checks: [],
  limitations: []
};

function record(id, status, evidence = [], reason) {
  const check = { id, status, evidence, provenance: "automated" };
  if (reason) check.reason = reason;
  const index = report.checks.findIndex(c => c.id === id);
  if (index < 0) report.checks.push(check);
  // Automated success cannot erase an operator-recorded failure.
  else if (report.checks[index].status !== "failed") report.checks[index] = check;
  console.log(`${status.toUpperCase()} ${id}${reason ? `: ${reason}` : ""}`);
}

function requireLiveConfiguration() {
  const required = [
    "PI_REMOTE_LIVE_AGENT_DIR",
    "PI_REMOTE_LIVE_PROVIDER",
    "PI_REMOTE_LIVE_MODEL",
    "PI_REMOTE_LIVE_THINKING_PROVIDER",
    "PI_REMOTE_LIVE_THINKING_MODEL"
  ];
  const missing = required.filter((name) => !process.env[name]);
  if (process.env.PI_REMOTE_LIVE_TESTS !== "1") {
    throw new Error("set PI_REMOTE_LIVE_TESTS=1 to authorize bounded real-provider calls");
  }
  if (missing.length > 0) {
    return false;
  }
  if (process.platform !== "linux") return false;
  const operations = Number(process.env.PI_REMOTE_LIVE_MAX_OPERATIONS);
  const timeout = Number(process.env.PI_REMOTE_LIVE_TIMEOUT_MS ?? 120000);
  if (!Number.isSafeInteger(operations) || operations < (scenario.startsWith("compact") ? 8 : scenario === "configuration" ? 4 : scenario === "controls" ? 3 : suite === "sdk" ? 2 : 1) || !Number.isFinite(timeout) || timeout < 1000 || timeout > 1800000) return false;
  selectLiveModels(process.env);
  return true;
}

async function withTimeout(promise, timeoutMs, onTimeout) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          void Promise.resolve().then(onTimeout).catch(() => {});
          reject(new Error(`live SDK operation exceeded ${timeoutMs}ms`));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function messageText(message) {
  if (!message || !("content" in message)) return "";
  if (typeof message.content === "string") return message.content;
  return message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
}

async function runModel(api, fixture, model, label, prompt) {
  const handle = await api.createPiAgentSession({
    cwd: fixture.project,
    agentDir: fixture.agentDir,
    sessionDir: fixture.sessionDir,
    model,
    tools: ["read", "write"],
    resourceLoaderOptions: {
      noThemes: true
    }
  });
  const events = [];
  const preflight = [];
  const unsubscribe = handle.onEvent((event) => events.push(event));
  try {
    const auth = await handle.services.modelRuntime.checkAuth(model.provider);
    assert.ok(auth && ["api_key", "oauth"].includes(auth.type), "model authentication is unavailable");
    if (label === "thinking") {
      const level = handle.session.getAvailableThinkingLevels().find(value => value !== "off");
      assert.ok(level, "thinking model has no non-off reasoning level");
      handle.session.setThinkingLevel(level);
    }
    await withTimeout(
      handle.session.prompt(prompt, { preflightResult: (accepted) => preflight.push(accepted) }),
      Number(process.env.PI_REMOTE_LIVE_TIMEOUT_MS ?? 120000),
      () => handle.session.abort()
    );
    assert.deepEqual(preflight, [true]);
    assert.ok(events.some((event) => event.type === "agent_settled"));
    const assistantMessages = handle.session.messages.filter((message) => message.role === "assistant");
    assert.ok(assistantMessages.length > 0, `${label}: no assistant message returned`);
    const finalMessage = assistantMessages.at(-1);
    assert.ok(finalMessage && !["error", "aborted"].includes(finalMessage.stopReason), "model did not complete successfully");
    return {
      label,
      model: `${model.provider}/${model.id}`,
      eventTypes: [...new Set(events.map((event) => event.type))].sort(),
      assistantTextLength: messageText(finalMessage).length,
      thinkingBlocks: assistantMessages.reduce(
        (count, message) => count + (Array.isArray(message.content) ? message.content.filter((block) => block.type === "thinking").length : 0),
        0
      )
    };
  } finally {
    unsubscribe();
    handle.dispose();
  }
}

async function runSdkLive(api) {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "pi-live-sdk-fixture-"));
  const fixture = {
    root: fixtureRoot,
    project: join(fixtureRoot, "project"),
    agentDir: resolve(process.env.PI_REMOTE_LIVE_AGENT_DIR),
    sessionDir: join(fixtureRoot, "sessions")
  };
  await mkdir(fixture.project, { recursive: true });
  await mkdir(fixture.sessionDir, { recursive: true });
  const marker = "pi-remote-s02-live-marker";
  const markerPath = join(fixture.project, "s02-marker.txt");
  const resultPath = join(fixture.project, "s02-result.txt");
  await writeFile(markerPath, `${marker}\n`, "utf8");
  try {
    const seed = await api.createPiAgentSession({
      cwd: fixture.project,
      agentDir: fixture.agentDir,
      sessionDir: fixture.sessionDir,
      noTools: "all",
      resourceLoaderOptions: { noThemes: true }
    });
    const modelRuntime = seed.services.modelRuntime;
    const ordinary = modelRuntime.getModel(process.env.PI_REMOTE_LIVE_PROVIDER, process.env.PI_REMOTE_LIVE_MODEL);
    const thinking = modelRuntime.getModel(process.env.PI_REMOTE_LIVE_THINKING_PROVIDER, process.env.PI_REMOTE_LIVE_THINKING_MODEL);
    seed.dispose();
    assert.ok(ordinary, "ordinary live model is not present in the configured model catalog");
    assert.ok(thinking, "thinking live model is not present in the configured model catalog");
    const selection = selectLiveModels(process.env);
    if (selection.distinct) assert.notEqual(`${ordinary.provider}/${ordinary.id}`, `${thinking.provider}/${thinking.id}`);
    else report.limitations.push("Single-model smoke was explicitly selected; thinking output is tested but the distinct second model requirement remains not_run.");

    const first = await runModel(
      api,
      fixture,
      ordinary,
      "ordinary",
      `Use the read tool to read ${markerPath}. Then use the write tool to write exactly its content to ${resultPath}. Do not skip either tool. End with a short confirmation.`
    );
    const resultContent = await readFile(resultPath, "utf8");
    assert.equal(resultContent.trim(), marker);
    record("AT02-prompt-tools", "passed", ["real SDK prompt", "read tool", "write tool", "temporary result verified"]);

    const second = await runModel(
      api,
      fixture,
      thinking,
      "thinking",
      `Use the read tool to read ${markerPath}, then explain the marker in one sentence. Keep the answer concise.`
    );
    assert.ok(second.thinkingBlocks > 0, "configured thinking model did not expose a thinking block");
    record(selection.thinkingCheckId, "passed", ["real thinking model", "thinking block observed"]);
    record("S02-live-results", "passed", [first, second]);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

let phase = "evidence";
try {
  const evidencePath = argument("--evidence") ?? (process.env.PI_REMOTE_ACCEPTANCE_EVIDENCE_DIR ? join(process.env.PI_REMOTE_ACCEPTANCE_EVIDENCE_DIR, `${scope}.json`) : undefined);
  report.checks = await importEvidence(evidencePath, scope, identity);
  phase = "execution";
  if (process.env.PI_REMOTE_LIVE_TESTS === "1" && !process.argv.includes("--evidence-only")) {
    if (!requireLiveConfiguration()) {
      record("live-environment", "not_run", [], "environment: Linux, dedicated agent dir, two models, explicit max operations and valid timeout required");
    } else if (suite === "sdk") {
      const api = await import(pathToFileURL(join(root, "packages", "agent-pi", "dist", "index.js")).href);
      await runSdkLive(api);
    } else {
      let stage;
      try {
        let directory = root;
        if (/^\/mnt\/[a-z]\//.test(root)) {
          stage = await mkdtemp(join(tmpdir(), "pi-live-runtime-"));
          const { stageRealProcessRuntime } = await import("./stage-real-process-runtime.mjs");
          await stageRealProcessRuntime(root, stage);
          directory = stage;
        }
        const { runLiveBackend } = await import(pathToFileURL(join(directory, "tests/sdk/live-backend.mjs")).href);
        await runLiveBackend(suite, record, scenario);
      } finally {
        if (stage) await rm(stage, { recursive: true, force: true });
      }
    }
  }
} catch {
  // SDK/provider errors can embed credentials, response content or private
  // paths. Deliberately do not serialize arbitrary exception messages.
  record("live-runner", "failed", [], `${phase}: failed; inspect private configuration/captures locally`);
}
report.status = aggregate(report.checks);
report.limitations.push("Automated checks and operator-recorded captures are distinct evidence sources; full suite coverage is mandatory.");
report.limitations.push("PI_REMOTE_LIVE_MAX_OPERATIONS bounds top-level model operations (SDK: 2; backend basic: 1; controls: 3; configuration: 4; compact comparison/cancellation: 8), not provider HTTP requests or monetary spend. Native tool loops/retries may make additional calls; use provider-side spending limits.");

await writeFile(join(reportDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
if (report.status !== "passed") process.exitCode = 1;
