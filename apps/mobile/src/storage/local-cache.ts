export interface MobileSqliteDatabase {
  execAsync(source: string): Promise<void>;
  runAsync(source: string, ...params: unknown[]): Promise<unknown>;
  getFirstAsync<T>(source: string, ...params: unknown[]): Promise<T | null>;
  getAllAsync<T>(source: string, ...params: unknown[]): Promise<T[]>;
  withTransactionAsync(task: () => Promise<void>): Promise<void>;
}

export interface CachedResource<T> {
  value: T;
  cursor: string | null;
  updatedAt: number;
}

interface CacheRow {
  payload_json: string;
  cursor: string | null;
  updated_at: number;
}

const CACHE_SCHEMA = `
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS mobile_cache (
    account_key TEXT NOT NULL,
    resource_key TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    cursor TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (account_key, resource_key)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS mobile_cache_updated_idx
    ON mobile_cache(account_key, updated_at DESC);
`;

export function projectsCacheKey(): string {
  return "projects";
}

export function sessionsCacheKey(projectId: string, archived: "exclude" | "only" | "all"): string {
  return `sessions:${projectId}:${archived}`;
}

export function snapshotCacheKey(sessionId: string): string {
  return `snapshot:${sessionId}`;
}

export function historyCacheKey(sessionId: string): string {
  return `history:${sessionId}`;
}

export class MobileCache {
  private initialized = false;
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly database: MobileSqliteDatabase) {}

  private write(task: () => Promise<void>): Promise<void> {
    const next = this.writes.then(task);
    this.writes = next.catch(() => undefined);
    return next;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.database.execAsync(CACHE_SCHEMA);
    this.initialized = true;
  }

  async saveResource<T>(
    accountKey: string,
    resourceKey: string,
    value: T,
    cursor: string | null = null,
    updatedAt = Date.now()
  ): Promise<void> {
    await this.initialize();
    const payload = JSON.stringify(value);
    await this.write(() => this.database.withTransactionAsync(async () => {
      await this.database.runAsync(
        `INSERT INTO mobile_cache(account_key, resource_key, payload_json, cursor, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(account_key, resource_key) DO UPDATE SET
           payload_json = excluded.payload_json,
           cursor = excluded.cursor,
           updated_at = excluded.updated_at`,
        accountKey,
        resourceKey,
        payload,
        cursor,
        updatedAt
      );
    }));
  }

  async getResource<T>(accountKey: string, resourceKey: string): Promise<CachedResource<T> | null> {
    await this.initialize();
    const row = await this.database.getFirstAsync<CacheRow>(
      "SELECT payload_json, cursor, updated_at FROM mobile_cache WHERE account_key = ? AND resource_key = ?",
      accountKey,
      resourceKey
    );
    if (row === null || typeof row.payload_json !== "string") return null;
    try {
      return {
        value: JSON.parse(row.payload_json) as T,
        cursor: row.cursor ?? null,
        updatedAt: Number(row.updated_at)
      };
    } catch {
      // A corrupted cache is not a reason to block the account. The next
      // successful response replaces it in one transaction.
      return null;
    }
  }

  async listResources<T>(accountKey: string, prefix: string): Promise<T[]> {
    await this.initialize();
    const rows = await this.database.getAllAsync<CacheRow>(
      "SELECT payload_json, cursor, updated_at FROM mobile_cache WHERE account_key = ? AND substr(resource_key, 1, ?) = ? ORDER BY updated_at",
      accountKey, prefix.length, prefix
    );
    // Pending commands must fail closed on corruption, never silently disappear.
    return rows.map((row) => JSON.parse(row.payload_json) as T);
  }

  async deleteResource(accountKey: string, resourceKey: string): Promise<void> {
    await this.initialize();
    await this.write(async () => {
      await this.database.runAsync("DELETE FROM mobile_cache WHERE account_key = ? AND resource_key = ?", accountKey, resourceKey);
    });
  }

  async deleteAccount(accountKey: string): Promise<void> {
    await this.initialize();
    await this.write(() => this.database.withTransactionAsync(async () => {
      await this.database.runAsync("DELETE FROM mobile_cache WHERE account_key = ?", accountKey);
    }));
  }
}

export async function openMobileCache(databaseName = "pi-remote.db"): Promise<MobileCache> {
  // Keep the native module out of the Node-side contract tests. Metro still
  // resolves this dynamic import into the native / web Expo bundle.
  const { openDatabaseAsync } = await import("expo-sqlite");
  const database = await openDatabaseAsync(databaseName);
  const cache = new MobileCache(database as unknown as MobileSqliteDatabase);
  await cache.initialize();
  return cache;
}
