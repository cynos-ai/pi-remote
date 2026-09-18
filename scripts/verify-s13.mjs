import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const resultsDir = join(root, "test-results", "s13");
await mkdir(resultsDir, { recursive: true });

const environment = {
  ...process.env,
  CI: process.env.CI ?? "1",
  NPM_CONFIG_REGISTRY: "https://registry.npmmirror.com",
  DOCKER_REGISTRY_MIRROR: "docker.m.daocloud.io"
};
const checks = [];

function redact(value) {
  let result = String(value ?? "");
  for (const key of [
    "PI_REMOTE_LIVE_AGENT_DIR",
    "PI_REMOTE_LIVE_PROVIDER",
    "PI_REMOTE_LIVE_MODEL",
    "PI_REMOTE_LIVE_THINKING_PROVIDER",
    "PI_REMOTE_LIVE_THINKING_MODEL",
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

function tail(value, maximum = 2_000) {
  const clean = redact(value).trim();
  return clean.length <= maximum ? clean : clean.slice(-maximum);
}

function record(id, status, command, evidence = [], reason) {
  const check = { id, status, command, evidence };
  if (reason) check.reason = redact(reason);
  checks.push(check);
  console.log(`${status.toUpperCase()} ${id}${reason ? `: ${redact(reason).slice(-240)}` : ""}`);
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd: root,
      env: options.env ?? environment,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolvePromise(result);
    };
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => finish({ code: 1, signal: null, stdout, stderr: String(error) }));
    child.once("close", (code, signal) => finish({ code: code ?? 1, signal, stdout, stderr }));
    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        child.kill("SIGTERM");
        setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }, 2_000).unref?.();
        finish({ code: 124, signal: "SIGTERM", stdout, stderr: `${stderr}\ncommand timed out after ${options.timeoutMs}ms` });
      }, options.timeoutMs);
    }
  });
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function requireStageReport(stage) {
  const path = join(root, "test-results", stage.toLowerCase(), "report.json");
  const report = await readJson(path);
  if (report === null) {
    record(`S13-report-${stage}`, "failed", path, [], "required stage report is missing or invalid; run that stage verifier first");
    return;
  }
  const statuses = Array.isArray(report.checks) ? report.checks.map((check) => check?.status) : [];
  if (report.status === "passed" && statuses.every((status) => status === "passed")) {
    record(`S13-report-${stage}`, "passed", path, [`${statuses.length} checks passed`]);
  } else if (report.status === "failed" || statuses.includes("failed")) {
    record(`S13-report-${stage}`, "failed", path, [], `stage report status is ${report.status ?? "unknown"}`);
  } else {
    record(`S13-report-${stage}`, "not_run", path, [], `stage report status is ${report.status ?? "unknown"}; external or required checks remain`);
  }
}

async function runLocalE2e() {
  const result = await run("pnpm", ["test:e2e"], { timeoutMs: 240_000 });
  record(
    "S13-real-process-e2e",
    result.code === 0 ? "passed" : "failed",
    "pnpm test:e2e",
    result.code === 0 ? ["actual server/worker", "SQLite/JSONL", "HTTPS/WSS", "external process fault injection"] : [],
    result.code === 0 ? undefined : tail(`${result.stdout}\n${result.stderr}`)
  );
}

async function runReportBackedCommand(id, command, args, reportPath, options = {}) {
  const result = await run(command, args, options);
  const report = await readJson(reportPath);
  if (report?.status === "passed" && result.code === 0) {
    record(id, "passed", [command, ...args].join(" "), report.evidence ?? ["command report"]);
  } else if (report?.status === "blocked" || report?.status === "not_run") {
    record(id, "not_run", [command, ...args].join(" "), report.evidence ?? [], report.limitations?.join("; ") || `runner status is ${report.status}`);
  } else {
    record(id, "failed", [command, ...args].join(" "), [], tail(`${result.stdout}\n${result.stderr}`));
  }
}

async function runDevice(platform) {
  const command = `pnpm test:device -- --platform ${platform}`;
  const result = await run("pnpm", ["test:device", "--", "--platform", platform], { timeoutMs: 900_000 });
  const match = `${result.stdout}\n${result.stderr}`.match(/S11_DEVICE_RESULT\s+(\{.*\})/s);
  const payload = (() => {
    try { return match ? JSON.parse(match[1]) : null; } catch { return null; }
  })();
  if (payload?.status === "passed" && result.code === 0) {
    record(`S13-${platform}-device`, "passed", command, payload.evidence ?? [], payload.reason);
  } else if (payload?.status === "not_run") {
    record(`S13-${platform}-device`, "not_run", command, payload.evidence ?? [], payload.reason);
  } else {
    record(`S13-${platform}-device`, "failed", command, [], payload?.reason ?? tail(`${result.stdout}\n${result.stderr}`));
  }
}

for (const stage of ["S01", "S02", "S03", "S04", "S05", "S06", "S07", "S08", "S09", "S10", "S11", "S12"]) {
  await requireStageReport(stage);
}
try {
  await access(join(root, "docs", "release-readiness.md"));
  record("S13-release-readiness", "passed", "docs/release-readiness.md", ["release scope and remaining evidence are documented"]);
} catch {
  record("S13-release-readiness", "failed", "docs/release-readiness.md", [], "release readiness document is missing");
}

await runLocalE2e();
await runReportBackedCommand(
  "S13-bash-deterministic-smoke",
  "pnpm",
  ["test:bash-parity", "--", "--target", "sdk"],
  join(root, "test-results", "parity-bash-sdk", "report.json")
);
await runReportBackedCommand(
  "S13-live-provider",
  "pnpm",
  ["test:live", "--", "--suite", "sdk"],
  join(root, "test-results", "live-sdk", "report.json")
);
await runReportBackedCommand(
  "S13-native-tui",
  "pnpm",
  ["test:tui-parity", "--", "--target", "sdk"],
  join(root, "test-results", "parity-tui-sdk", "report.json")
);
await runDevice("android");
await runDevice("ios");

const report = {
  stage: "S13",
  status: checks.some((check) => check.status === "failed")
    ? "failed"
    : checks.some((check) => check.status === "not_run") ? "blocked" : "passed",
  commit: "working-tree",
  environment: {
    os: process.platform,
    node: process.version,
    sdk: "0.85.1",
    npmRegistry: environment.NPM_CONFIG_REGISTRY,
    dockerRegistryMirror: environment.DOCKER_REGISTRY_MIRROR
  },
  checks,
  limitations: [
    "S13 does not publish an image, package, app, store listing, or external release.",
    "A passed local E2E or deterministic Bash smoke cannot replace live provider, native TUI, or physical Android/iOS evidence.",
    "No credential, pairing token, auth.json, session JSONL, SQLite bytes, or command response body is written to this report."
  ]
};
await writeFile(join(resultsDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
console.log(`S13 ${report.status.toUpperCase()}`);
if (report.status !== "passed") process.exitCode = 1;
