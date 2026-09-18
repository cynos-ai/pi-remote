import { execFileSync } from "node:child_process";
import { PendingCommands } from "../../apps/mobile/src/pending-commands";
import { PiRemoteApi } from "../../apps/mobile/src/api/client";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  historyCacheKey,
  MobileCache,
  projectsCacheKey,
  sessionsCacheKey,
  snapshotCacheKey,
  type MobileSqliteDatabase
} from "../../apps/mobile/src/storage/local-cache";

class NodeSqliteAdapter implements MobileSqliteDatabase {
  failNextTransaction = false;

  constructor(private readonly database: DatabaseSync) {}

  async execAsync(source: string): Promise<void> {
    this.database.exec(source);
  }

  async runAsync(source: string, ...params: unknown[]): Promise<unknown> {
    const statement = this.database.prepare(source);
    return statement.run(...params as Parameters<typeof statement.run>);
  }

  async getFirstAsync<T>(source: string, ...params: unknown[]): Promise<T | null> {
    const statement = this.database.prepare(source);
    return (statement.get(...params as Parameters<typeof statement.get>) as T | undefined) ?? null;
  }

  async getAllAsync<T>(source: string, ...params: unknown[]): Promise<T[]> {
    const statement = this.database.prepare(source);
    return statement.all(...params as Parameters<typeof statement.all>) as T[];
  }

