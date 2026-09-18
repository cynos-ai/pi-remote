import { createHash, randomBytes } from "node:crypto";
import type { AuthContext } from "../auth.js";

interface TicketRecord {
  userId: string;
  deviceId: string;
  expiresAt: number;
  consumed: boolean;
}

export interface IssuedWsTicket {
  ticket: string;
  expiresAt: string;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** In-memory, one-shot ticket store. Raw ticket values never reach SQLite. */
export class WsTicketStore {
  private readonly tickets = new Map<string, TicketRecord>();

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly ttlMs = 60_000
  ) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000) throw new Error("WebSocket ticket TTL is invalid");
  }

  issue(actor: Pick<AuthContext, "userId" | "deviceId">): IssuedWsTicket {
    const ticket = randomBytes(32).toString("base64url");
    const expiresAt = this.now() + this.ttlMs;
    this.tickets.set(digest(ticket), {
      userId: actor.userId,
      deviceId: actor.deviceId,
      expiresAt,
      consumed: false
    });
    this.prune(this.now());
    return { ticket, expiresAt: new Date(expiresAt).toISOString() };
  }

  consume(ticket: string): { userId: string; deviceId: string } | null {
    const record = this.tickets.get(digest(ticket));
    const now = this.now();
    if (!record || record.consumed || record.expiresAt <= now) {
      this.prune(now);
      return null;
    }
    record.consumed = true;
    return { userId: record.userId, deviceId: record.deviceId };
  }

  revokeDevice(deviceId: string): void {
    for (const [key, record] of this.tickets) {
      if (record.deviceId === deviceId) this.tickets.delete(key);
    }
  }

  clear(): void {
    this.tickets.clear();
  }

  private prune(now: number): void {
    for (const [key, record] of this.tickets) {
      if (record.expiresAt <= now || record.consumed) this.tickets.delete(key);
    }
  }
}
