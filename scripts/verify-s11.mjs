import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const resultsDir = join(root, "test-results", "s11");
const pythonCommand = process.env.PI_REMOTE_PYTHON ?? (process.platform === "win32" ? "python" : "python3");
const environment = {
  ...process.env,
  CI: process.env.CI ?? "1",
  NPM_CONFIG_REGISTRY: process.env.NPM_CONFIG_REGISTRY ?? "https://registry.npmmirror.com",
  DOCKER_REGISTRY_MIRROR: process.env.DOCKER_REGISTRY_MIRROR ?? "docker.m.daocloud.io"
};
await mkdir(resultsDir, { recursive: true });

const checks = [];

function redact(value) {
  let result = String(value ?? "");
  for (const key of [
    "PI_REMOTE_TEST_SERVER",
    "PI_REMOTE_TEST_PAIRING_TOKEN",
    "PI_REMOTE_TEST_PROJECT_NAME",
    "PI_REMOTE_TEST_PROJECT_ROOT",
    "PI_REMOTE_TEST_PROMPT",
    "PI_REMOTE_TEST_STEER"
  ]) {
    const secret = environment[key];
    if (typeof secret === "string" && secret.length > 0) result = result.split(secret).join("[redacted]");
  }
  return result.replace(/(authorization|bearer|token)\s*[:=]?\s*[^\s,;]+/gi, "$1=[redacted]");
}

function record(id, status, command, evidence = [], reason, details) {
  const check = { id, status, command, evidence };
  if (reason) check.reason = redact(reason);
  if (details && typeof details === "object" && Object.keys(details).length > 0) check.details = details;
  checks.push(check);
  console.log(`${status.toUpperCase()} ${id}${reason ? `: ${redact(reason)}` : ""}`);
}

