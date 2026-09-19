import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { aggregate, importEvidence, parityTargets, plan, sourceIdentity } from "./acceptance-evidence.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const kind = process.argv[2] ?? "bash";
const target = process.argv.includes("--target") ? process.argv[process.argv.indexOf("--target") + 1] : "sdk";
const smoke = process.argv.includes("--smoke");
if (!["bash", "tui"].includes(kind) || !parityTargets.includes(target) || (smoke && (kind !== "bash" || target !== "sdk"))) {
  console.error("use bash|tui with --target sdk|runtime|commands|realtime|docker; --smoke is only bash/sdk");
  process.exit(2);
}
const scope = `parity-${kind}-${target}`;
const identity = await sourceIdentity();
if (process.argv.includes("--plan")) {
  console.log(JSON.stringify(plan(scope, identity), null, 2));
  process.exit(0);
}
const reportDir = join(process.env.PI_REMOTE_ACCEPTANCE_REPORT_DIR || join(root, "test-results"), `${scope}${smoke ? "-smoke" : ""}`);
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
  schemaVersion: 1, scope: smoke ? `${scope}-smoke` : scope, ...identity, recordedAt: new Date().toISOString(),
  kind,
  target,
  status: "not_run",
  environment: { os: process.platform, node: process.version, sdk: "0.85.1" },
  checks: [],
  limitations: []
};

try {
  if (!smoke) {
    const index = process.argv.indexOf("--evidence");
    const evidencePath = index >= 0 ? process.argv[index + 1] : process.env.PI_REMOTE_ACCEPTANCE_EVIDENCE_DIR ? join(process.env.PI_REMOTE_ACCEPTANCE_EVIDENCE_DIR, `${scope}.json`) : undefined;
    report.checks = await importEvidence(evidencePath, scope, identity);
  } else if (process.platform !== "linux") {
    report.checks.push({ id: "B01-deterministic-shell-semantics", status: "not_run", evidence: [], reason: "environment: Linux is required" });
  } else {
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
  }
} catch {
  report.checks.push({ id: "parity-runner", status: "failed", evidence: [], reason: `${smoke ? "execution" : "evidence"}: failed; inspect private captures/configuration locally` });
}
report.status = aggregate(report.checks);
report.limitations.push(smoke ? "Deterministic SDK-vs-Bash smoke only; never a full parity report." : "Operator-recorded comparisons require native and application captures with matching environment. Validation checks coverage/provenance, not the truth of human observations. No automatic TUI interaction is claimed.");

console.log(`${report.status.toUpperCase()} ${kind} parity${report.limitations.length ? `: ${report.limitations.join("; ")}` : ""}`);
await import("node:fs/promises").then(({ writeFile }) => writeFile(join(reportDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8"));
if (report.status !== "passed") process.exitCode = 1;
