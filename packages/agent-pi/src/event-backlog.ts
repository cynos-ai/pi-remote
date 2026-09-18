import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseProtocolEvent, type ProtocolEvent } from "@pi-remote/protocol";

export interface EventBacklogOptions {
  /** Dedicated private queue directory; do not share with the transport spool. */
  spoolDir: string;
  /** Maximum cached events. All queued events also have durable disk copies. */
  memoryLimit?: number;
}

export interface EventBacklogBatch {
  events: ProtocolEvent[];
  leaseId: string | null;
}

interface Lease {
  ids: number[];
  acknowledged: boolean;
}

/** Disk-backed FIFO. take transfers ownership to the worker's ACK-tracked batches. */
export class EventBacklog {
  private readonly root: string;
  private readonly memoryLimit: number;
  private readonly cache = new Map<number, ProtocolEvent>();
  private readonly leases = new Map<string, Lease>();
  private head = 1;
  private tail = 0;
  private closed = false;

  constructor(options: EventBacklogOptions) {
    this.root = resolve(options.spoolDir);
    this.memoryLimit = options.memoryLimit ?? 64;
    if (!Number.isSafeInteger(this.memoryLimit) || this.memoryLimit < 0) throw new Error("invalid backlog memory limit");
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const ids = readdirSync(this.root).filter((name) => /^\d{16}\.event\.json$/.test(name)).map((name) => Number(name.slice(0, 16))).sort((a, b) => a - b);
    if (ids.length) {
      this.head = ids[0]!;
      this.tail = ids[ids.length - 1]!;
      if (ids.length !== this.length) throw new Error("event backlog contains a sequence gap");
    }
  }

  get length(): number { return this.tail - this.head + 1; }

  enqueue(event: ProtocolEvent): void {
    if (this.closed) throw new Error("event backlog is disposed");
    const encoded = JSON.stringify(event);
    const id = this.tail + 1;
    if (!Number.isSafeInteger(id)) throw new Error("event backlog sequence exhausted");
    const path = this.path(id);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const fd = openSync(temporary, "wx", 0o600);
      try { writeFileSync(fd, encoded); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, path);
      this.syncDirectory();
    } catch (error) { rmSync(temporary, { force: true }); throw error; }
    this.tail = id;
    // A count cap alone would still cache arbitrarily large SDK events.
    if (this.cache.size < this.memoryLimit && Buffer.byteLength(encoded) <= 65536) {
      this.cache.set(id, structuredClone(event));
    }
  }

  take(maxCount: number): ProtocolEvent[] {
    const batch = this.takeBatch(maxCount);
    if (batch.leaseId !== null) this.ack(batch.leaseId);
    return batch.events;
  }

  /**
   * Transfer disk records to an ACK-tracked batch. Files remain on disk until
   * the caller acknowledges the batch, so a worker crash cannot silently lose
   * events that already left the in-memory buffer.
   */
  takeBatch(maxCount: number): EventBacklogBatch {
    if (this.closed) throw new Error("event backlog is disposed");
    if (!Number.isSafeInteger(maxCount) || maxCount < 1) throw new Error("invalid backlog batch size");
    const count = Math.min(maxCount, this.length);
    if (count === 0) return { events: [], leaseId: null };
    const result: ProtocolEvent[] = [];
    const ids: number[] = [];
    // Decode the complete batch before transferring any ownership on corrupt input.
    for (let index = 0; index < count; index++) {
      const id = this.head + index;
      ids.push(id);
      result.push(this.cache.get(id) ?? parseProtocolEvent(JSON.parse(readFileSync(this.path(id), "utf8")) as unknown));
    }
    this.head += count;
    const leaseId = randomUUID();
    this.leases.set(leaseId, { ids, acknowledged: false });
    return { events: result, leaseId };
  }

  /** Delete a successfully delivered batch, preserving FIFO cleanup order. */
  ack(leaseId: string): void {
    const lease = this.leases.get(leaseId);
    if (!lease) return;
    lease.acknowledged = true;
    while (true) {
      const first = this.leases.entries().next().value as [string, Lease] | undefined;
      if (!first || !first[1].acknowledged) break;
      for (const id of first[1].ids) {
        rmSync(this.path(id), { force: true });
        this.cache.delete(id);
      }
      this.leases.delete(first[0]);
    }
    this.syncDirectory();
  }

  /** Leaves pending disk records available for recovery; never deletes unsent output. */
  dispose(): void { this.closed = true; this.cache.clear(); }

  private path(id: number): string { return join(this.root, `${String(id).padStart(16, "0")}.event.json`); }
  private syncDirectory(): void {
    const fd = openSync(this.root, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
}
