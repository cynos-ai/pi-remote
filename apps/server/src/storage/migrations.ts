import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

export const CURRENT_SCHEMA_VERSION = 1;

function initialMigrationSql(): string {
  return readFileSync(new URL("./migrations/001-initial.sql", import.meta.url), "utf8");
}

function ensureV1CompatibilityColumns(database: DatabaseSync): void {
  // S04 shipped schema version 1 before the Git common-directory field was
  // needed by the project API. Keep the public schema version stable while
  // making an existing v1 state volume forward-compatible with S05.
  const columns = database.prepare("PRAGMA table_info(projects)").all() as Array<{ name?: unknown }>;
  if (!columns.some((column) => column.name === "git_common_dir")) {
    database.exec("ALTER TABLE projects ADD COLUMN git_common_dir TEXT");
  }
}

export function migrateDatabase(database: DatabaseSync, now = Date.now()): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    ) STRICT;
  `);
  const current = database.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
  const currentVersion = Number(current?.user_version ?? 0);
  if (currentVersion > CURRENT_SCHEMA_VERSION) {
    throw new Error(`database schema ${currentVersion} is newer than supported ${CURRENT_SCHEMA_VERSION}`);
  }
  if (currentVersion === CURRENT_SCHEMA_VERSION) {
    ensureV1CompatibilityColumns(database);
    return;
  }
  if (currentVersion !== 0) throw new Error(`no migration path from schema ${currentVersion}`);

  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(initialMigrationSql());
    ensureV1CompatibilityColumns(database);
    database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(CURRENT_SCHEMA_VERSION, now);
    database.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION}`);
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the migration error; the connection is unusable until closed.
    }
    throw error;
  }
}
