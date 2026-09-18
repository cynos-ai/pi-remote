import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const resultsDir = join(root, "test-results", "s03");
await mkdir(resultsDir, { recursive: true });

const checks = [];
function record(id, status, command, evidence = [], reason) {
  const check = { id, status, command, evidence };
  if (reason) check.reason = reason;
  checks.push(check);
  console.log(`${status.toUpperCase()} ${id}${reason ? `: ${reason}` : ""}`);
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

async function command(id, commandName, args, evidence = []) {
  const result = await run(commandName, args);
  if (result.code === 0) {
    record(id, "passed", [commandName, ...args].join(" "), evidence);
  } else {
    record(id, "failed", [commandName, ...args].join(" "), [], `${result.stdout}\n${result.stderr}`.trim());
  }
  return result;
}

const packageJson = JSON.parse(await readFile(join(root, "packages", "protocol", "package.json"), "utf8"));
record(
  "S03-protocol-sdk-boundary",
  packageJson.dependencies?.["@earendil-works/pi-coding-agent"] === undefined ? "passed" : "failed",
  "packages/protocol/package.json",
  ["protocol has no direct pi SDK dependency"]
);
record(
  "S03-protocol-runtime-schema",
  packageJson.dependencies?.zod === "4.6.2" ? "passed" : "failed",
  "packages/protocol/package.json",
  ["zod@4.6.2"]
);

const build = await command("S03-protocol-build", "pnpm", ["--filter", "@pi-remote/protocol", "build"], ["packages/protocol/dist"]);
if (build.code === 0) {
  const tests = await command(
    "S03-reducer-contract",
    "pnpm",
    ["run", "test:unit", "--", "tests/protocol/reducer.test.ts"],
    ["stream", "interrupted", "initialization", "native-runtime", "sequence-gap"]
  );
  if (tests.code !== 0) process.exitCode = 1;
} else {
  record("S03-reducer-contract", "not_run", "pnpm run test:unit -- tests/protocol/reducer.test.ts", [], "protocol build failed");
  process.exitCode = 1;
}

const report = {
  stage: "S03",
  status: checks.some((check) => check.status === "failed") ? "failed" : "passed",
  commit: "working-tree",
  environment: { os: process.platform, node: process.version, sdk: "0.85.1", device: null },
  checks,
  limitations: [
    "S03 verifies the public DTO schemas and pure reducer with synthetic fixtures; it does not claim SQLite, HTTP, WSS, worker, model, or device behavior.",
    "Runtime error payloads intentionally allow code-only asynchronous failures; synchronous HTTP error responses retain requestId and message requirements."
  ]
};
await writeFile(join(resultsDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
if (report.status !== "passed") process.exitCode = 1;

