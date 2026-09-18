import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const resultsDir = join(root, "test-results", "s09");
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
  "apps/mobile/App.tsx",
  "apps/mobile/src/api/client.ts",
  "apps/mobile/src/storage/credentials.ts",
  "apps/mobile/src/storage/secure-store.ts",
  "apps/mobile/src/storage/local-cache.ts",
  "apps/mobile/src/app-model.ts",
  "apps/mobile/metro.config.js",
  ".maestro/s09-resources.yaml",
  "tests/mobile/api.test.ts",
  "tests/mobile/credentials.test.ts",
  "tests/mobile/cache.test.ts",
  "tests/mobile/app-model.test.ts"
];
for (const relativePath of requiredFiles) {
  try {
    await access(join(root, relativePath));
    record(`S09-file-${relativePath}`, "passed", relativePath);
  } catch {
    record(`S09-file-${relativePath}`, "failed", relativePath, [], "required S09 file is missing");
  }
}

const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
record(
  "S09-script-entry",
  packageJson.scripts?.["verify:S09"] === "node scripts/verify-s09.mjs" ? "passed" : "failed",
  "package.json#scripts.verify:S09",
  [],
  packageJson.scripts?.["verify:S09"] === "node scripts/verify-s09.mjs" ? undefined : "verify:S09 is not registered"
);

const npmrc = await readFile(join(root, ".npmrc"), "utf8");
const domesticSources = npmrc.includes("registry=https://registry.npmmirror.com")
  && environment.NPM_CONFIG_REGISTRY === "https://registry.npmmirror.com"
  && environment.DOCKER_REGISTRY_MIRROR === "docker.m.daocloud.io";
record(
  "S09-domestic-sources",
  domesticSources ? "passed" : "failed",
  ".npmrc + NPM_CONFIG_REGISTRY + DOCKER_REGISTRY_MIRROR",
  [String(environment.NPM_CONFIG_REGISTRY), String(environment.DOCKER_REGISTRY_MIRROR)],
  domesticSources ? undefined : "npm and Docker sources must use the project domestic mirrors"
);

const nodeMajor = Number(process.versions.node.split(".")[0]);
record(
  "S09-node-runtime",
  nodeMajor === 24 ? "passed" : "failed",
  "node --version",
  [process.version],
  nodeMajor === 24 ? undefined : "S09 uses the project Node 24 baseline"
);

const protocolBuild = await command("S09-protocol-build", "pnpm", ["--filter", "@pi-remote/protocol", "build"], ["shared HTTP and snapshot schemas"]);
if (protocolBuild.code === 0) {
  await command("S09-mobile-components", "pnpm", [
    "exec", "vitest", "run", "--config", "vitest.config.mjs", "tests/mobile"
  ], [
    "HTTPS-only API and protocol response validation",
    "credential parsing and secure-storage adapter boundary",
    "real temporary SQLite cache account isolation and atomic cursor commits",
    "pagination de-duplication, state labels, and offline view model"
  ]);
} else {
  record("S09-mobile-components", "not_run", "pnpm exec vitest run --config vitest.config.mjs tests/mobile", [], "protocol build failed");
}

for (const [id, args, evidence] of [
  ["S09-android-js", ["run", "build:android"], ["Android JavaScript bundle"]],
  ["S09-ios-js", ["run", "build:ios"], ["iOS JavaScript bundle"]]
]) {
  await command(id, "pnpm", args, evidence);
}

for (const [id, commandName, args] of [
  ["S09-lint", "pnpm", ["run", "lint"]],
  ["S09-typecheck", "pnpm", ["run", "typecheck"]],
  ["S09-docs", pythonCommand, ["scripts/check_docs.py"]]
]) {
  await command(id, commandName, args);
}

const deviceTestRequested = process.env.PI_REMOTE_RUN_DEVICE_TESTS === "1";
const hasMaestro = (await run("maestro", ["--version"])).code === 0;
const hasAdb = (await run("adb", ["devices"])).code === 0;
const hasIosRunner = (await run("xcrun", ["simctl", "list", "devices", "available"])).code === 0;
if (deviceTestRequested && hasMaestro && hasAdb) {
  await command("S09-maestro-android", "maestro", ["test", ".maestro/s09-resources.yaml"], [
    "real HTTPS pairing",
    "real project and Session resource API",
    "rename and archive / restore flow"
  ]);
} else {
  record(
    "S09-android-device",
    "not_run",
    "maestro test .maestro/s09-resources.yaml",
    [],
    deviceTestRequested
      ? "Maestro and an Android device/emulator are required; no runnable pair was detected"
      : "real Android emulator/device execution was not requested or is not available in this WSL environment"
  );
}
record(
  "S09-ios-device",
  "not_run",
  "maestro test .maestro/s09-resources.yaml --platform ios",
  [],
  hasIosRunner
    ? "iOS simulator execution still needs a built/installable app and a configured real resource backend"
    : "Xcode / iOS simulator is not available in this WSL environment"
);

const failed = checks.some((check) => check.status === "failed");
const notRun = checks.some((check) => check.status === "not_run");
const report = {
  stage: "S09",
  status: failed ? "failed" : notRun ? "blocked" : "passed",
  commit: "working-tree",
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
    "S09 contract tests use a fake fetch transport and a real temporary SQLite file; they do not replace a physical-device resource API run.",
    "Android / iOS JS exports are not native compilation or final device evidence.",
    "No credentials, pairing tokens, prompts, session JSONL, or database contents are written to this report."
  ]
};
await writeFile(join(resultsDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
if (report.status !== "passed") process.exitCode = 1;
