import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { constants, statSync } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  lstat,
  writeFile
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { AuthService } from "./auth.js";
import { MaintenanceError, assertInstanceStopped, enterMaintenance, exitMaintenance, maintenancePath, readMaintenanceState } from "./maintenance.js";
import { openServerDatabaseSync } from "./storage/database.js";
import type { ServerEnv } from "./config.js";

export const BACKUP_SCHEMA_VERSION = 1 as const;

type FileManifest = {
  path: string;
  sizeBytes: number;
  sha256: string;
  mode: number;
};

export type BackupManifest = {
  schemaVersion: typeof BACKUP_SCHEMA_VERSION;
  createdAt: string;
  appVersion: string;
  database: FileManifest & { path: "database.sqlite" };
  trees: {
    pi: FileManifest[];
    outputs: FileManifest[];
  };
};

export type DoctorCheckStatus = "passed" | "warning" | "failed" | "not_run";

export interface DoctorCheck {
  id: string;
  status: DoctorCheckStatus;
  message: string;
}

export interface DoctorReport {
  status: "passed" | "failed";
  checks: DoctorCheck[];
}

export interface DeploymentInitResult {
  stateDir: string;
  piDir: string;
  workspaceRoot: string;
  databaseFile: string;
  ownerId: string;
}

export interface BackupResult {
  destination: string;
  manifest: BackupManifest;
}

export interface RestoreResult {
  source: string;
  stateDir: string;
  databaseFile: string;
  restoredFiles: number;
}

const APP_VERSION = "0.1.0-s12";

function databaseFile(env: ServerEnv): string {
  if (env.PI_REMOTE_DATABASE_FILE === ":memory:") {
    throw new Error("PI_REMOTE_DATABASE_FILE=:memory: is not valid for a deployment");
  }
  return resolve(env.PI_REMOTE_DATABASE_FILE ?? join(env.PI_REMOTE_STATE_DIR, "state.sqlite"));
}

function stateDirectory(env: ServerEnv): string {
  return resolve(env.PI_REMOTE_STATE_DIR);
}

function outputDirectory(env: ServerEnv): string {
  return join(stateDirectory(env), "outputs");
}

function isWithin(parent: string, candidate: string, includeEqual = true): boolean {
  const root = resolve(parent);
  const child = resolve(candidate);
  const childRelative = relative(root, child);
  if (childRelative === "") return includeEqual;
  return !childRelative.startsWith("..") && !isAbsolute(childRelative);
}

function safeRelativePath(value: string): string {
  if (!value || value.includes("\\") || value.includes("\0") || value.startsWith("/")) {
    throw new Error(`backup contains an unsafe relative path: ${value}`);
  }
  const parts = value.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new Error(`backup contains an unsafe relative path: ${value}`);
  }
  return parts.join("/");
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("backup manifest must be an object");
  return value as Record<string, unknown>;
}

function requiredText(value: Record<string, unknown>, key: string): string {
  if (typeof value[key] !== "string" || value[key] === "") throw new Error(`backup manifest field ${key} is invalid`);
  return value[key] as string;
}

function requiredSafeInteger(value: Record<string, unknown>, key: string): number {
  if (!Number.isSafeInteger(value[key]) || (value[key] as number) < 0) throw new Error(`backup manifest field ${key} is invalid`);
  return value[key] as number;
}

function parseFileManifest(value: unknown): FileManifest {
  const candidate = record(value);
  const path = safeRelativePath(requiredText(candidate, "path"));
  const sha256 = requiredText(candidate, "sha256");
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error(`backup manifest hash is invalid: ${path}`);
  const mode = requiredSafeInteger(candidate, "mode");
  if (mode > 0o777) throw new Error(`backup manifest mode is invalid: ${path}`);
  return {
    path,
    sizeBytes: requiredSafeInteger(candidate, "sizeBytes"),
    sha256,
    mode
  };
}

