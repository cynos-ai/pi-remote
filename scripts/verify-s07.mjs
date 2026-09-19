import { sourceIdentity, consumeReport } from "./acceptance-evidence.mjs";
import { access, mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const resultsDir = join(root, "test-results", "s07");
const pythonCommand = process.env.PI_REMOTE_PYTHON ?? (process.platform === "win32" ? "python" : "python3");
await mkdir(resultsDir, { recursive: true });

const checks = [];
function record(id, status, command, evidence = [], reason) {
  const check = { id, status, command, evidence };
  if (reason) check.reason = reason;
  checks.push(check);
  console.log(`${status.toUpperCase()} ${id}${reason ? `: ${reason}` : ""}`);
}

function run(command, args) {
  return new Promise((resolvePromise) => {
    const executable = process.platform === "win32" && command === "pnpm" ? "pnpm.cmd" : command;
    const child = spawn(executable, args, {
      cwd: root,
      env: {
        ...process.env,
        CI: process.env.CI ?? "1",
        NPM_CONFIG_REGISTRY: process.env.NPM_CONFIG_REGISTRY ?? "https://registry.npmmirror.com",
        DOCKER_REGISTRY_MIRROR: process.env.DOCKER_REGISTRY_MIRROR ?? "docker.m.daocloud.io"
      },
      shell: process.platform === "win32" && command === "pnpm",
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolvePromise({ code: 1, signal: null, stdout, stderr: String(error) }));
    child.on("close", (code, signal) => resolvePromise({ code: code ?? 1, signal, stdout, stderr }));
  });
}

async function command(id, commandName, args, evidence = []) {
  const result = await run(commandName, args);
  const rendered = [commandName, ...args].join(" ");
  if (result.code === 0) {
    record(id, "passed", rendered, evidence);
  } else {
    record(id, "failed", rendered, [], `${result.stdout}\n${result.stderr}`.trim().slice(-4000));
  }
  return result;
}

const requiredFiles = [
  "apps/server/src/services/commands.ts",
  "apps/server/src/runtime/manager.ts",
  "packages/agent-pi/src/worker.ts",
  "packages/protocol/src/reducer.ts",
  "tests/commands/commands.test.ts",
  "tests/interactions/interactions.test.ts"
];
for (const relativePath of requiredFiles) {
  try {
    await access(join(root, relativePath));
    record(`S07-file-${relativePath}`, "passed", relativePath);
  } catch {
    record(`S07-file-${relativePath}`, "failed", relativePath, [], "required S07 file is missing");
  }
}

const nodeMajor = Number(process.versions.node.split(".")[0]);
record(
  "S07-node-runtime",
  nodeMajor === 24 ? "passed" : "failed",
  "node --version",
  [process.version],
  nodeMajor === 24 ? undefined : "S07 uses the project Node 24 baseline"
);

const build = await command("S07-server-build", "pnpm", ["run", "build:server"], [
  "protocol reducer",
  "agent-pi worker UI bridge",
  "server command service and runtime manager"
]);
if (build.code === 0) {
  await command("S07-command-contract", "pnpm", [
    "exec", "vitest", "run", "--config", "vitest.config.mjs",
    "tests/commands/commands.test.ts", "tests/interactions/interactions.test.ts"
  ], [
    "targeted abort/respond do not close another Run",
    "follow-up queue and idempotent command receipts",
    "configuration CAS and actual clamped value",
    "initialize/configure/run/bash/extension forms",
    "operationId/runId/origin/workerEpoch ownership",
    "cancelled, expired, duplicate, and asynchronous hook interactions"
  ]);
  if (process.platform === "linux") {
    await command("S07-native-form-processes", "node", ["scripts/test-real-process-e2e.mjs", "--no-build", "--forms-only"], [
      "real SDK extensions + production server/worker + HTTPS/WSS",
      "five lifecycle entry points, four dialogs, cancellation, expiry, replay and duplicate responses",
      "local synthetic model only; not provider, interactive TUI or device acceptance"
    ]);
    await command("S07-native-session-processes", "node", ["scripts/test-real-process-e2e.mjs", "--no-build", "--sessions-only"], [
      "native fork with two cross-session causal Runs and unchanged source history",
      "header-only import, extension/API title synchronization and restart",
      "missing/corrupt history rejected without recreation; source remains usable",
      "concurrent title CAS and native title recovery before event commit",
      "real SIGKILL before fork mapping and before mapping ACK; no automatic continuation replay",
      "local synthetic provider; not live provider, interactive TUI or device acceptance"
    ]);
  } else record("S07-native-form-processes", "not_run", "node scripts/test-real-process-e2e.mjs --no-build --forms-only", [], "requires Linux");
} else {
  record(
    "S07-command-contract",
    "not_run",
    "pnpm exec vitest run --config vitest.config.mjs tests/commands/commands.test.ts tests/interactions/interactions.test.ts",
    [],
    "server build failed"
  );
}

for (const [id, commandName, args] of [
  ["S07-lint", "pnpm", ["run", "lint"]],
  ["S07-typecheck", "pnpm", ["run", "typecheck"]],
  ["S07-docs", pythonCommand, ["scripts/check_docs.py"]]
]) {
  await command(id, commandName, args);
}

for (const scope of ["live-commands","parity-tui-commands"]) {
  const result = await consumeReport(scope);
  record(`S07-${scope}`, result.status, `test-results/${scope}/report.json`, result.evidence, result.reason);
}

const failed = checks.some((check) => check.status === "failed");
const notRun = checks.some((check) => check.status === "not_run");
const report = {
  stage: "S07",
  status: failed ? "failed" : notRun ? "blocked" : "passed",
  ...(await sourceIdentity()),
  environment: {
    os: process.platform,
    node: process.version,
    sdk: "0.85.1",
    npmRegistry: process.env.NPM_CONFIG_REGISTRY ?? "https://registry.npmmirror.com",
    dockerRegistryMirror: process.env.DOCKER_REGISTRY_MIRROR ?? "docker.m.daocloud.io",
    device: null
  },
  checks,
  limitations: [
    "S07 includes fake-handle contracts and real SDK/server/worker form tests with a local synthetic provider; neither replaces live provider, interactive pi TUI or device acceptance.",
    "Live provider commands, native TUI parity, Linux process-group behavior, and device evidence remain external requirements for S07/AT32.",
    "No credentials, prompts, session JSONL, or database contents are written to this report."
  ]
};
await writeFile(join(resultsDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
if (report.status !== "passed") process.exitCode = 1;
