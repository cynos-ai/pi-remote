import { sourceIdentity } from "./acceptance-evidence.mjs";
import { access, mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const resultsDir = join(root, "test-results", "s05");
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
    const output = (result.stdout + "\n" + result.stderr).trim().slice(-4000);
    record(id, "failed", [commandName, ...args].join(" "), [], output);
    process.exitCode = 1;
  }
  return result;
}

const requiredFiles = [
  "apps/server/src/auth.ts",
  "apps/server/src/routes.ts",
  "apps/server/src/services/resources.ts",
  "apps/server/src/services/project-path.ts",
  "apps/server/src/services/cursors.ts",
  "apps/server/src/cli.ts",
  "tests/api/api.test.ts"
];
for (const relativePath of requiredFiles) {
  try {
    await access(join(root, relativePath));
    record("S05-file-" + relativePath, "passed", relativePath);
  } catch {
    record("S05-file-" + relativePath, "failed", relativePath, [], "required S05 file is missing");
    process.exitCode = 1;
  }
}

await command("S05-build-server", "pnpm", ["run", "build:server"], [
  "server routes",
  "auth and resource services",
  "pairing CLI"
]);
await command("S05-api-contract", "pnpm", ["run", "test:unit", "--", "tests/api/api.test.ts"], [
  "single-use pairing",
  "device revoke",
  "path and symlink validation",
  "pagination",
  "CAS",
  "archive/reopen",
  "owner isolation",
  "idempotent concurrent create"
]);
await command("S05-lint", "pnpm", ["run", "lint"]);
await command("S05-typecheck", "pnpm", ["run", "typecheck"]);
await command("S05-docs", "python3", ["scripts/check_docs.py"]);

const report = {
  stage: "S05",
  status: checks.some((check) => check.status === "failed") ? "failed" : "passed",
  ...(await sourceIdentity()),
  environment: { os: process.platform, node: process.version, sdk: "0.85.1", device: null },
  checks,
  limitations: [
    "S05 verifies HTTP resources through Fastify injection and temporary SQLite files; HTTPS/WSS, workers, live models, and real devices remain later stages.",
    "Execution commands are intentionally not advertised in capabilities until S06/S07 implements their runtime path.",
    "Artifact streaming/download and the WSS revocation close path remain later-stage work."
  ]
};
await writeFile(join(resultsDir, "report.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
if (report.status !== "passed") process.exitCode = 1;
