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
  const timeline = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'timeline_items'").get() as { sql?: unknown } | undefined;
  if (typeof timeline?.sql === "string" && !timeline.sql.includes("custom_entry")) {
    database.exec("SAVEPOINT timeline_items_v1_compat_upgrade");
    try {
      database.exec(`
      CREATE TABLE timeline_items_v1_compat (
        session_id TEXT NOT NULL REFERENCES sessions(id),
        item_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        run_id TEXT,
        kind TEXT NOT NULL CHECK(kind IN ('message','tool','custom_entry')),
        completeness TEXT NOT NULL CHECK(completeness IN ('complete','partial')),
        end_reason TEXT CHECK(end_reason IN ('failed','aborted','interrupted')),
        ordinal_seq INTEGER NOT NULL,
        finalized_seq INTEGER NOT NULL CHECK(finalized_seq >= ordinal_seq),
        payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
        PRIMARY KEY(session_id, item_id),
        CHECK ((completeness = 'complete' AND end_reason IS NULL)
          OR (completeness = 'partial' AND end_reason IS NOT NULL)),
        FOREIGN KEY(run_id, session_id) REFERENCES runs(id, session_id),
        FOREIGN KEY(session_id, ordinal_seq) REFERENCES events(session_id, seq),
        FOREIGN KEY(session_id, finalized_seq) REFERENCES events(session_id, seq)
      ) STRICT;
      INSERT INTO timeline_items_v1_compat(
        session_id, item_id, operation_id, run_id, kind, completeness, end_reason,
        ordinal_seq, finalized_seq, payload_json
      ) SELECT
        session_id, item_id, operation_id, run_id, kind, completeness, end_reason,
        ordinal_seq, finalized_seq, payload_json
      FROM timeline_items;
      DROP TABLE timeline_items;
      ALTER TABLE timeline_items_v1_compat RENAME TO timeline_items;
      CREATE INDEX timeline_page_idx ON timeline_items(session_id, ordinal_seq DESC, item_id);
      `);
      database.exec("RELEASE SAVEPOINT timeline_items_v1_compat_upgrade");
    } catch (error) {
      try {
        database.exec("ROLLBACK TO SAVEPOINT timeline_items_v1_compat_upgrade");
        database.exec("RELEASE SAVEPOINT timeline_items_v1_compat_upgrade");
      } catch {
        // Preserve the migration error.
      }
      throw error;
    }
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
