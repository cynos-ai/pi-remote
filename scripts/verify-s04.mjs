import { sourceIdentity } from "./acceptance-evidence.mjs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const resultsDir = join(root, "test-results", "s04");
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
    const output = `${result.stdout}\n${result.stderr}`.trim().slice(-4000);
    record(id, "failed", [commandName, ...args].join(" "), [], output);
  }
  return result;
}

const nodeMajor = Number(process.versions.node.split(".")[0]);
record("S04-node-sqlite-runtime", nodeMajor === 24 ? "passed" : "failed", "node --version", [process.version]);

const migration = await readFile(join(root, "apps", "server", "src", "storage", "migrations", "001-initial.sql"), "utf8");
const requiredTables = ["users", "projects", "sessions", "commands", "runs", "events", "ipc_batches", "timeline_items", "interactions", "artifacts"];
const missingTables = requiredTables.filter((table) => !new RegExp(`CREATE TABLE ${table}\\b`).test(migration));
record(
  "S04-reference-migration",
  missingTables.length === 0 ? "passed" : "failed",
  "apps/server/src/storage/migrations/001-initial.sql",
  missingTables.length === 0 ? requiredTables : [],
  missingTables.length === 0 ? undefined : `missing tables: ${missingTables.join(", ")}`
);

try {
  await access(join(root, "tests", "storage", "storage.test.ts"));
  record("S04-storage-tests-present", "passed", "tests/storage/storage.test.ts");
} catch {
  record("S04-storage-tests-present", "failed", "tests/storage/storage.test.ts", [], "storage contract tests are missing");
}

const build = await command("S04-build-server", "pnpm", ["run", "build:server"], ["apps/server/dist", "apps/server/dist/storage/migrations/001-initial.sql"]);
if (build.code === 0) {
  const tests = await command(
    "S04-storage-contract",
    "pnpm",
    ["run", "test:unit", "--", "tests/storage/storage.test.ts"],
    ["real file SQLite", "WAL/foreign_keys", "IPC epoch+batch", "rollback", "snapshot/history", "owner/path invariants"]
  );
  if (tests.code !== 0) process.exitCode = 1;
} else {
  record("S04-storage-contract", "not_run", "pnpm run test:unit -- tests/storage/storage.test.ts", [], "server build failed");
  process.exitCode = 1;
}

for (const [id, commandName, args] of [
  ["S04-lint", "pnpm", ["run", "lint"]],
  ["S04-typecheck", "pnpm", ["run", "typecheck"]],
  ["S04-docs", "python3", ["scripts/check_docs.py"]]
]) {
  const result = await command(id, commandName, args);
  if (result.code !== 0) process.exitCode = 1;
}

try {
  await access(join(root, "apps", "server", "dist", "storage", "migrations", "001-initial.sql"));
  record("S04-migration-build-asset", "passed", "apps/server/dist/storage/migrations/001-initial.sql");
} catch {
  record("S04-migration-build-asset", "failed", "apps/server/dist/storage/migrations/001-initial.sql", [], "server build did not copy migration assets");
  process.exitCode = 1;
}

const report = {
  stage: "S04",
  status: checks.some((check) => check.status === "failed") || process.exitCode
    ? "failed"
    : checks.some((check) => check.status === "not_run")
      ? "blocked"
      : "passed",
  ...(await sourceIdentity()),
  environment: { os: process.platform, node: process.version, sqlite: "node:sqlite", device: null },
  checks,
  limitations: [
    "S04 verifies the storage contract with temporary Linux SQLite files and synthetic protocol events; HTTP, WSS, workers, live models, Docker, and devices remain later stages.",
    "Artifact tests verify metadata/path safety only; atomic output-file streaming and download authorization are completed with the artifact API in later stages."
  ]
};
await writeFile(join(resultsDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
if (report.status !== "passed") process.exitCode = 1;
