import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const resultsDir = join(root, "test-results", "s01");
await mkdir(resultsDir, { recursive: true });

const checks = [];
const record = (name, status, details = "") => {
  checks.push({ name, status, details });
  if (status === "failed") {
    console.error(`FAIL ${name}${details ? `: ${details}` : ""}`);
  } else {
    console.log(`${status.toUpperCase()} ${name}${details ? `: ${details}` : ""}`);
  }
};

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const executable = process.platform === "win32" && command === "pnpm" ? "pnpm.cmd" : command;
    const child = spawn(executable, args, {
      cwd: root,
      env: { ...process.env, CI: process.env.CI ?? "1" },
      shell: process.platform === "win32" && command === "pnpm",
      stdio: options.capture === false ? "inherit" : ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code, signal) => resolvePromise({ code: code ?? 1, signal, stdout, stderr }));
  });
}

async function command(name, commandName, args) {
  const result = await run(commandName, args);
  if (result.code === 0) {
    record(name, "passed");
  } else {
    record(name, "failed", `${commandName} ${args.join(" ")} exited ${result.code}\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

const nodeMajor = Number(process.versions.node.split(".")[0]);
record("Node 24 toolchain", nodeMajor === 24 ? "passed" : "failed", process.version);

const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
record("pnpm workspace manifest", packageJson.packageManager === "pnpm@10.28.0" ? "passed" : "failed", packageJson.packageManager);

try {
  await access(join(root, "pnpm-lock.yaml"));
  record("frozen lockfile present", "passed");
} catch {
  record("frozen lockfile present", "failed", "pnpm-lock.yaml is missing");
}

const workspaceManifests = [
  "packages/protocol/package.json",
  "packages/agent-pi/package.json",
  "apps/server/package.json",
  "apps/mobile/package.json"
];
const manifests = await Promise.all(workspaceManifests.map(async (relativePath) => ({
  relativePath,
  json: JSON.parse(await readFile(join(root, relativePath), "utf8"))
})));
const sdkOwners = manifests.filter(({ json }) => json.dependencies?.["@earendil-works/pi-coding-agent"] === "0.85.1");
const sdkElsewhere = manifests.filter(({ json }) => json !== sdkOwners[0]?.json && (
  json.dependencies?.["@earendil-works/pi-coding-agent"] !== undefined ||
  json.devDependencies?.["@earendil-works/pi-coding-agent"] !== undefined
));
record(
  "SDK direct dependency boundary",
  sdkOwners.length === 1 && sdkOwners[0].relativePath === "packages/agent-pi/package.json" && sdkElsewhere.length === 0 ? "passed" : "failed",
  sdkOwners.map(({ relativePath }) => relativePath).join(", ") || "none"
);

const commands = [
  ["frozen install", "pnpm", ["install", "--frozen-lockfile", "--ignore-scripts", "--reporter", "append-only"]],
  ["lint", "pnpm", ["run", "lint"]],
  ["typecheck", "pnpm", ["run", "typecheck"]],
  ["unit tests", "pnpm", ["run", "test:unit"]],
  ["server and package build", "pnpm", ["run", "build:server"]],
  ["mobile JS export", "pnpm", ["run", "build:mobile"]],
  ["android JS bundle", "pnpm", ["run", "build:android"]],
  ["iOS JS bundle", "pnpm", ["run", "build:ios"]]
];
for (const [name, commandName, args] of commands) {
  const result = await command(name, commandName, args);
  if (result.code !== 0) break;
}

const port = 43127;
const server = spawn(process.execPath, [join(root, "apps/server/dist/index.js")], {
  cwd: root,
  env: {
    ...process.env,
    PI_REMOTE_HOST: "127.0.0.1",
    PI_REMOTE_PORT: String(port),
    PI_REMOTE_STATE_DIR: join(resultsDir, "state"),
    PI_REMOTE_PI_DIR: join(resultsDir, "pi"),
    PI_REMOTE_WORKSPACE_ROOT: join(resultsDir, "workspaces")
  },
  stdio: ["ignore", "pipe", "pipe"]
});
let serverOutput = "";
server.stdout?.on("data", (chunk) => { serverOutput += chunk; });
server.stderr?.on("data", (chunk) => { serverOutput += chunk; });
let health = null;
// WSL cold starts may spend several seconds loading the native SDK's ESM
// graph before Fastify can bind. Keep the probe bounded, but do not turn a
// slow first import into a false S01 failure.
for (let attempt = 0; attempt < 600; attempt += 1) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`);
    health = { status: response.status, body: await response.json() };
    break;
  } catch {
    await delay(100);
  }
}
if (health?.status === 200 && health.body?.status === "ok") {
  record("server healthz", "passed", JSON.stringify(health.body));
} else {
  record("server healthz", "failed", `${JSON.stringify(health)}\n${serverOutput}`);
}
server.kill();

const report = {
  stage: "S01",
  status: checks.some((check) => check.status === "failed") ? "failed" : "passed",
  commit: "working-tree",
  environment: {
    os: process.platform,
    node: process.version,
    sdk: "0.85.1",
    device: null
  },
  checks,
  limitations: [
    "This verifies the S01 skeleton and JavaScript bundles only; it is not native Android/iOS device acceptance.",
    "S02 live SDK and TUI parity suites are not part of S01."
  ]
};
await writeFile(join(resultsDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
if (report.status !== "passed") process.exitCode = 1;
