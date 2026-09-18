import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readFile as readFileAsync, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import https from "node:https";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const resultsDir = join(root, "test-results", "s12");
const composeFile = "deploy/compose.yaml";
const environment = {
  ...process.env,
  CI: process.env.CI ?? "1",
  NPM_CONFIG_REGISTRY: "https://registry.npmmirror.com",
  DOCKER_REGISTRY_MIRROR: "docker.m.daocloud.io"
};
await mkdir(resultsDir, { recursive: true });

const checks = [];
let tempRoot;
let composeProject;
let composeEnvFile;
let restoreContainerName;

function record(id, status, command, evidence = [], reason, details) {
  const check = { id, status, command, evidence };
  if (reason) check.reason = String(reason).slice(-4_000);
  if (details && typeof details === "object" && Object.keys(details).length > 0) check.details = details;
  checks.push(check);
  console.log(`${status.toUpperCase()} ${id}${reason ? `: ${String(reason).slice(-240)}` : ""}`);
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? root,
      env: options.env ?? environment,
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
  if (result.code === 0) record(id, "passed", rendered, evidence);
  else record(id, "failed", rendered, [], `${result.stdout}\n${result.stderr}`.trim());
  return result;
}

async function checkFile(relativePath) {
  try {
    await access(join(root, relativePath));
    record(`S12-file-${relativePath}`, "passed", relativePath);
  } catch {
    record(`S12-file-${relativePath}`, "failed", relativePath, [], "required S12 file is missing");
  }
}

async function freePort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise((resolvePromise) => server.close(resolvePromise));
  if (!port) throw new Error("could not reserve an ephemeral port");
  return port;
}

function composeArgs(args) {
  return ["compose", "--project-name", composeProject, "--env-file", composeEnvFile, "--file", composeFile, ...args];
}

async function compose(args) {
  return run("docker", composeArgs(args));
}

function composeCommand(args) {
  return ["docker", ...composeArgs(args)].join(" ");
}

async function dockerHostPath(path) {
  // The Docker Desktop CLI used from WSL expects Windows paths for direct
  // `docker run` bind mounts. Compose paths stay repository-relative below,
  // but backup/restore mounts need this conversion when available.
  if (process.platform !== "linux") return path;
  const converted = await run("wslpath", ["-w", path]);
  const value = converted.stdout.trim();
  return converted.code === 0 && value ? value : path;
}

async function inspectContainer(containerId) {
  const result = await run("docker", ["inspect", "--format", "{{json .}}", containerId]);
  if (result.code !== 0) throw new Error(`${result.stdout}\n${result.stderr}`.trim());
  return JSON.parse(result.stdout.trim());
}

async function composeContainer(service) {
  const result = await compose(["ps", "-q", service]);
  if (result.code !== 0) throw new Error(`${result.stdout}\n${result.stderr}`.trim());
  const id = result.stdout.trim().split(/\s+/)[0];
  return id || null;
}

async function waitForHttp(url, timeoutMs = 120_000, options = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, options);
      if (response.ok) return response;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  throw new Error(`timed out waiting for ${url}: ${lastError}`);
}

function httpsProbe(url) {
  return new Promise((resolvePromise, reject) => {
    const request = https.get(url, { rejectUnauthorized: false }, (response) => {
      response.resume();
      response.once("end", () => resolvePromise((response.statusCode ?? 0) >= 200 && (response.statusCode ?? 0) < 300));
    });
    request.once("error", reject);
    request.setTimeout(5_000, () => request.destroy(new Error("HTTPS probe timed out")));
  });
}

async function waitForHttps(url, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      if (await httpsProbe(url)) return;
      lastError = "HTTPS endpoint returned a non-2xx status";
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  throw new Error(`timed out waiting for ${url}: ${lastError}`);
}