function parseManifest(value: unknown): BackupManifest {
  const candidate = record(value);
  if (candidate.schemaVersion !== BACKUP_SCHEMA_VERSION) throw new Error("unsupported backup manifest version");
  const database = parseFileManifest(candidate.database);
  if (database.path !== "database.sqlite") throw new Error("backup database path must be database.sqlite");
  const trees = record(candidate.trees);
  const pi = parseFileList(trees.pi, "pi");
  const outputs = parseFileList(trees.outputs, "outputs");
  const allPaths = [
    database.path,
    ...pi.map((item) => `pi/${item.path}`),
    ...outputs.map((item) => `outputs/${item.path}`)
  ];
  if (new Set(allPaths).size !== allPaths.length) throw new Error("backup manifest contains duplicate paths");
  return {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    createdAt: requiredText(candidate, "createdAt"),
    appVersion: requiredText(candidate, "appVersion"),
    database: { ...database, path: "database.sqlite" },
    trees: { pi, outputs }
  };
}

function parseFileList(value: unknown, prefix: string): FileManifest[] {
  if (!Array.isArray(value)) throw new Error(`backup manifest tree ${prefix} is invalid`);
  return value.map((item) => parseFileManifest(item));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function ensureDirectory(path: string, mode: number, enforceMode = true): Promise<void> {
  if (await pathExists(path)) {
    const existing = await lstat(path);
    if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error(`expected a real directory: ${path}`);
  } else {
    await mkdir(path, { recursive: true, mode });
  }
  // A bind-mounted project directory belongs to the host. Some Docker
  // Desktop/WSL mounts reject chmod even when the directory is writable, so
  // initialization only creates it and validates access in that case.
  if (enforceMode) await chmod(path, mode);
}

async function hashFile(path: string): Promise<{ sizeBytes: number; sha256: string }> {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  const stream = createReadStream(path);
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    sizeBytes += bytes.byteLength;
    hash.update(bytes);
  }
  return { sizeBytes, sha256: hash.digest("hex") };
}

async function collectFiles(root: string, prefix = ""): Promise<FileManifest[]> {
  if (!(await pathExists(root))) return [];
  const entries = await readdir(root, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  const files: FileManifest[] = [];
  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`backup source cannot contain symlinks: ${path}`);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(path, relativePath));
      continue;
    }
    if (!entry.isFile()) throw new Error(`backup source contains an unsupported file: ${path}`);
    const details = await hashFile(path);
    const fileStat = await stat(path);
    files.push({
      path: safeRelativePath(relativePath),
      sizeBytes: details.sizeBytes,
      sha256: details.sha256,
      mode: fileStat.mode & 0o777
    });
  }
  return files;
}

async function verifyManifestFile(root: string, item: FileManifest): Promise<void> {
  const path = resolve(root, item.path);
  if (!isWithin(root, path, false)) throw new Error(`backup path escaped its root: ${item.path}`);
  const fileStat = await lstat(path);
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) throw new Error(`backup file is missing or is not regular: ${item.path}`);
  const details = await hashFile(path);
  if (details.sizeBytes !== item.sizeBytes || details.sha256 !== item.sha256) {
    throw new Error(`backup hash verification failed: ${item.path}`);
  }
}

async function verifyTree(root: string, files: FileManifest[]): Promise<void> {
  for (const file of files) await verifyManifestFile(root, file);
  const actual = await collectFiles(root);
  const expected = files.slice().sort((left, right) => left.path.localeCompare(right.path));
  const actualSorted = actual.sort((left, right) => left.path.localeCompare(right.path));
  if (actualSorted.length !== expected.length || actualSorted.some((file, index) => file.path !== expected[index]?.path)) {
    throw new Error(`backup tree contains unexpected files: ${root}`);
  }
}

async function copyManifestFiles(sourceRoot: string, destinationRoot: string, files: FileManifest[]): Promise<void> {
  await ensureDirectory(destinationRoot, 0o700);
  for (const file of files) {
    const sourceRelative = file.path;
    const source = resolve(sourceRoot, sourceRelative);
    const destination = resolve(destinationRoot, sourceRelative);
    if (!isWithin(sourceRoot, source, false) || !isWithin(destinationRoot, destination, false)) {
      throw new Error(`backup copy path escaped its root: ${file.path}`);
    }
    await verifyManifestFile(sourceRoot, { ...file, path: sourceRelative });
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await copyFile(source, destination);
    await chmod(destination, file.mode);
  }
}

