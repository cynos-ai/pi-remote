import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { basename, dirname, join } from "node:path";

export const MAINTENANCE_SCHEMA_VERSION = 1 as const;

export interface MaintenanceState {
  schemaVersion: typeof MAINTENANCE_SCHEMA_VERSION;
  pid: number;
  enteredAt: string;
  reason: string;
}

export class MaintenanceError extends Error {
  constructor(
    public readonly code: "MAINTENANCE" | "INSTANCE_RUNNING" | "INVALID_MAINTENANCE_STATE",
    message: string
  ) {
    super(message);
    this.name = "MaintenanceError";
  }
}

export function maintenancePath(stateDir: string): string {
  return join(stateDir, "maintenance.json");
}

/**
 * Return the SQLite sidecar used for the cross-namespace instance lock.
 * `instance.lock` remains a readable diagnostic marker; the SQLite file is
 * the authoritative lock because a PID in one Docker container is not
 * meaningful in another container's PID namespace.
 */
export function instanceLockDatabasePath(lockPath: string): string {
  return join(dirname(lockPath), `${basename(lockPath)}.sqlite`);
}

function parseMaintenance(value: unknown, path: string): MaintenanceState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new MaintenanceError("INVALID_MAINTENANCE_STATE", `maintenance marker is invalid: ${path}`);
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.schemaVersion !== MAINTENANCE_SCHEMA_VERSION ||
    !Number.isSafeInteger(candidate.pid) ||
    (candidate.pid as number) < 1 ||
    typeof candidate.enteredAt !== "string" ||
    Number.isNaN(Date.parse(candidate.enteredAt)) ||
    typeof candidate.reason !== "string" ||
    candidate.reason.length > 240
  ) {
    throw new MaintenanceError("INVALID_MAINTENANCE_STATE", `maintenance marker is invalid: ${path}`);
  }
  return {
    schemaVersion: MAINTENANCE_SCHEMA_VERSION,
    pid: candidate.pid as number,
    enteredAt: candidate.enteredAt,
    reason: candidate.reason
  };
}

export function readMaintenanceState(stateDir: string): MaintenanceState | null {
  const path = maintenancePath(stateDir);
  try {
    return parseMaintenance(JSON.parse(readFileSync(path, "utf8")) as unknown, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof MaintenanceError) throw error;
    throw new MaintenanceError("INVALID_MAINTENANCE_STATE", `maintenance marker cannot be read: ${path}`);
  }
}

/** Create a marker atomically. The marker is intentionally human-readable and contains no secret. */
export function enterMaintenance(stateDir: string, reason = "operator maintenance"): MaintenanceState {
  const path = maintenancePath(stateDir);
  if (!reason || reason.length > 240) throw new MaintenanceError("INVALID_MAINTENANCE_STATE", "maintenance reason is invalid");
  const state: MaintenanceState = {
    schemaVersion: MAINTENANCE_SCHEMA_VERSION,
    pid: process.pid,
    enteredAt: new Date().toISOString(),
    reason
  };
  // mkdirSync is used here because this function is also called by the
  // synchronous startup/CLI boundary. It only creates the explicitly named
  // state directory.
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let descriptor: number;
  try {
    descriptor = openSync(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new MaintenanceError("MAINTENANCE", "maintenance mode is already active");
    }
    throw error;
  }
  try {
    writeSync(descriptor, `${JSON.stringify(state)}\n`, undefined, "utf8");
  } catch (error) {
    closeSync(descriptor);
    try { unlinkSync(path); } catch { /* preserve the original write error */ }
    throw error;
  }
  closeSync(descriptor);
  return state;
}

export async function enterMaintenanceAsync(stateDir: string, reason = "operator maintenance"): Promise<MaintenanceState> {
  await mkdir(dirname(maintenancePath(stateDir)), { recursive: true, mode: 0o700 });
  return enterMaintenance(stateDir, reason);
}

export function exitMaintenance(stateDir: string): boolean {
  const path = maintenancePath(stateDir);
  try {
    unlinkSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function assertWritable(stateDir: string): void {
  if (readMaintenanceState(stateDir) !== null) {
    throw new MaintenanceError("MAINTENANCE", "service is in maintenance mode; writes are temporarily disabled");
  }
}

function processStartTicks(pid: number): string | null {
  if (process.platform !== "linux") return null;
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    const closing = raw.lastIndexOf(")");
    return raw.slice(closing + 2).trim().split(/\s+/)[19] ?? null;
  } catch {
    return null;
  }
}

function processIsAlive(pid: number, expectedStartTicks: string | null): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
  if (expectedStartTicks === null) return true;
  const current = processStartTicks(pid);
  return current === null || current === expectedStartTicks;
}

function isSqliteBusy(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; message?: unknown };
  return candidate.code === "SQLITE_BUSY" || (typeof candidate.message === "string" && /database is locked|database table is locked/i.test(candidate.message));
}

function closeLockDatabase(database: DatabaseSync): void {
  try {
    database.exec("ROLLBACK");
  } catch {
    // The transaction may not have started, or SQLite may already have
    // rolled it back while reporting an open/close error.
  }
  try {
    database.close();
  } catch {
    // Preserve the caller's lock-validation error when there is one.
  }
}

/** Prove that an existing SQLite lock sidecar is not held by a live server. */
function assertSqliteLockAvailable(path: string): void {
  let database: DatabaseSync | null = null;
  try {
    database = new DatabaseSync(path);
    database.exec("PRAGMA busy_timeout = 0");
    database.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    if (database !== null) closeLockDatabase(database);
    if (isSqliteBusy(error)) {
      throw new MaintenanceError("INSTANCE_RUNNING", "a live server instance owns the state volume; stop it before backup or restore");
    }
    throw new MaintenanceError("INSTANCE_RUNNING", `instance lock cannot be validated: ${path}`);
  }
  if (database !== null) closeLockDatabase(database);
}

/**
 * Backups and restores must not share a state volume with a live server. A
 * stale lock from a killed process is removed only after the PID/start-tick
 * check proves that it cannot own the lock anymore.
 */
export function assertInstanceStopped(stateDir: string): void {
  const path = join(stateDir, "instance.lock");
  const sqlitePath = instanceLockDatabasePath(path);

  // Do not open a missing sidecar: DatabaseSync would create it, which would
  // make an otherwise empty restore target fail its emptiness check. Once the
  // sidecar exists, its SQLite transaction is authoritative across Docker
  // PID namespaces; the JSON marker is only a legacy fallback/diagnostic.
  const hasSqliteLock = existsSync(sqlitePath);
  if (hasSqliteLock) {
    assertSqliteLockAvailable(sqlitePath);
    try {
      unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return;
  }

  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new MaintenanceError("INSTANCE_RUNNING", `instance lock cannot be validated: ${path}`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new MaintenanceError("INSTANCE_RUNNING", `instance lock cannot be validated: ${path}`);
  }
  const record = value as Record<string, unknown>;
  if (!Number.isSafeInteger(record.pid) || (record.pid as number) < 1 ||
      (record.startTicks !== null && typeof record.startTicks !== "string")) {
    throw new MaintenanceError("INSTANCE_RUNNING", `instance lock cannot be validated: ${path}`);
  }
  const startTicks = typeof record.startTicks === "string" ? record.startTicks : null;
  if (processIsAlive(record.pid as number, startTicks)) {
    throw new MaintenanceError("INSTANCE_RUNNING", "a live server instance owns the state volume; stop it before backup or restore");
  }
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