async function jsonRequest(url, init = {}) {
  const response = await fetch(url, init);
  const body = await response.text();
  let parsed;
  try { parsed = JSON.parse(body); } catch { parsed = body; }
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${url} returned HTTP ${response.status}`);
  return parsed;
}

async function dockerLifecycle() {
  tempRoot = await mkdtemp(join(resultsDir, "docker-fixture-"));
  const workspace = join(tempRoot, "workspaces");
  const projectRoot = join(workspace, "project");
  const backupRoot = join(tempRoot, "backups");
  const restoredState = join(tempRoot, "restored-state");
  const dockerBackupRoot = await dockerHostPath(backupRoot);
  const dockerRestoredState = await dockerHostPath(restoredState);
  const dockerWorkspace = await dockerHostPath(workspace);
  await mkdir(projectRoot, { recursive: true });
  await mkdir(backupRoot, { recursive: true });
  await mkdir(restoredState, { recursive: true });
  // The fixture is disposable. World write permission makes the check work
  // even when the host's WSL uid differs from the image's fixed node uid.
  await run("chmod", ["0777", workspace, projectRoot, restoredState]);

  composeProject = `pi-remote-s12-${process.pid}-${Date.now()}`;
  const httpPort = await freePort();
  const httpsPort = await freePort();
  const restoredPort = await freePort();
  // Docker Desktop's WSL path conversion treats an absolute `/mnt/c/...`
  // argument as a Windows path with an extra `C:\\`. Keep Compose paths
  // relative to the repository working directory.
  composeEnvFile = relative(root, join(tempRoot, "compose.env"));
  const workspaceComposePath = relative(join(root, "deploy"), workspace);
  const image = `pi-remote:s12-${process.pid}-${Date.now()}`;
  const secret = `s12-${randomUUID()}-cursor-secret`;
  const envText = [
    "NPM_REGISTRY=https://registry.npmmirror.com",
    "DOCKER_REGISTRY_MIRROR=docker.m.daocloud.io",
    "NODE_IMAGE_TAG=24.19.0-bookworm-slim",
    `PI_REMOTE_IMAGE=${image}`,
    "PI_REMOTE_UID=1000",
    "PI_REMOTE_GID=1000",
    `PI_REMOTE_WORKSPACE_HOST=${workspaceComposePath}`,
    `PI_REMOTE_HTTP_PORT=${httpPort}`,
    `PI_REMOTE_HTTPS_PORT=${httpsPort}`,
    "PI_REMOTE_DOMAIN=localhost",
    "PI_REMOTE_OWNER_ID=s12-docker-owner",
    "PI_REMOTE_OWNER_NAME=S12 Docker owner",
    `PI_REMOTE_CURSOR_SECRET=${secret}`,
    "PI_REMOTE_PAIRING_TTL_SECONDS=600",
    "PI_REMOTE_WORKER_IDLE_SECONDS=0",
    "PI_REMOTE_SERIALIZE_WORKSPACE=0",
    "PI_REMOTE_MODEL_TIMEOUT_MS=15000",
    "PI_REMOTE_LOG_MAX_SIZE=10m",
    "PI_REMOTE_LOG_MAX_FILES=3",
    "PI_REMOTE_GATEWAY_LOG_MAX_SIZE=10m",
    "PI_REMOTE_GATEWAY_LOG_MAX_FILES=3",
    "PI_REMOTE_MAX_ACTIVE_RUNS=",
    "PI_REMOTE_MAX_LOADED_WORKERS=",
    "PI_REMOTE_MAX_QUEUED_COMMANDS=",
    "PI_REMOTE_ALLOWED_ORIGINS=",
    "PI_REMOTE_DEFAULT_PROVIDER=",
    "PI_REMOTE_DEFAULT_MODEL=",
    "PI_REMOTE_MODEL_HEALTH_URL="
  ].join("\n") + "\n";
  await writeFile(composeEnvFile, envText, { mode: 0o600 });

  const config = await compose(["config", "--quiet"]);
  if (config.code !== 0) throw new Error(`compose config failed: ${config.stdout}\n${config.stderr}`);
  record("S12-compose-config", "passed", composeCommand(["config", "--quiet"]), ["resolved app, gateway, named state volume and explicit workspace bind mount"]);

  const build = await compose(["build", "app"]);
  if (build.code !== 0) throw new Error(`Docker image build failed: ${build.stdout}\n${build.stderr}`);
  record("S12-docker-build", "passed", composeCommand(["build", "app"]), ["Node 24.19.0 Debian slim", "pnpm lockfile", "npmmirror dependency registry"]);

  const up = await compose(["up", "-d", "--no-build"]);
  if (up.code !== 0) throw new Error(`compose up failed: ${up.stdout}\n${up.stderr}`);
  record("S12-compose-up", "passed", composeCommand(["up", "-d", "--no-build"]), ["app and TLS gateway started"]);
  await waitForHttp(`http://127.0.0.1:${httpPort}/healthz`);
  record("S12-http-health", "passed", `GET http://127.0.0.1:${httpPort}/healthz`, ["actual container health endpoint"]);
  // The local internal certificate is issued for the configured development
  // domain (`localhost`), so keep the IP only as the transport address and
  // use the certificate name for the TLS SNI in this smoke test.
  await waitForHttps(`https://localhost:${httpsPort}/healthz`);
  record("S12-https-wss-entry", "passed", `GET https://localhost:${httpsPort}/healthz`, ["Caddy TLS internal certificate", "same reverse proxy path used by WSS"]);

  const containerId = await composeContainer("app");
  if (!containerId) throw new Error("app container id is unavailable");
  const inspected = await inspectContainer(containerId);
  const mounts = inspected.Mounts ?? [];
  const hasState = mounts.some((mount) => mount.Destination === "/state");
  const hasWorkspace = mounts.some((mount) => mount.Destination === "/workspaces");
  const hasSocket = mounts.some((mount) => mount.Destination === "/var/run/docker.sock" || String(mount.Source ?? "").includes("docker.sock"));
  const restartName = inspected.HostConfig?.RestartPolicy?.Name;
  // Docker stores Compose's `init: true` in HostConfig and the Compose stop
  // grace period in Config.StopTimeout (not the inverse fields).
  const initEnabled = inspected.HostConfig?.Init === true;
  const stopTimeout = Number(inspected.Config?.StopTimeout ?? 0);
  const nonRoot = String(inspected.Config?.User ?? "") === "1000:1000";
  if (!hasState || !hasWorkspace || hasSocket || inspected.HostConfig?.Privileged === true || restartName !== "unless-stopped" || !initEnabled || stopTimeout < 30 || !nonRoot) {
    throw new Error("container security/runtime contract failed inspection");
  }
  record("S12-container-contract", "passed", "docker inspect app", ["non-root uid/gid", "init", "45s stop timeout", "unless-stopped", "state + workspace mounts", "no privileged or Docker socket"]);

  const tools = await compose(["exec", "-T", "app", "sh", "-c", "test \"$(id -u)\" = 1000 && git --version >/dev/null && bash --version >/dev/null && node --version >/dev/null && python3 --version >/dev/null && sqlite3 --version >/dev/null"]);
  if (tools.code !== 0) throw new Error(`container toolchain check failed: ${tools.stdout}\n${tools.stderr}`);
  record("S12-container-toolchain", "passed", composeCommand(["exec", "-T", "app", "sh", "-c", "id/git/bash/node/python3/sqlite3 checks"]), ["actual non-root Linux runtime"]);
  const writeProbe = await compose(["exec", "-T", "app", "sh", "-c", "printf 'docker-host-write\\n' > /workspaces/project/container-created.txt && test -s /workspaces/project/container-created.txt"]);
  if (writeProbe.code !== 0) throw new Error(`project write probe failed: ${writeProbe.stdout}\n${writeProbe.stderr}`);
  const hostFile = await readFileAsync(join(projectRoot, "container-created.txt"), "utf8");
  if (hostFile !== "docker-host-write\n") throw new Error("host workspace did not receive the container write");
  record("S12-project-mount", "passed", composeCommand(["exec", "-T", "app", "sh", "-c", "write /workspaces/project/container-created.txt"]), ["container write visible on host"]);

  const pairCli = await compose(["exec", "-T", "app", "node", "apps/server/dist/cli.js", "pair", "--ttl", "600"]);
  if (pairCli.code !== 0) throw new Error(`pair CLI failed: ${pairCli.stdout}\n${pairCli.stderr}`);
  const pairing = JSON.parse(pairCli.stdout.trim());
  if (typeof pairing.token !== "string" || pairing.token.length < 32) throw new Error("pair CLI did not return a high-entropy token");
  const baseUrl = `http://127.0.0.1:${httpPort}`;
  const paired = await jsonRequest(`${baseUrl}/v1/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pairingToken: pairing.token, deviceName: "S12 Docker verification" })
  });
  const deviceToken = paired.deviceToken;
  if (typeof deviceToken !== "string" || deviceToken.length < 32) throw new Error("pair endpoint did not return a device token");
  record("S12-pair", "passed", composeCommand(["exec", "-T", "app", "node", "apps/server/dist/cli.js", "pair", "--ttl", "600"]), ["CLI token consumed once by actual HTTP pairing endpoint"]);

  const authHeaders = { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" };
  const projectResponse = await jsonRequest(`${baseUrl}/v1/projects`, {
    method: "POST",
    headers: { ...authHeaders, "idempotency-key": randomUUID() },
    body: JSON.stringify({ name: "S12 Docker project", rootPath: "/workspaces/project" })
  });
  const projectId = projectResponse.project?.id;
  if (typeof projectId !== "string") throw new Error("project API did not return a project id");
  const sessionResponse = await jsonRequest(`${baseUrl}/v1/projects/${projectId}/sessions`, {
    method: "POST",
    headers: { ...authHeaders, "idempotency-key": randomUUID() },
    body: JSON.stringify({ title: "S12 Docker persisted session" })
  });
  const sessionId = sessionResponse.session?.id;
  if (typeof sessionId !== "string") throw new Error("session API did not return a session id");
  record("S12-persisted-resources", "passed", "HTTP pair -> project -> session", ["SQLite owner/device/project/session state created in the container"]);

  const recreate = await compose(["up", "-d", "--no-build", "--force-recreate", "app"]);
  if (recreate.code !== 0) throw new Error(`app recreate failed: ${recreate.stdout}\n${recreate.stderr}`);
  await waitForHttp(`http://127.0.0.1:${httpPort}/healthz`);
  const afterRecreate = await jsonRequest(`${baseUrl}/v1/sessions/${sessionId}`, { headers: { authorization: `Bearer ${deviceToken}` } });
  if (afterRecreate.id !== sessionId || afterRecreate.title !== "S12 Docker persisted session") throw new Error("session state was not retained across app recreation");
  record("S12-recreate-persistence", "passed", composeCommand(["up", "-d", "--no-build", "--force-recreate", "app"]), ["old session readable after app container recreation"]);

  const backupMount = `${dockerBackupRoot}:/backups`;
  const runningBackup = await compose(["run", "--rm", "--no-deps", "-v", backupMount, "app", "node", "apps/server/dist/cli.js", "backup", "--destination", "/backups/running"]);
  if (runningBackup.code === 0) throw new Error("backup unexpectedly succeeded while the app held the instance lock");
  record("S12-backup-running-rejected", "passed", composeCommand(["run", "--rm", "--no-deps", "-v", backupMount, "app", "node", "apps/server/dist/cli.js", "backup", "--destination", "/backups/running"]), ["live instance lock is enforced"]);

  const stopped = await compose(["stop", "app"]);
  if (stopped.code !== 0) throw new Error(`app stop failed: ${stopped.stdout}\n${stopped.stderr}`);
  const backup = await compose(["run", "--rm", "--no-deps", "-v", backupMount, "app", "node", "apps/server/dist/cli.js", "backup", "--destination", "/backups/first"]);
  if (backup.code !== 0) throw new Error(`backup failed: ${backup.stdout}\n${backup.stderr}`);
  await access(join(backupRoot, "first", "manifest.json"));
  await access(join(backupRoot, "first", "manifest.sha256"));
  record("S12-backup", "passed", composeCommand(["run", "--rm", "--no-deps", "-v", backupMount, "app", "node", "apps/server/dist/cli.js", "backup", "--destination", "/backups/first"]), ["maintenance", "instance lock", "SQLite checkpoint", "pi/output manifest and SHA-256 verification"]);

  const imageName = image;
  const restoreEnv = [
    "--env", "PI_REMOTE_STATE_DIR=/state",
    "--env", "PI_REMOTE_PI_DIR=/state/pi",
    "--env", "PI_REMOTE_WORKSPACE_ROOT=/workspaces",
    "--env", "PI_REMOTE_DATABASE_FILE=/state/state.sqlite",
    "--env", "PI_REMOTE_OWNER_ID=s12-docker-owner",
    "--env", "PI_REMOTE_OWNER_NAME=S12 Docker owner",
    `--env=PI_REMOTE_CURSOR_SECRET=${secret}`,
    "--env", "PI_REMOTE_PAIRING_TTL_SECONDS=600",
    "--env", "PI_REMOTE_LIVE_TESTS=0"
  ];
  const restore = await run("docker", ["run", "--rm", "--user", "1000:1000", "--mount", `type=bind,source=${dockerRestoredState},target=/state`, "--mount", `type=bind,source=${dockerBackupRoot},target=/backups,readonly`, ...restoreEnv, imageName, "node", "apps/server/dist/cli.js", "restore", "--source", "/backups/first"]);
  if (restore.code !== 0) throw new Error(`restore failed: ${restore.stdout}\n${restore.stderr}`);
  record("S12-restore-new-volume", "passed", "docker run --mount <empty-state> ... restore --source /backups/first", ["actual empty bind-mounted state target", "manifest/hash/schema validation", "restored SQLite/pi/outputs"]);

  restoreContainerName = `${composeProject}-restored`;
  const restoreStart = await run("docker", ["run", "-d", "--name", restoreContainerName, "--init", "--user", "1000:1000", "-p", `${restoredPort}:8080`, "--mount", `type=bind,source=${dockerRestoredState},target=/state`, "--mount", `type=bind,source=${dockerWorkspace},target=/workspaces`, ...restoreEnv, imageName]);
  if (restoreStart.code !== 0) throw new Error(`restored service start failed: ${restoreStart.stdout}\n${restoreStart.stderr}`);
  const restoredBaseUrl = `http://127.0.0.1:${restoredPort}`;
  await waitForHttp(`${restoredBaseUrl}/healthz`);
  const restoredSession = await jsonRequest(`${restoredBaseUrl}/v1/sessions/${sessionId}`, { headers: { authorization: `Bearer ${deviceToken}` } });
  if (restoredSession.id !== sessionId || restoredSession.title !== "S12 Docker persisted session") throw new Error("restored service could not read the old session");
  record("S12-restore-continuity", "passed", "GET restored /v1/sessions/:id", ["old device credential and old session readable from a new state volume"]);

  // Bring the original service back only for deterministic cleanup and to
  // prove the standard Compose command remains the operator entry point.
  const restart = await compose(["up", "-d", "--no-build", "app"]);
  if (restart.code !== 0) throw new Error(`compose restart after backup failed: ${restart.stdout}\n${restart.stderr}`);
  await waitForHttp(`http://127.0.0.1:${httpPort}/healthz`);
}

const requiredFiles = [
  "deploy/Dockerfile",
  "deploy/compose.yaml",
  "deploy/entrypoint.sh",
  "deploy/tls/Caddyfile",
  "apps/server/src/deployment.ts",
  "apps/server/src/maintenance.ts",
  "tests/deployment/deployment.test.ts"
];
for (const relativePath of requiredFiles) await checkFile(relativePath);

try {
  const npmrc = await readFile(join(root, ".npmrc"), "utf8");
  const ci = await readFile(join(root, ".github", "workflows", "ci.yml"), "utf8");
  const dockerfile = await readFile(join(root, "deploy", "Dockerfile"), "utf8");
  const composeText = await readFile(composeFile, "utf8");
  const domestic = npmrc.includes("registry=https://registry.npmmirror.com")
    && ci.includes("NPM_CONFIG_REGISTRY: https://registry.npmmirror.com")
    && ci.includes("DOCKER_REGISTRY_MIRROR: docker.m.daocloud.io")
    && dockerfile.includes("NPM_REGISTRY=https://registry.npmmirror.com")
    && dockerfile.includes("DOCKER_REGISTRY_MIRROR=docker.m.daocloud.io")
    && composeText.includes("docker.m.daocloud.io");
  record("S12-domestic-sources", domestic ? "passed" : "failed", ".npmrc + Dockerfile + Compose + CI domestic source contract", ["npm/pnpm: https://registry.npmmirror.com", "Docker Hub mirror: docker.m.daocloud.io"], domestic ? undefined : "all package and image build paths must retain the configured domestic mirrors");
} catch (error) {
  record("S12-domestic-sources", "failed", ".npmrc + Dockerfile + Compose + CI domestic source contract", [], error instanceof Error ? error.message : String(error));
}

const nodeMajor = Number(process.versions.node.split(".")[0]);
record("S12-node-runtime", nodeMajor === 24 ? "passed" : "failed", "node --version", [process.version], nodeMajor === 24 ? undefined : "S12 uses the project Node 24 baseline");

await command("S12-server-build", "pnpm", ["run", "build:server"], ["server, worker and migration assets"]);
await command("S12-deployment-tests", "pnpm", ["exec", "vitest", "run", "--config", "vitest.config.mjs", "tests/deployment/deployment.test.ts"], ["real temporary SQLite", "manifest/hash", "active runtime rejection", "new-volume restore"]);
for (const [id, commandName, args] of [
  ["S12-lint", "pnpm", ["run", "lint"]],
  ["S12-typecheck", "pnpm", ["run", "typecheck"]],
  ["S12-docs", process.platform === "win32" ? "python" : "python3", ["scripts/check_docs.py"]]
]) await command(id, commandName, args);

const dockerInfo = await run("docker", ["info", "--format", "{{.ServerVersion}}"]);
if (dockerInfo.code !== 0) {
  record("S12-docker-daemon", "not_run", "docker info", [], "Docker daemon is unavailable; the Docker checks are blocked and are not converted to passed");
} else {
  record("S12-docker-daemon", "passed", "docker info", [`Docker ${dockerInfo.stdout.trim()}`]);
  try {
    await dockerLifecycle();
  } catch (error) {
    record("S12-docker-lifecycle", "failed", "docker compose build/up/health/recreate/backup/restore", [], error instanceof Error ? error.message : String(error));
  }
}

if (restoreContainerName) await run("docker", ["rm", "-f", restoreContainerName]);
if (composeProject && composeEnvFile) await compose(["down", "--volumes", "--remove-orphans"]);
if (tempRoot) await rm(tempRoot, { recursive: true, force: true });

const failed = checks.some((check) => check.status === "failed");
const blocked = checks.some((check) => check.status === "not_run");
const report = {
  stage: "S12",
  status: failed ? "failed" : blocked ? "blocked" : "passed",
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
    "The Docker lifecycle uses a disposable named state volume and disposable bind-mounted workspace; it does not touch unrelated running Docker projects.",
    "The local Caddy profile uses tls internal for a reproducible HTTPS/WSS smoke. A real deployment must replace it with a trusted certificate or an explicitly trusted private CA before connecting phones.",
    "The deployment checks do not claim real provider, physical Android/iOS, native TUI, or full Bash parity; those remain separate acceptance environments.",
    "No pairing token, device token, cursor secret, auth.json, session JSONL, SQLite bytes, or command response body is written to this report."
  ]
};
await writeFile(join(resultsDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
if (report.status !== "passed") process.exitCode = 1;