async function verifyBackupDirectory(source: string): Promise<BackupManifest> {
  const manifestPath = join(source, "manifest.json");
  const sidecarPath = join(source, "manifest.sha256");
  const manifestBytes = await readFile(manifestPath);
  const sidecar = (await readFile(sidecarPath, "utf8")).trim();
  if (!/^[a-f0-9]{64}$/.test(sidecar)) throw new Error("backup manifest sidecar hash is invalid");
  const actualManifestHash = createHash("sha256").update(manifestBytes).digest("hex");
  if (sidecar !== actualManifestHash) throw new Error("backup manifest hash verification failed");
  const manifest = parseManifest(JSON.parse(manifestBytes.toString("utf8")) as unknown);
  await verifyManifestFile(source, manifest.database);
  await verifyTree(join(source, "pi"), manifest.trees.pi);
  await verifyTree(join(source, "outputs"), manifest.trees.outputs);
  return manifest;
}

async function assertBackupDestinationAllowed(destination: string, env: ServerEnv, database: DatabaseSync): Promise<void> {
  const stateDir = stateDirectory(env);
  const workspaceRoot = resolve(env.PI_REMOTE_WORKSPACE_ROOT);
  if (isWithin(stateDir, destination) || isWithin(workspaceRoot, destination)) {
    throw new Error("backup destination must be outside the state and workspace roots");
  }
  const rows = database.prepare("SELECT root_path FROM projects").all() as Array<{ root_path?: unknown }>;
  for (const row of rows) {
    if (typeof row.root_path === "string" && isWithin(row.root_path, destination)) {
      throw new Error("backup destination must not be inside a registered project");
    }
  }
}

function activeRuntime(database: DatabaseSync): { runs: number; commands: number } {
  const runsRow = database.prepare("SELECT COUNT(*) AS count FROM runs WHERE status IN ('running','waiting_input')").get() as { count?: unknown } | undefined;
  const commandsRow = database.prepare("SELECT COUNT(*) AS count FROM commands WHERE state IN ('dispatching','accepted')").get() as { count?: unknown } | undefined;
  return { runs: Number(runsRow?.count ?? 0), commands: Number(commandsRow?.count ?? 0) };
}

async function writeBackupFile(destination: string, content: string): Promise<void> {
  await writeFile(destination, content, { encoding: "utf8", mode: 0o600 });
  await chmod(destination, 0o600);
}

/**
 * Provision the directories and schema expected by the long-running service.
 * This is deliberately idempotent, but refuses to touch a live instance or a
 * volume left in maintenance mode after a failed restore.
 */
export async function initializeDeployment(env: ServerEnv): Promise<DeploymentInitResult> {
  const stateDir = stateDirectory(env);
  const piDir = resolve(env.PI_REMOTE_PI_DIR);
  const workspaceRoot = resolve(env.PI_REMOTE_WORKSPACE_ROOT);
  const dbFile = databaseFile(env);

  // The state root may be a host bind mount during restore or local Docker
  // development. Docker Desktop/WSL can reject chmod on the mount itself;
  // create it when missing and leave host-owned permissions to the operator.
  // The normal named volume is already initialized with 0700 in the image.
  await ensureDirectory(stateDir, 0o700, false);
  if (readMaintenanceState(stateDir) !== null) {
    throw new MaintenanceError("MAINTENANCE", "state volume is in maintenance mode; inspect it before starting the service");
  }
  assertInstanceStopped(stateDir);
  await ensureDirectory(piDir, 0o700);
  await ensureDirectory(join(stateDir, "outputs"), 0o700);
  await ensureDirectory(join(stateDir, "runtime"), 0o700);
  await ensureDirectory(join(stateDir, "worker-spool"), 0o700);
  await ensureDirectory(join(stateDir, "home"), 0o700);
  await ensureDirectory(workspaceRoot, 0o755, false);

  const database = openServerDatabaseSync({ filename: dbFile });
  try {
    const auth = new AuthService(database, {
      pairingTtlSeconds: env.PI_REMOTE_PAIRING_TTL_SECONDS
    });
    auth.ensureOwner({ id: env.PI_REMOTE_OWNER_ID, displayName: env.PI_REMOTE_OWNER_NAME });
  } finally {
    database.close();
  }
  await chmod(dbFile, 0o600);

  return {
    stateDir,
    piDir,
    workspaceRoot,
    databaseFile: dbFile,
    ownerId: env.PI_REMOTE_OWNER_ID
  };
}

