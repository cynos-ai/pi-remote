import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { strict as assert } from "node:assert";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { clearTimeout, setTimeout } from "node:timers";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const reportDir = join(root, "test-results", "live-sdk");
await mkdir(reportDir, { recursive: true });

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const suite = argument("--suite") ?? "sdk";
const report = {
  suite,
  status: "not_run",
  environment: { os: process.platform, node: process.version, sdk: "0.85.1" },
  checks: [],
  limitations: []
};

function record(id, status, evidence = [], reason) {
  const check = { id, status, evidence };
  if (reason) check.reason = reason;
  report.checks.push(check);
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
    throw new Error(`missing external live-test configuration: ${missing.join(", ")}`);
  }
  if (
    process.env.PI_REMOTE_LIVE_PROVIDER === process.env.PI_REMOTE_LIVE_THINKING_PROVIDER &&
    process.env.PI_REMOTE_LIVE_MODEL === process.env.PI_REMOTE_LIVE_THINKING_MODEL
  ) {
    throw new Error("the ordinary and thinking live-test models must be distinct");
  }
}

async function withTimeout(promise, timeoutMs, onTimeout) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          void onTimeout();
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
    assert.equal(await handle.services.modelRuntime.checkAuth(model.provider), true);
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
  requireLiveConfiguration();
  const fixtureRoot = await mkdtemp(join(root, "test-results", "live-sdk-fixture-"));
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
    assert.notEqual(`${ordinary.provider}/${ordinary.id}`, `${thinking.provider}/${thinking.id}`);

    const first = await runModel(
      api,
      fixture,
      ordinary,
      "ordinary",
      `Use the read tool to read ${markerPath}. Then use the write tool to write exactly its content to ${resultPath}. Do not skip either tool. End with a short confirmation.`
    );
    const resultContent = await readFile(resultPath, "utf8");
    assert.equal(resultContent.trim(), marker);
    record("AT02-live-prompt-read-write", "passed", ["real SDK prompt", "read tool", "write tool", "temporary result verified"]);

    const second = await runModel(
      api,
      fixture,
      thinking,
      "thinking",
      `Use the read tool to read ${markerPath}, then explain the marker in one sentence. Keep the answer concise.`
    );
    assert.ok(second.thinkingBlocks > 0, "configured thinking model did not expose a thinking block");
    record("AT03-live-thinking", "passed", ["real thinking model", "thinking block observed"]);
    report.checks.push({ id: "S02-live-results", status: "passed", evidence: [first, second] });
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

try {
  if (suite !== "sdk") throw new Error(`unsupported live suite: ${suite}`);
  const api = await import(pathToFileURL(join(root, "packages", "agent-pi", "dist", "index.js")).href);
  await runSdkLive(api);
  report.status = report.checks.some((check) => check.status === "failed") ? "failed" : "passed";
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  record("S02-live-configuration-or-run", process.env.PI_REMOTE_LIVE_TESTS === "1" ? "failed" : "not_run", [], reason);
  report.status = process.env.PI_REMOTE_LIVE_TESTS === "1" ? "failed" : "blocked";
  report.limitations.push("This command never substitutes a mock provider; missing live configuration is reported as not_run and exits non-zero.");
}

await writeFile(join(reportDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
if (report.status !== "passed") process.exitCode = 1;
