import { mkdir } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrateDatabase } from "./migrations.js";

export interface OpenDatabaseOptions {
  filename: string;
  now?: number;
}

function configureDatabase(options: OpenDatabaseOptions): DatabaseSync {
  const database = new DatabaseSync(options.filename);
  try {
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA synchronous = FULL");
    database.exec("PRAGMA busy_timeout = 5000");
    migrateDatabase(database, options.now ?? Date.now());
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

/** Synchronous variant used while constructing the Fastify application. */
export function openServerDatabaseSync(options: OpenDatabaseOptions): DatabaseSync {
  if (options.filename !== ":memory:") mkdirSync(dirname(options.filename), { recursive: true });
  return configureDatabase(options);
}

export async function openServerDatabase(options: OpenDatabaseOptions): Promise<DatabaseSync> {
  if (options.filename !== ":memory:") await mkdir(dirname(options.filename), { recursive: true });
  return configureDatabase(options);
}

export function withTransaction<T>(database: DatabaseSync, callback: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = callback();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the original application error.
    }
    throw error;
  }
}