/** Create a portable directory backup after proving that the app is stopped. */
export async function backupDeployment(env: ServerEnv, destinationInput: string): Promise<BackupResult> {
  if (!destinationInput || destinationInput.startsWith("-")) throw new Error("backup destination is required");
  const destination = resolve(destinationInput);
  if (await pathExists(destination)) throw new Error(`backup destination already exists: ${destination}`);
  const stateDir = stateDirectory(env);
  const dbFile = databaseFile(env);
  let autoMaintenance = false;
  if (readMaintenanceState(stateDir) === null) {
    enterMaintenance(stateDir, "backup");
    autoMaintenance = true;
  }
  try {
    assertInstanceStopped(stateDir);
    if (!(await pathExists(dbFile))) throw new Error(`database does not exist: ${dbFile}; run init first`);
    const database = openServerDatabaseSync({ filename: dbFile });
    let manifest: BackupManifest;
    try {
      await assertBackupDestinationAllowed(destination, env, database);
      const active = activeRuntime(database);
      if (active.runs > 0 || active.commands > 0) {
        throw new Error(`active runtime remains (runs=${active.runs}, commands=${active.commands}); stop the app and retry`);
      }
      database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      const databaseDetails = await hashFile(dbFile);
      manifest = {
        schemaVersion: BACKUP_SCHEMA_VERSION,
        createdAt: new Date().toISOString(),
        appVersion: APP_VERSION,
        database: { path: "database.sqlite", ...databaseDetails, mode: 0o600 },
        trees: {
          pi: await collectFiles(env.PI_REMOTE_PI_DIR),
          outputs: await collectFiles(outputDirectory(env))
        }
      };
    } finally {
      database.close();
    }

    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    const staging = join(dirname(destination), `.${destination.split("/").at(-1) ?? "backup"}.partial-${randomUUID()}`);
    try {
      await mkdir(staging, { recursive: true, mode: 0o700 });
      await copyFile(dbFile, join(staging, "database.sqlite"));
      await chmod(join(staging, "database.sqlite"), 0o600);
      await copyManifestFiles(env.PI_REMOTE_PI_DIR, join(staging, "pi"), manifest.trees.pi);
      await copyManifestFiles(outputDirectory(env), join(staging, "outputs"), manifest.trees.outputs);
      const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
      await writeBackupFile(join(staging, "manifest.json"), manifestBytes);
      await writeBackupFile(join(staging, "manifest.sha256"), `${createHash("sha256").update(manifestBytes).digest("hex")}\n`);
      await verifyBackupDirectory(staging);
      await rename(staging, destination);
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
    return { destination, manifest };
  } finally {
    if (autoMaintenance) exitMaintenance(stateDir);
  }
}

/** Restore a verified backup into a new, empty state volume. */
export async function restoreDeployment(env: ServerEnv, sourceInput: string): Promise<RestoreResult> {
  if (!sourceInput || sourceInput.startsWith("-")) throw new Error("restore source is required");
  const source = resolve(sourceInput);
  const stateDir = stateDirectory(env);
  if (isWithin(stateDir, source) || isWithin(source, stateDir)) {
    throw new Error("restore source and target state directory must be separate");
  }
  const manifest = await verifyBackupDirectory(source);
  let autoMaintenance = false;
  let restoredSuccessfully = false;
  if (readMaintenanceState(stateDir) === null) {
    enterMaintenance(stateDir, "restore");
    autoMaintenance = true;
  }
  try {
    assertInstanceStopped(stateDir);
    const stateEntries = await readdir(stateDir);
    const unexpected = stateEntries.filter((entry) => entry !== "maintenance.json");
    if (unexpected.length > 0) throw new Error("restore target state directory must be empty (use a new volume)");
    const targetDatabase = databaseFile(env);
    const targetPi = resolve(env.PI_REMOTE_PI_DIR);
    const targetOutputs = outputDirectory(env);
    for (const target of [targetDatabase, targetPi, targetOutputs]) {
      if (await pathExists(target)) throw new Error(`restore target already exists: ${target}; use a new volume`);
    }

    const staging = join(stateDir, `.restore-${randomUUID()}`);
    try {
      await mkdir(staging, { recursive: true, mode: 0o700 });
      await copyFile(join(source, "database.sqlite"), join(staging, "database.sqlite"));
      await chmod(join(staging, "database.sqlite"), 0o600);
      await copyManifestFiles(join(source, "pi"), join(staging, "pi"), manifest.trees.pi);
      await copyManifestFiles(join(source, "outputs"), join(staging, "outputs"), manifest.trees.outputs);
      await copyFile(join(source, "manifest.json"), join(staging, "manifest.json"));
      await chmod(join(staging, "manifest.json"), 0o600);
      await copyFile(join(source, "manifest.sha256"), join(staging, "manifest.sha256"));
      await chmod(join(staging, "manifest.sha256"), 0o600);
      await verifyBackupDirectory(staging);

      await mkdir(dirname(targetDatabase), { recursive: true, mode: 0o700 });
      await copyFile(join(staging, "database.sqlite"), targetDatabase);
      await chmod(targetDatabase, 0o600);
      await copyManifestFiles(join(staging, "pi"), targetPi, manifest.trees.pi);
      await copyManifestFiles(join(staging, "outputs"), targetOutputs, manifest.trees.outputs);
      await ensureDirectory(join(stateDir, "runtime"), 0o700);
      await ensureDirectory(join(stateDir, "worker-spool"), 0o700);
      await ensureDirectory(join(stateDir, "home"), 0o700);

      const restored = openServerDatabaseSync({ filename: targetDatabase });
      try {
        const version = restored.prepare("PRAGMA user_version").get() as { user_version?: unknown } | undefined;
        const check = restored.prepare("PRAGMA quick_check").get() as { quick_check?: unknown } | undefined;
        if (Number(version?.user_version) !== 1 || check?.quick_check !== "ok") {
          throw new Error("restored database failed schema or integrity validation");
        }
      } finally {
        restored.close();
      }
      restoredSuccessfully = true;
      return {
        source,
        stateDir,
        databaseFile: targetDatabase,
        restoredFiles: 1 + manifest.trees.pi.length + manifest.trees.outputs.length
      };
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
  } finally {
    // On failure the marker intentionally remains, preventing an operator
    // from starting a partially restored volume without inspecting it.
    if (autoMaintenance && restoredSuccessfully) {
      try {
        const current = readMaintenanceState(stateDir);
        if (current?.reason === "restore") exitMaintenance(stateDir);
      } catch {
        // Preserve the original restore error.
      }
    }
  }
}

async function checkDirectory(checks: DoctorCheck[], id: string, path: string, sensitive: boolean): Promise<void> {
  try {
    const value = await lstat(path);
    if (!value.isDirectory() || value.isSymbolicLink()) throw new Error("not a real directory");
    await access(path, constants.R_OK | constants.W_OK);
    const writableByOthers = (value.mode & 0o022) !== 0;
    checks.push({
      id,
      status: sensitive && writableByOthers ? "failed" : "passed",
      message: sensitive && writableByOthers ? `${path} is writable by group/others` : `${path} is readable and writable`
    });
  } catch (error) {
    checks.push({ id, status: "failed", message: `${path} is unavailable (${error instanceof Error ? error.name : "error"})` });
  }
}

async function checkSensitiveFile(checks: DoctorCheck[], id: string, path: string): Promise<boolean> {
  try {
    const value = await lstat(path);
    if (!value.isFile() || value.isSymbolicLink()) throw new Error("not a regular file");
    checks.push({
      id,
      status: (value.mode & 0o077) === 0 ? "passed" : "failed",
      message: (value.mode & 0o077) === 0 ? `${path} has private permissions` : `${path} is readable by group/others`
    });
    return true;
  } catch (error) {
    checks.push({ id, status: "warning", message: `${path} is not configured (${error instanceof Error ? error.name : "error"})` });
    return false;
  }
}

function checkTool(checks: DoctorCheck[], id: string, command: string, required: boolean): void {
  try {
    execFileSync(command, ["--version"], { stdio: "ignore", timeout: 5_000 });
    checks.push({ id, status: "passed", message: `${command} is available` });
  } catch {
    checks.push({ id, status: required ? "failed" : "warning", message: `${command} is not available` });
  }
}

async function checkModelConfiguration(checks: DoctorCheck[], env: ServerEnv): Promise<void> {
  const piDir = resolve(env.PI_REMOTE_PI_DIR);
  const modelsPath = join(piDir, "models.json");
  const authPath = join(piDir, "auth.json");
  const hasModels = await checkSensitiveFile(checks, "model-catalog", modelsPath);
  const hasAuth = await checkSensitiveFile(checks, "model-credentials", authPath);
  let modelCount = 0;
  if (hasModels) {
    try {
      const { readPiModelCatalog } = await import("@pi-remote/agent-pi");
      modelCount = (await readPiModelCatalog({ agentDir: piDir, refresh: false })).length;
      checks.push({ id: "model-catalog-load", status: modelCount > 0 ? "passed" : "warning", message: `${modelCount} model(s) are available from the native catalog` });
    } catch {
      checks.push({ id: "model-catalog-load", status: "failed", message: "native model catalog could not be loaded" });
    }
  } else {
    checks.push({ id: "model-catalog-load", status: "not_run", message: "model catalog is not configured" });
  }
  if (!hasAuth) checks.push({ id: "model-auth", status: "not_run", message: "native credentials are not configured; environment/OAuth auth may still be used" });
  if (env.PI_REMOTE_DEFAULT_PROVIDER || env.PI_REMOTE_DEFAULT_MODEL) {
    if (!env.PI_REMOTE_DEFAULT_PROVIDER || !env.PI_REMOTE_DEFAULT_MODEL) {
      checks.push({ id: "default-model", status: "failed", message: "default provider and model must be configured together" });
    } else if (modelCount === 0) {
      checks.push({ id: "default-model", status: "warning", message: "default model cannot be checked until the native catalog is available" });
    } else {
      try {
        const { readPiModelCatalog } = await import("@pi-remote/agent-pi");
        const catalog = await readPiModelCatalog({ agentDir: piDir, refresh: false });
        const found = catalog.some((item) => item.model.provider === env.PI_REMOTE_DEFAULT_PROVIDER && item.model.id === env.PI_REMOTE_DEFAULT_MODEL);
        checks.push({ id: "default-model", status: found ? "passed" : "failed", message: found ? "configured default model is present" : "configured default model is not in the native catalog" });
      } catch {
        checks.push({ id: "default-model", status: "failed", message: "configured default model could not be checked" });
      }
    }
  } else {
    checks.push({ id: "default-model", status: "not_run", message: "no deployment default model is set; sessions may select a model explicitly" });
  }
  if (env.PI_REMOTE_MODEL_HEALTH_URL) {
    try {
      const url = new URL(env.PI_REMOTE_MODEL_HEALTH_URL);
      const response = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(env.PI_REMOTE_MODEL_TIMEOUT_MS) });
      checks.push({ id: "model-network", status: response.status < 500 ? "passed" : "failed", message: `model endpoint responded with HTTP ${response.status} at ${url.origin}` });
    } catch {
      checks.push({ id: "model-network", status: "failed", message: "configured model endpoint could not be reached" });
    }
  } else {
    checks.push({ id: "model-network", status: "not_run", message: "PI_REMOTE_MODEL_HEALTH_URL is not set; provider-specific network check is deferred" });
  }
}