  async withTransactionAsync(task: () => Promise<void>): Promise<void> {
    this.database.exec("BEGIN");
    try {
      await task();
      if (this.failNextTransaction) {
        this.failNextTransaction = false;
        throw new Error("injected transaction failure");
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

interface Fixture {
  root: string;
  database: DatabaseSync;
  adapter: NodeSqliteAdapter;
  cache: MobileCache;
}

const fixtures: Fixture[] = [];

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "pi-remote-s09-cache-"));
  const database = new DatabaseSync(join(root, "mobile.sqlite"));
  const adapter = new NodeSqliteAdapter(database);
  const cache = new MobileCache(adapter);
  await cache.initialize();
  const fixture = { root, database, adapter, cache };
  fixtures.push(fixture);
  return fixture;
}

afterEach(async () => {
  while (fixtures.length > 0) {
    const fixture = fixtures.pop();
    if (!fixture) continue;
    fixture.database.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

describe("S09 SQLite cache", () => {
  it("serializes overlapping draft, snapshot and pending writes without nested transactions", async () => {
    const { cache } = await createFixture();
    await Promise.all([
      cache.saveResource("owner", "editor", { text: "first" }),
      cache.saveResource("owner", "snapshot", { seq: 7 }),
      cache.saveResource("owner", "editor", { text: "latest" })
    ]);
    expect((await cache.getResource("owner", "editor"))?.value).toEqual({ text: "latest" });
    expect((await cache.getResource("owner", "snapshot"))?.value).toEqual({ seq: 7 });
  });
  it("isolates resources by account and uses stable resource keys", async () => {
    const { cache } = await createFixture();
    expect(projectsCacheKey()).toBe("projects");
    expect(sessionsCacheKey("project/a", "all")).toBe("sessions:project/a:all");
    expect(snapshotCacheKey("session-a")).toBe("snapshot:session-a");
    expect(historyCacheKey("session-a")).toBe("history:session-a");

    await cache.saveResource("server\u001fowner-a\u001fdevice-a", projectsCacheKey(), { items: ["A"] }, "cursor-a", 100);
    await cache.saveResource("server\u001fowner-b\u001fdevice-b", projectsCacheKey(), { items: ["B"] }, "cursor-b", 200);
    await expect(cache.getResource("server\u001fowner-a\u001fdevice-a", projectsCacheKey())).resolves.toEqual({
      value: { items: ["A"] },
      cursor: "cursor-a",
      updatedAt: 100
    });
    await expect(cache.getResource("server\u001fowner-b\u001fdevice-b", projectsCacheKey())).resolves.toEqual({
      value: { items: ["B"] },
      cursor: "cursor-b",
      updatedAt: 200
    });
  });

  it("commits payload and cursor together, preserving the previous pair on rollback", async () => {
    const { cache, adapter } = await createFixture();
    await cache.saveResource("account-a", "history:session-a", { items: ["old"] }, "cursor-old", 100);
    adapter.failNextTransaction = true;

    await expect(cache.saveResource("account-a", "history:session-a", { items: ["new"] }, "cursor-new", 200))
      .rejects.toThrow("injected transaction failure");
    await expect(cache.getResource<{ items: string[] }>("account-a", "history:session-a")).resolves.toEqual({
      value: { items: ["old"] },
      cursor: "cursor-old",
      updatedAt: 100
    });
  });

  it("deletes only the selected account and never stores a bearer token column", async () => {
    const { cache, database } = await createFixture();
    await cache.saveResource("account-a", "projects", { token: "payload data" }, null, 100);
    await cache.saveResource("account-b", "projects", { items: ["other"] }, null, 100);
    const columns = database.prepare("PRAGMA table_info(mobile_cache)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).not.toContain("device_token");
    await cache.deleteAccount("account-a");
    await expect(cache.getResource("account-a", "projects")).resolves.toBeNull();
    await expect(cache.getResource("account-b", "projects")).resolves.toEqual({
      value: { items: ["other"] },
      cursor: null,
      updatedAt: 100
    });
  });
});


describe("R13 durable command identity", () => {
  it("reconciles two lost responses after SQLite reopen with one command and one shell effect", async () => {
    const fixture = await createFixture();
    const effects = join(fixture.root, "effects.txt");
    const receipts = new Map<string, { body: string; commandId: string }>();
    let losses = 2;
    const api = new PiRemoteApi("https://example.test", {
      fetchImpl: async (_url, init) => {
        const key = (init!.headers as Record<string, string>)["Idempotency-Key"]!;
        const body = String(init!.body);
        let stored = receipts.get(key);
        if (!stored) {
          // Deterministic accepting-server fixture with a real shell side effect.
          stored = { body, commandId: `command-${receipts.size + 1}` };
          receipts.set(key, stored);
          execFileSync("sh", ["-c", 'printf "effect\\n" >> "$1"', "sh", effects]);
        }
        expect(body).toBe(stored.body);
        if (losses-- > 0) throw new Error("accepted, response lost");
        return new Response(JSON.stringify({ commandId: stored.commandId, state: "completed" }), { status: 200 });
      }
    });
    let editorSyncs = 0;
    const store = new PendingCommands(fixture.cache, "owner", api, async () => {
      editorSyncs += 1;
      expect(await store.list("session")).toHaveLength(1);
    });
    const command = { kind: "bash" as const, payload: { command: "printf effect", excludeFromContext: false } };
    const original = await store.prepare("session", command);
    await expect(store.reconcile(original)).rejects.toMatchObject({ code: "NETWORK_UNAVAILABLE" });
    expect(editorSyncs).toBe(1);
    expect(receipts.size).toBe(1);
    fixture.database.close();
    fixture.database = new DatabaseSync(join(fixture.root, "mobile.sqlite"));
    fixture.adapter = new NodeSqliteAdapter(fixture.database);
    fixture.cache = new MobileCache(fixture.adapter);
    const restarted = new PendingCommands(fixture.cache, "owner", api, async () => { editorSyncs += 1; });
    const recovered = await restarted.list("session");
    expect(recovered).toEqual([{ ...original, phase: "unknown" }]);
    expect(await new PendingCommands(fixture.cache, "other-owner", api).list("session")).toEqual([]);
    expect(await restarted.list("other-session")).toEqual([]);
    // Even an edited in-memory caller cannot replace the persisted request.
    await restarted.reconcile({ ...recovered[0]!, command: { kind: "prompt", payload: { text: "edited" } } });
    expect(receipts.size).toBe(1);
    expect(editorSyncs).toBe(1);
    expect(await readFile(effects, "utf8")).toBe("effect\n");
    expect(await restarted.list("session")).toEqual([]);
    const intentionalRepeat = await restarted.prepare("session", command);
    expect(intentionalRepeat.key).not.toBe(original.key);
    await restarted.reconcile(intentionalRepeat);
    expect(receipts.size).toBe(2);
    expect(await readFile(effects, "utf8")).toBe("effect\neffect\n");
  });

  it("does not send when persistence fails and retains ambiguous malformed receipts", async () => {
    const { cache, adapter } = await createFixture();
    let sends = 0;
    const api = new PiRemoteApi("https://example.test", { fetchImpl: async () => {
      sends += 1;
      return new Response("truncated receipt", { status: 200 });
    } });
    const store = new PendingCommands(cache, "owner", api);
    adapter.failNextTransaction = true;
    await expect(store.prepare("session", { kind: "prompt", payload: { text: "hello" } })).rejects.toThrow();
    expect(sends).toBe(0);
    expect(await store.list("session")).toEqual([]);
    const pending = await store.prepare("session", { kind: "prompt", payload: { text: "hello" } });
    await expect(store.reconcile(pending)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    expect(await store.list("session")).toEqual([{ ...pending, phase: "unknown" }]);
  });
  it("can answer a startup form even when editor synchronization is unavailable", async () => {
    const { cache } = await createFixture();
    const api = new PiRemoteApi("https://example.test", { fetchImpl: async () =>
      new Response(JSON.stringify({ commandId: "answer-command", state: "completed" }), { status: 200 }) });
    const store = new PendingCommands(cache, "owner", api, async () => { throw new Error("editor stalled"); });
    const pending = await store.prepare("session", { kind: "respond", payload: {
      operationId: "initialization", interactionId: "form", response: { confirmed: true }
    } });
    await expect(store.reconcile(pending)).resolves.toMatchObject({ commandId: "answer-command" });
    expect(await store.list("session")).toEqual([]);
  });

});
