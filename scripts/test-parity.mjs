import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const kind = process.argv[2] ?? "bash";
const target = process.argv.includes("--target") ? process.argv[process.argv.indexOf("--target") + 1] : undefined;
const reportDir = join(root, "test-results", `parity-${kind}-${target ?? "default"}`);
await mkdir(reportDir, { recursive: true });

function spawnCapture(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
  });
}

const report = {
  kind,
  target,
  status: "not_run",
  environment: { os: process.platform, node: process.version, sdk: "0.85.1" },
  checks: [],
  limitations: []
};

try {
  if (target !== "sdk") throw new Error("S02 parity entrypoint currently supports only --target sdk");
  const api = await import(pathToFileURL(join(root, "packages", "agent-pi", "dist", "index.js")).href);
  const fixtureRoot = await mkdtemp(join(root, "test-results", `parity-${kind}-fixture-`));
  const input = {
    root: fixtureRoot,
    project: join(fixtureRoot, "project"),
    agentDir: join(fixtureRoot, "agent"),
    sessionDir: join(fixtureRoot, "sessions")
  };
  await Promise.all([mkdir(input.project), mkdir(input.agentDir), mkdir(input.sessionDir)]);
  try {
    if (kind !== "bash") {
      throw new Error("a real interactive pi TUI capture is required for TUI parity; this script does not fabricate one");
    }
    const handle = await api.createPiAgentSession({
      cwd: input.project,
      agentDir: input.agentDir,
      sessionDir: input.sessionDir,
      noTools: "all",
      resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true }
    });
    try {
      const command = "printf 'sdk-parity\\n' | tr a-z A-Z > parity.txt && cat parity.txt";
      const native = await spawnCapture("/bin/bash", ["-lc", command], { cwd: input.project });
      const sdkResult = await handle.session.executeBash(command);
      assert.equal(native.code, sdkResult.exitCode);
      assert.equal(native.stdout, sdkResult.output);
      report.checks.push({ id: "B01-deterministic-shell-semantics", status: "passed", evidence: ["SDK executeBash", "direct Linux bash", "pipeline/redirection/compound command"] });
    } finally {
      handle.dispose();
    }
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
  report.status = "passed";
  report.limitations.push("This is a deterministic SDK-vs-/bin/bash smoke, not the required live model and native interactive TUI comparison.");
} catch (error) {
  report.status = "blocked";
  report.limitations.push(error instanceof Error ? error.message : String(error));
}

console.log(`${report.status.toUpperCase()} ${kind} parity${report.limitations.length ? `: ${report.limitations.join("; ")}` : ""}`);
await import("node:fs/promises").then(({ writeFile }) => writeFile(join(reportDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8"));
if (report.status !== "passed") process.exitCode = 1;
