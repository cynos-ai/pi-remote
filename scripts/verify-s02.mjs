import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { consumeReport, sourceIdentity } from "./acceptance-evidence.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const resultsDir = join(root, "test-results", "s02");
await mkdir(resultsDir, { recursive: true });

const checks = [];
function record(id, status, command, evidence = [], reason) {
  const check = { id, status, command, evidence };
  if (reason) check.reason = reason;
  checks.push(check);
  const suffix = reason ? `: ${reason}` : "";
  console.log(`${status.toUpperCase()} ${id}${suffix}`);
}

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const executable = process.platform === "win32" && command === "pnpm" ? "pnpm.cmd" : command;
    const child = spawn(executable, args, {
      cwd: root,
      env: { ...process.env, CI: process.env.CI ?? "1" },
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

const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor === 24) {
  record("S02-toolchain-node", "passed", "node --version", [process.version]);
} else {
  record("S02-toolchain-node", "failed", "node --version", [], `expected Node 24, got ${process.version}`);
}

const acceptance = await run("pnpm", ["test:acceptance"]);
record("S02-acceptance-runner-contract", acceptance.code === 0 ? "passed" : "failed", "pnpm test:acceptance", ["evidence validation and CLI negative cases"], acceptance.code === 0 ? undefined : "acceptance runner regression failed");

const packageJson = JSON.parse(await readFile(join(root, "packages", "agent-pi", "package.json"), "utf8"));
if (packageJson.dependencies?.["@earendil-works/pi-coding-agent"] === "0.85.1") {
  record("S02-sdk-version", "passed", "packages/agent-pi/package.json", ["@earendil-works/pi-coding-agent@0.85.1"]);
} else {
  record("S02-sdk-version", "failed", "packages/agent-pi/package.json", [], "SDK version or dependency boundary changed");
}

const build = await run("pnpm", ["run", "build:packages"]);
if (build.code === 0) {
  record("S02-build-agent-package", "passed", "pnpm run build:packages");
} else {
  record("S02-build-agent-package", "failed", "pnpm run build:packages", [], `${build.stdout}\n${build.stderr}`);
}

if (build.code === 0) {
  const api = await import(pathToFileURL(join(root, "packages", "agent-pi", "dist", "index.js")).href);
  const { runSdkBoundarySuite } = await import(pathToFileURL(join(root, "tests", "sdk", "s02-boundary.mjs")).href);
  for (const result of await runSdkBoundarySuite(api)) {
    record(result.name, result.status, "tests/sdk/s02-boundary.mjs", [], result.details);
  }

  const capabilities = api.getNativeCapabilities();
  const capabilityIds = new Set(capabilities.map((capability) => capability.id));
  const hasAdapterItems = capabilities.some((capability) => capability.status === "needs_adapter");
  if (capabilities.length >= 10 && capabilityIds.has("bash.native-executor") && hasAdapterItems) {
    record("S02-capability-inventory", "passed", "getNativeCapabilities()", [`${capabilities.length} capabilities`]);
  } else {
    record("S02-capability-inventory", "failed", "getNativeCapabilities()", [], "inventory is incomplete or hides adapter work");
  }
}

const identity = await sourceIdentity();
for (const [id, scope] of [
  ["AT02-AT03-AT26-live-sdk", "live-sdk"],
  ["AT31-sdk-bash-parity", "parity-bash-sdk"],
  ["AT32-sdk-tui-parity", "parity-tui-sdk"]
]) {
  const result = await consumeReport(scope, identity);
  record(id, result.status, `test-results/${scope}/report.json`, result.evidence, result.reason);
}

try {
  await access(join(root, "packages", "agent-pi", "dist", "index.js"));
} catch {
  record("S02-agent-dist", "failed", "packages/agent-pi/dist/index.js", [], "agent package build output is missing");
}

const report = {
  stage: "S02",
  status: checks.some((check) => check.status === "failed")
    ? "failed"
    : checks.some((check) => check.status === "not_run")
      ? "blocked"
      : "passed",
  ...(await sourceIdentity()),
  environment: {
    os: process.platform,
    node: process.version,
    sdk: "0.85.1",
    device: null
  },
  checks,
  limitations: [
    "S02 contract smoke uses the real SDK without a model; it does not replace a real provider prompt.",
    "Live model, thinking, retry/compaction, native TUI, long Bash, and device baselines remain not_run until external configuration is supplied.",
    "The report contains no model credentials or session content."
  ]
};
await writeFile(join(resultsDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
if (report.status !== "passed") process.exitCode = 1;
