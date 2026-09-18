import { access, mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pythonCommand = process.env.PI_REMOTE_PYTHON ?? (process.platform === "win32" ? "python" : "python3");
const resultsDir = join(root, "test-results", "s06");
await mkdir(resultsDir, { recursive: true });

const checks = [];
function record(id, status, command, evidence = [], reason) {
  const check = { id, status, command, evidence };
  if (reason) check.reason = reason;
  checks.push(check);
  console.log(status.toUpperCase() + " " + id + (reason ? ": " + reason : ""));
}

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
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
    child.on("error", reject);
    child.on("close", (code, signal) => resolvePromise({ code: code ?? 1, signal, stdout, stderr }));
  });
}

async function command(id, commandName, args, evidence = []) {
  try {
    const result = await run(commandName, args);
    if (result.code === 0) {
      record(id, "passed", [commandName, ...args].join(" "), evidence);
    } else {
      const output = `${result.stdout}\n${result.stderr}`.trim().slice(-4000);
      record(id, "failed", [commandName, ...args].join(" "), [], output);
    }
    return result;
  } catch (error) {
    record(id, "failed", [commandName, ...args].join(" "), [], error instanceof Error ? error.message : String(error));
    return { code: 1, signal: null, stdout: "", stderr: String(error) };
  }
}

const requiredFiles = [
  "apps/server/src/runtime/manager.ts",
  "apps/server/src/runtime/scheduler.ts",
  "apps/server/src/runtime/recovery.ts",
  "apps/server/src/runtime/ipc.ts",
  "packages/agent-pi/src/worker.ts",
  "tests/runtime/runtime.test.ts"
];
for (const relativePath of requiredFiles) {
  try {
    await access(join(root, relativePath));
    record(`S06-file-${relativePath}`, "passed", relativePath);
  } catch {
    record(`S06-file-${relativePath}`, "failed", relativePath, [], "required S06 file is missing");
  }
}

const nodeMajor = Number(process.versions.node.split(".")[0]);
record("S06-node-runtime", nodeMajor === 24 ? "passed" : "failed", "node --version", [process.version], nodeMajor === 24 ? undefined : "S06 requires Node 24 for node:sqlite and the pinned SDK");

const build = await command("S06-server-build", "pnpm", ["run", "build:server"], [
  "protocol package",
  "agent-pi worker",
  "server runtime",
  "copied migration assets"
]);
if (build.code === 0) {
  await command("S06-runtime-tests", "pnpm", ["run", "test:unit", "--", "tests/runtime/runtime.test.ts"], [
    "scheduler admission",
    "IPC framing and ACK",
    "worker mapping boundary",
    "active Run interruption",
    "queued target stale runtime",
    "single-instance lock"
  ]);
} else {
  record("S06-runtime-tests", "not_run", "pnpm run test:unit -- tests/runtime/runtime.test.ts", [], "server build failed");
}

for (const [id, commandName, args] of [
  ["S06-lint", "pnpm", ["run", "lint"]],
  ["S06-typecheck", "pnpm", ["run", "typecheck"]],
  ["S06-docs", pythonCommand, ["scripts/check_docs.py"]]
]) {
  await command(id, commandName, args);
}

// The native TUI and live-provider portions are deliberately not fabricated.
// They remain separately attributable evidence for AT31/AT32 and require the
// operator's real model configuration and a Linux native pi TUI baseline.
record(
  "S06-AT31-native-parity",
  "not_run",
  "pnpm test:bash-parity -- --target runtime",
  [],
  "live provider and native TUI baseline are not configured in this workspace"
);
record(
  "S06-AT32-native-parity",
  "not_run",
  "pnpm test:tui-parity -- --target runtime",
  [],
  "a native pi TUI capture is required; a synthetic capture would not be evidence"
);

const failed = checks.some((check) => check.status === "failed");
const notRun = checks.some((check) => check.status === "not_run");
const report = {
  stage: "S06",
  status: failed ? "failed" : notRun ? "blocked" : "passed",
  commit: "working-tree",
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
    "The repeatable S06 contract tests use temporary SQLite state and fake child-process streams; they do not replace a live provider, native pi TUI, or real SIGKILL/Bash process-group test.",
    "AT31/AT32 native parity remains not_run until the operator supplies the same Linux SDK/TUI baseline and bounded live-test configuration.",
    "No credentials, prompts, session JSONL, or database contents are written to the report."
  ]
};
await writeFile(join(resultsDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
if (report.status !== "passed") process.exitCode = 1;
