import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import https from "node:https";

const execFile = promisify(execFileCallback);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const resultsDir = join(root, "test-results", "s08");
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

async function httpsHealth(url) {
  return new Promise((resolvePromise, reject) => {
    const request = https.get(url, { rejectUnauthorized: false }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolvePromise({ statusCode: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
    request.setTimeout(5_000, () => request.destroy(new Error("HTTPS health check timed out")));
  });
}

async function tlsServeSmoke() {
  const fixtureRoot = await mkdtemp(join(resultsDir, "serve-fixture-"));
  const workspace = join(fixtureRoot, "workspace");
  const cert = join(fixtureRoot, "localhost.crt");
  const key = join(fixtureRoot, "localhost.key");
  await mkdir(workspace, { recursive: true });
  try {
    await execFile("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-subj", "/CN=localhost", "-keyout", key, "-out", cert, "-days", "1"
    ], { cwd: fixtureRoot, env: environment });
  } catch (error) {
    await rm(fixtureRoot, { recursive: true, force: true });
    record("S08-test-serve", "not_run", "openssl + pnpm test:serve -- --tls-cert <path> --tls-key <path>", [], `openssl is required for the reproducible TLS smoke: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const childEnv = {
    ...environment,
    PI_REMOTE_HOST: "127.0.0.1",
    PI_REMOTE_PORT: "0",
    PI_REMOTE_STATE_DIR: join(fixtureRoot, "state"),
    PI_REMOTE_PI_DIR: join(fixtureRoot, "pi"),
    PI_REMOTE_WORKSPACE_ROOT: workspace,
    PI_REMOTE_DATABASE_FILE: join(fixtureRoot, "state", "state.sqlite"),
    PI_REMOTE_OWNER_ID: "s08-serve-owner",
    PI_REMOTE_OWNER_NAME: "S08 serve owner",
    PI_REMOTE_CURSOR_SECRET: "s08-serve-cursor-secret",
    PI_REMOTE_PAIRING_TTL_SECONDS: "600",
    PI_REMOTE_LIVE_TESTS: "0"
  };
  // Spawn the script directly so cleanup can terminate the actual server
  // process in WSL; pnpm may leave its descendant alive after the wrapper is
  // signalled.
  const child = spawn(process.execPath, [
    join(root, "scripts", "test-serve.mjs"), "--tls-cert", cert, "--tls-key", key
  ], {
    cwd: root,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout?.on("data", (chunk) => { output += chunk; });
  child.stderr?.on("data", (chunk) => { output += chunk; });
  try {
    // A cold Node ESM import of the SDK through pnpm's WSL-mounted tree can
    // take tens of seconds before the server emits its readiness marker.
    const port = await new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error(`test HTTPS server did not start: ${output.slice(-4000)}`)), 60_000);
      const check = () => {
        const match = /PI_REMOTE_TEST_SERVE_URL=https:\/\/127\.0\.0\.1:(\d+)/.exec(output);
        if (match?.[1]) {
          clearTimeout(timer);
          resolvePromise(Number(match[1]));
          return;
        }
        if (child.exitCode !== null) {
          clearTimeout(timer);
          reject(new Error(`test HTTPS server exited with ${child.exitCode}: ${output.slice(-4000)}`));
          return;
        }
        setTimeout(check, 50);
      };
      check();
    });
    const health = await httpsHealth(`https://127.0.0.1:${port}/healthz`);
    const parsed = JSON.parse(health.body);
    if (health.statusCode !== 200 || parsed.status !== "ok") throw new Error(`unexpected HTTPS health response: ${health.statusCode}`);
    record("S08-test-serve", "passed", "pnpm test:serve -- --tls-cert <path> --tls-key <path>", [
      "ephemeral self-signed certificate",
      "HTTPS /healthz",
      "/v1/ws upgrade entry attached to the same TLS server"
    ]);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolvePromise) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolvePromise();
      }, 5_000);
      child.once("close", () => {
        clearTimeout(timer);
        resolvePromise();
      });
    });
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

const requiredFiles = [
  "apps/server/src/realtime/artifacts.ts",
  "apps/server/src/realtime/hub.ts",
  "apps/server/src/realtime/tickets.ts",
  "apps/server/src/realtime/index.ts",
  "scripts/test-serve.mjs",
  "tests/realtime/realtime.test.ts"
];
for (const relativePath of requiredFiles) {
  try {
    await access(join(root, relativePath));
    record(`S08-file-${relativePath}`, "passed", relativePath);
  } catch {
    record(`S08-file-${relativePath}`, "failed", relativePath, [], "required S08 file is missing");
  }
}

const nodeMajor = Number(process.versions.node.split(".")[0]);
record("S08-node-runtime", nodeMajor === 24 ? "passed" : "failed", "node --version", [process.version], nodeMajor === 24 ? undefined : "S08 uses the project Node 24 baseline");
const domesticSources = environment.NPM_CONFIG_REGISTRY === "https://registry.npmmirror.com"
  && environment.DOCKER_REGISTRY_MIRROR === "docker.m.daocloud.io";
record(
  "S08-domestic-sources",
  domesticSources ? "passed" : "failed",
  "NPM_CONFIG_REGISTRY / DOCKER_REGISTRY_MIRROR",
  [String(environment.NPM_CONFIG_REGISTRY), String(environment.DOCKER_REGISTRY_MIRROR)],
  domesticSources ? undefined : "npm and Docker sources must use the project domestic mirrors"
);

const build = await command("S08-build", "pnpm", ["run", "build"], ["protocol", "agent-pi", "server", "mobile JavaScript bundles"]);
if (build.code === 0) {
  await command("S08-realtime-contract", "pnpm", [
    "exec", "vitest", "run", "--config", "vitest.config.mjs", "tests/realtime/realtime.test.ts"
  ], [
    "one-shot ticket and device revocation",
    "Session authorization and cursor replay",
    "database tail handoff without event gaps",
    "bounded output display copy and artifact Range download",
    "slow-consumer resync without blocking execution"
  ]);
} else {
  record("S08-realtime-contract", "not_run", "pnpm exec vitest run --config vitest.config.mjs tests/realtime/realtime.test.ts", [], "full build failed");
}

await tlsServeSmoke();
for (const [id, commandName, args] of [
  ["S08-lint", "pnpm", ["run", "lint"]],
  ["S08-typecheck", "pnpm", ["run", "typecheck"]],
  ["S08-docs", pythonCommand, ["scripts/check_docs.py"]]
]) {
  await command(id, commandName, args);
}

record("S08-live-provider", "not_run", "pnpm test:live -- --suite realtime", [], "real provider credentials and a bounded live realtime harness are not configured");
record("S08-native-tui", "not_run", "pnpm test:tui-parity -- --target realtime", [], "a real Linux pi TUI baseline is not available in this WSL run");

const failed = checks.some((check) => check.status === "failed");
const notRun = checks.some((check) => check.status === "not_run");
const report = {
  stage: "S08",
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
    "The repeatable realtime tests use deterministic SQLite events and do not replace a real provider streaming run.",
    "Live provider and native pi TUI output-parity evidence remain external requirements for AT31 / AT32.",
    "No credentials, pairing tokens, prompts, session JSONL, or database contents are written to this report."
  ]
};
await (await import("node:fs/promises")).writeFile(join(resultsDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
if (report.status !== "passed") process.exitCode = 1;