function run(command, args, env = environment) {
  return new Promise((resolvePromise) => {
    const executable = process.platform === "win32" && command === "pnpm" ? "pnpm.cmd" : command;
    const child = spawn(executable, args, {
      cwd: root,
      env,
      shell: process.platform === "win32" && command === "pnpm",
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolvePromise({ code: 1, stdout, stderr: String(error) }));
    child.on("close", (code, signal) => resolvePromise({ code: code ?? 1, signal, stdout, stderr }));
  });
}

async function command(id, commandName, args, evidence = []) {
  const result = await run(commandName, args);
  const rendered = [commandName, ...args].join(" ");
  if (result.code === 0) record(id, "passed", rendered, evidence);
  else record(id, "failed", rendered, [], `${result.stdout}\n${result.stderr}`.trim().slice(-4_000));
  return result;
}

async function checkFile(relativePath) {
  try {
    await access(join(root, relativePath));
    record(`S11-file-${relativePath}`, "passed", relativePath);
  } catch {
    record(`S11-file-${relativePath}`, "failed", relativePath, [], "required S11 file is missing");
  }
}

for (const relativePath of [
  "tests/e2e/harness.ts",
  "tests/e2e/s11-weak-network.test.ts",
  "tests/e2e/s11-recovery.test.ts",
  "tests/e2e/s11-dual-device.test.ts",
  "scripts/test-device.mjs",
  ".maestro/s11-recovery-android.yaml",
  ".maestro/s11-recovery-ios.yaml"
]) await checkFile(relativePath);

const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const verifyScript = packageJson.scripts?.["verify:S11"];
record(
  "S11-script-entry",
  verifyScript === "node scripts/verify-s11.mjs" ? "passed" : "failed",
  "package.json#scripts.verify:S11",
  [],
  verifyScript === "node scripts/verify-s11.mjs" ? undefined : "verify:S11 is not registered"
);
const deviceScript = packageJson.scripts?.["test:device"];
record(
  "S11-device-script-entry",
  deviceScript === "node scripts/test-device.mjs" ? "passed" : "failed",
  "package.json#scripts.test:device",
  [],
  deviceScript === "node scripts/test-device.mjs" ? undefined : "test:device must execute the real platform runner"
);

const npmrc = await readFile(join(root, ".npmrc"), "utf8");
const ci = await readFile(join(root, ".github", "workflows", "ci.yml"), "utf8");
const domesticSources = npmrc.includes("registry=https://registry.npmmirror.com")
  && environment.NPM_CONFIG_REGISTRY === "https://registry.npmmirror.com"
  && environment.DOCKER_REGISTRY_MIRROR === "docker.m.daocloud.io"
  && ci.includes("NPM_CONFIG_REGISTRY: https://registry.npmmirror.com")
  && ci.includes("DOCKER_REGISTRY_MIRROR: docker.m.daocloud.io");
record(
  "S11-domestic-sources",
  domesticSources ? "passed" : "failed",
  ".npmrc + CI domestic source environment",
  [String(environment.NPM_CONFIG_REGISTRY), String(environment.DOCKER_REGISTRY_MIRROR)],
  domesticSources ? undefined : "npm and Docker sources must use the project domestic mirrors in local and CI configuration"
);

const nodeMajor = Number(process.versions.node.split(".")[0]);
record("S11-node-runtime", nodeMajor === 24 ? "passed" : "failed", "node --version", [process.version], nodeMajor === 24 ? undefined : "S11 uses the project Node 24 baseline");

await command("S11-protocol-build", "pnpm", ["--filter", "@pi-remote/protocol", "build"], ["shared event, snapshot, command and WebSocket schemas"]);
await command("S11-server-build", "pnpm", ["run", "build:server"], ["Linux Node server and worker runtime"]);
await command("S11-e2e", "pnpm", [
  "exec", "vitest", "run", "--config", "vitest.config.mjs", "tests/e2e"
], [
  "duplicate WebSocket frames and cursor gap resync",
  "cache loss and AppState foreground reconnect",
  "real Linux SIGKILL worker / main probes",
  "partial archive, unknown tool outcome, cancelled interaction and paused queue",
  "two-device event stream, lost HTTP response, CAS rename, replay and revocation"
]);
await command("S11-android-js", "pnpm", ["run", "build:android"], ["Android JavaScript bundle"]);
await command("S11-ios-js", "pnpm", ["run", "build:ios"], ["iOS JavaScript bundle"]);

for (const [id, commandName, args] of [
  ["S11-lint", "pnpm", ["run", "lint"]],
  ["S11-typecheck", "pnpm", ["run", "typecheck"]],
  ["S11-docs", pythonCommand, ["scripts/check_docs.py"]]
]) await command(id, commandName, args);

async function runDevice(platform) {
  const result = await run("pnpm", ["test:device", "--", "--platform", platform]);
  const combined = `${result.stdout}\n${result.stderr}`;
  const marker = [...combined.matchAll(/S11_DEVICE_RESULT\s+(\{[^\n]+\})/g)].at(-1)?.[1];
  if (!marker) {
    record(`S11-${platform}-device`, "failed", `pnpm test:device -- --platform ${platform}`, [], redact(combined).trim().slice(-4_000));
    return;
  }
  let payload;
  try {
    payload = JSON.parse(marker);
  } catch {
    record(`S11-${platform}-device`, "failed", `pnpm test:device -- --platform ${platform}`, [], "device runner returned malformed result JSON");
    return;
  }
  const status = payload.status === "passed" || payload.status === "not_run" || payload.status === "failed" ? payload.status : "failed";
  const reason = status === "failed"
    ? payload.reason ?? redact(combined).trim().slice(-4_000)
    : payload.reason;
  record(`S11-${platform}-device`, status, `pnpm test:device -- --platform ${platform}`, payload.evidence ?? [], reason, payload.details);
}

await runDevice("android");
await runDevice("ios");

const failed = checks.some((check) => check.status === "failed");
const notRun = checks.some((check) => check.status === "not_run");
const report = {
  stage: "S11",
  status: failed ? "failed" : notRun ? "blocked" : "passed",
  commit: "working-tree",
  environment: {
    os: process.platform,
    node: process.version,
    sdk: "0.85.1",
    npmRegistry: environment.NPM_CONFIG_REGISTRY,
    dockerRegistryMirror: environment.DOCKER_REGISTRY_MIRROR,
    android: null,
    ios: null
  },
  checks,
  limitations: [
    "The repeatable S11 E2E tests use a real temporary SQLite database, Fastify WebSocket server, deterministic mobile socket and real Linux child-process SIGKILL probes; they do not replace a real provider stream or a physical-device network transition.",
    "Maestro flows are only executed when an authorized Android device / booted iOS simulator, a device-reachable HTTPS server, a one-time pairing token and synthetic prompt inputs are supplied.",
    "A missing device or missing live configuration is reported as not_run and keeps the stage blocked; it is never converted to passed.",
    "No credentials, pairing tokens, prompts, session JSONL, database contents or device serials are written to this report."
  ]
};
await writeFile(join(resultsDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
if (report.status !== "passed") process.exitCode = 1;
