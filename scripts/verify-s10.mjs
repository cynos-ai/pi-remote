import { sourceIdentity } from "./acceptance-evidence.mjs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const resultsDir = join(root, "test-results", "s10");
const pythonCommand = process.env.PI_REMOTE_PYTHON ?? (process.platform === "win32" ? "python" : "python3");
const environment = {
  ...process.env,
  CI: process.env.CI ?? "1",
  NPM_CONFIG_REGISTRY: process.env.NPM_CONFIG_REGISTRY ?? "https://registry.npmmirror.com",
  DOCKER_REGISTRY_MIRROR: process.env.DOCKER_REGISTRY_MIRROR ?? "docker.m.daocloud.io"
};
await mkdir(resultsDir, { recursive: true });

const checks = [];
function record(id, status, command, evidence = [], reason) {
  const check = { id, status, command, evidence };
  if (reason) check.reason = reason;
  checks.push(check);
  console.log(`${status.toUpperCase()} ${id}${reason ? `: ${reason}` : ""}`);
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
    child.on("close", (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
  });
}

async function command(id, commandName, args, evidence = []) {
  const result = await run(commandName, args);
  const rendered = [commandName, ...args].join(" ");
  if (result.code === 0) record(id, "passed", rendered, evidence);
  else record(id, "failed", rendered, [], `${result.stdout}\n${result.stderr}`.trim().slice(-4000));
  return result;
}

for (const relativePath of [
  "apps/mobile/App.tsx",
  "apps/mobile/src/api/client.ts",
  "apps/mobile/src/realtime.ts",
  "apps/mobile/src/session-model.ts",
  "tests/mobile/api.test.ts",
  "tests/mobile/realtime.test.ts",
  "tests/mobile/session-model.test.ts"
]) {
  try {
    await access(join(root, relativePath));
    record(`S10-file-${relativePath}`, "passed", relativePath);
  } catch {
    record(`S10-file-${relativePath}`, "failed", relativePath, [], "required S10 file is missing");
  }
}

const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const script = packageJson.scripts?.["verify:S10"];
record(
  "S10-script-entry",
  script === "node scripts/verify-s10.mjs" ? "passed" : "failed",
  "package.json#scripts.verify:S10",
  [],
  script === "node scripts/verify-s10.mjs" ? undefined : "verify:S10 is not registered"
);

const npmrc = await readFile(join(root, ".npmrc"), "utf8");
const domesticSources = npmrc.includes("registry=https://registry.npmmirror.com")
  && environment.NPM_CONFIG_REGISTRY === "https://registry.npmmirror.com"
  && environment.DOCKER_REGISTRY_MIRROR === "docker.m.daocloud.io";
record(
  "S10-domestic-sources",
  domesticSources ? "passed" : "failed",
  ".npmrc + NPM_CONFIG_REGISTRY + DOCKER_REGISTRY_MIRROR",
  [String(environment.NPM_CONFIG_REGISTRY), String(environment.DOCKER_REGISTRY_MIRROR)],
  domesticSources ? undefined : "npm and Docker sources must use the project domestic mirrors"
);

const nodeMajor = Number(process.versions.node.split(".")[0]);
record("S10-node-runtime", nodeMajor === 24 ? "passed" : "failed", "node --version", [process.version], nodeMajor === 24 ? undefined : "S10 uses the project Node 24 baseline");
await command("S10-protocol-build", "pnpm", ["--filter", "@pi-remote/protocol", "build"], ["shared snapshot, event, command and WebSocket schemas"]);
await command("S10-mobile-contract", "pnpm", ["exec", "vitest", "run", "--config", "vitest.config.mjs", "tests/mobile"], [
  "WSS ticket authentication and Session subscription",
  "cursor de-duplication, gap resync and bounded jittered reconnect",
  "snapshot-to-reducer timeline and live tool presentation",
  "command response-loss retry with the same idempotency key",
  "pending interaction and recovered-input presentation helpers"
]);

for (const [id, args, evidence] of [
  ["S10-android-js", ["run", "build:android"], ["Android JavaScript bundle"]],
  ["S10-ios-js", ["run", "build:ios"], ["iOS JavaScript bundle"]]
]) await command(id, "pnpm", args, evidence);

for (const [id, commandName, args] of [
  ["S10-lint", "pnpm", ["run", "lint"]],
  ["S10-typecheck", "pnpm", ["run", "typecheck"]],
  ["S10-docs", pythonCommand, ["scripts/check_docs.py"]]
]) await command(id, commandName, args);

const deviceRequested = process.env.PI_REMOTE_RUN_DEVICE_TESTS === "1";
const hasAdb = (await run("adb", ["devices"])).code === 0;
const hasIosRunner = (await run("xcrun", ["simctl", "list", "devices", "available"])).code === 0;
record(
  "S10-android-device",
  "not_run",
  "S10 device timeline / command flow",
  [],
  deviceRequested && hasAdb
    ? "S10 requires an installable app, real HTTPS backend, and the S11 device fault harness; no standalone device evidence is bundled yet"
    : "Android emulator/device is not available in this WSL run"
);
record(
  "S10-ios-device",
  "not_run",
  "S10 device timeline / command flow",
  [],
  deviceRequested && hasIosRunner
    ? "S10 requires an installable app, real HTTPS backend, and the S11 device fault harness; no standalone device evidence is bundled yet"
    : "Xcode / iOS simulator is not available in this WSL run"
);

const failed = checks.some((check) => check.status === "failed");
const notRun = checks.some((check) => check.status === "not_run");
const report = {
  stage: "S10",
  status: failed ? "failed" : notRun ? "blocked" : "passed",
  ...(await sourceIdentity()),
  environment: {
    os: process.platform,
    node: process.version,
    sdk: "0.85.1",
    npmRegistry: environment.NPM_CONFIG_REGISTRY,
    dockerRegistryMirror: environment.DOCKER_REGISTRY_MIRROR,
    device: null
  },
  checks,
  limitations: [
    "Contract tests use a fake WebSocket and deterministic protocol events; they do not replace a real provider stream.",
    "The mobile attachment field accepts an existing artifact reference; binary upload and picker adaptation remain explicitly visible as a follow-up.",
    "Android / iOS JS exports and this WSL run are not physical-device evidence for AT18, AT21, AT22, AT31 or AT32.",
    "No credentials, pairing tokens, prompts, session JSONL, or database contents are written to this report."
  ]
};
await writeFile(join(resultsDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
if (report.status !== "passed") process.exitCode = 1;