/** Report operator-visible deployment problems without printing credentials. */
export async function doctorDeployment(env: ServerEnv): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const stateDir = stateDirectory(env);
  const piDir = resolve(env.PI_REMOTE_PI_DIR);
  await checkDirectory(checks, "state-directory", stateDir, true);
  await checkDirectory(checks, "pi-directory", piDir, true);
  await checkDirectory(checks, "output-directory", outputDirectory(env), true);
  await checkDirectory(checks, "workspace-root", resolve(env.PI_REMOTE_WORKSPACE_ROOT), false);
  checkTool(checks, "tool-node", process.execPath, true);
  checkTool(checks, "tool-git", "git", true);
  checkTool(checks, "tool-bash", "bash", true);
  checkTool(checks, "tool-python", "python3", true);
  checkTool(checks, "tool-sqlite-cli", "sqlite3", false);
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    checks.push({ id: "runtime-user", status: "failed", message: "service is running as root; use the image's non-root user" });
  } else {
    checks.push({ id: "runtime-user", status: "passed", message: "service is running as a non-root user" });
  }

  const dbFile = databaseFile(env);
  if (await pathExists(dbFile)) {
    try {
      const database = openServerDatabaseSync({ filename: dbFile });
      try {
        const version = database.prepare("PRAGMA user_version").get() as { user_version?: unknown } | undefined;
        const check = database.prepare("PRAGMA quick_check").get() as { quick_check?: unknown } | undefined;
        checks.push({ id: "sqlite", status: Number(version?.user_version) === 1 && check?.quick_check === "ok" ? "passed" : "failed", message: Number(version?.user_version) === 1 && check?.quick_check === "ok" ? "SQLite schema and integrity check passed" : "SQLite schema or integrity check failed" });
        const active = activeRuntime(database);
        checks.push({ id: "runtime-state", status: active.runs === 0 && active.commands === 0 ? "passed" : "warning", message: `runtime state: runs=${active.runs}, commands=${active.commands}` });
        const projects = database.prepare("SELECT root_path FROM projects").all() as Array<{ root_path?: unknown }>;
        const missing = projects.filter((row) => typeof row.root_path !== "string" || !pathExistsSync(row.root_path));
        checks.push({ id: "project-mounts", status: missing.length === 0 ? "passed" : "warning", message: `${projects.length - missing.length}/${projects.length} registered project path(s) are present` });
      } finally {
        database.close();
      }
    } catch {
      checks.push({ id: "sqlite", status: "failed", message: "SQLite could not be opened or checked" });
    }
  } else {
    checks.push({ id: "sqlite", status: "failed", message: "database is missing; run init" });
  }

  await checkModelConfiguration(checks, env);
  const maintenance = readMaintenanceState(stateDir);
  checks.push({ id: "maintenance", status: maintenance ? "warning" : "passed", message: maintenance ? `maintenance mode is active: ${maintenance.reason}` : "maintenance mode is not active" });
  const lock = join(stateDir, "instance.lock");
  if (await pathExists(lock)) {
    checks.push({ id: "instance-lock", status: "passed", message: "instance lock is present; a running server may own this volume" });
  } else {
    checks.push({ id: "instance-lock", status: "passed", message: "instance lock is available" });
  }
  const failed = checks.some((check) => check.status === "failed");
  return { status: failed ? "failed" : "passed", checks };
}

function pathExistsSync(path: string): boolean {
  try {
    const value = statSync(path);
    return value.isDirectory();
  } catch {
    return false;
  }
}

export { MaintenanceError, enterMaintenance, exitMaintenance, maintenancePath, readMaintenanceState };
