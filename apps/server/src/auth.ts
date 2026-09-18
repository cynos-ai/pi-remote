import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  deviceSchema,
  type Device,
  type DeviceRevocationResponse,
  type MeResponse,
  type PairResponse,
  type User
} from "@pi-remote/protocol";
import { withTransaction } from "./storage/database.js";
import {
  DeviceRepository,
  OwnerRepository,
  PairingTokenRepository,
  timestampFromMillis
} from "./storage/repositories.js";

export type AuthErrorCode = "UNAUTHENTICATED" | "DEVICE_REVOKED" | "RATE_LIMITED";

export class AuthError extends Error {
  constructor(public readonly code: AuthErrorCode, message: string, public readonly retryAfterSeconds?: number) {
    super(message);
    this.name = "AuthError";
  }
}

export interface AuthContext {
  userId: string;
  deviceId: string;
  user: User;
  device: Device;
}

export interface PairingTokenOutput {
  id: string;
  token: string;
  expiresAt: string;
}

export interface AuthServiceOptions {
  now?: () => number;
  pairingTtlSeconds?: number;
}

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function userDto(owner: { id: string; displayName: string }): User {
  return { id: owner.id, displayName: owner.displayName };
}

export function toDeviceDto(device: {
  id: string;
  name: string;
  createdAt: number;
  revokedAt: number | null;
}): Device {
  return deviceSchema.parse({
    id: device.id,
    name: device.name,
    createdAt: new Date(device.createdAt).toISOString(),
    revokedAt: timestampFromMillis(device.revokedAt)
  });
}

export class FixedWindowRateLimiter {
  private readonly windows = new Map<string, { startedAt: number; count: number }>();

  check(key: string, limit: number, windowMs: number, now = Date.now()): { allowed: boolean; retryAfterSeconds: number } {
    const current = this.windows.get(key);
    if (!current || now - current.startedAt >= windowMs) {
      this.windows.set(key, { startedAt: now, count: 1 });
      this.prune(now, windowMs);
      return { allowed: true, retryAfterSeconds: 0 };
    }
    if (current.count >= limit) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((current.startedAt + windowMs - now) / 1000))
      };
    }
    current.count += 1;
    return { allowed: true, retryAfterSeconds: 0 };
  }

  private prune(now: number, windowMs: number): void {
    if (this.windows.size < 2048) return;
    for (const [key, window] of this.windows) {
      if (now - window.startedAt >= windowMs) this.windows.delete(key);
    }
  }
}

export class AuthService {
  private readonly now: () => number;
  private readonly pairingTtlSeconds: number;
  private readonly owners: OwnerRepository;
  private readonly devices: DeviceRepository;
  private readonly pairingTokens: PairingTokenRepository;

  constructor(private readonly database: DatabaseSync, options: AuthServiceOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.pairingTtlSeconds = options.pairingTtlSeconds ?? 600;
    this.owners = new OwnerRepository(database);
    this.devices = new DeviceRepository(database);
    this.pairingTokens = new PairingTokenRepository(database);
  }

  ensureOwner(input: { id: string; displayName: string }): User {
    return userDto(this.owners.ensure({ id: input.id, displayName: input.displayName, now: this.now() }));
  }

  createPairingToken(userId: string, ttlSeconds = this.pairingTtlSeconds): PairingTokenOutput {
    const owner = this.owners.get(userId);
    if (!owner) throw new AuthError("UNAUTHENTICATED", "pairing owner is not configured");
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > 86400) {
      throw new AuthError("UNAUTHENTICATED", "pairing token lifetime is invalid");
    }
    const now = this.now();
    const token = randomBytes(32).toString("base64url");
    const id = randomUUID();
    this.pairingTokens.create({
      id,
      userId,
      token,
      expiresAt: now + ttlSeconds * 1000,
      now
    });
    return { id, token, expiresAt: new Date(now + ttlSeconds * 1000).toISOString() };
  }

  pair(input: { pairingToken: string; deviceName: string }): PairResponse {
    const now = this.now();
    return withTransaction(this.database, () => {
      const consumed = this.pairingTokens.consume(input.pairingToken, now);
      if (!consumed) throw new AuthError("UNAUTHENTICATED", "pairing token is invalid or expired");
      const owner = this.owners.get(consumed.userId);
      if (!owner) throw new AuthError("UNAUTHENTICATED", "pairing token owner is unavailable");
      const deviceToken = randomBytes(32).toString("base64url");
      const device = this.devices.create({
        id: randomUUID(),
        userId: consumed.userId,
        name: input.deviceName,
        token: deviceToken,
        now
      });
      return {
        deviceId: device.id,
        deviceToken,
        user: userDto(owner)
      };
    });
  }

  authenticate(token: string): AuthContext {
    const device = this.devices.getByToken(token);
    if (!device) throw new AuthError("UNAUTHENTICATED", "valid device authentication is required");
    if (device.revokedAt !== null) throw new AuthError("DEVICE_REVOKED", "device has been revoked");
    return this.contextForDevice(device.userId, device.id);
  }

  /** Rebuild an authenticated context for a ticket-bound device. */
  contextForDevice(userId: string, deviceId: string): AuthContext {
    const device = this.devices.get(deviceId);
    if (!device || device.userId !== userId) throw new AuthError("UNAUTHENTICATED", "device authentication is unavailable");
    if (device.revokedAt !== null) throw new AuthError("DEVICE_REVOKED", "device has been revoked");
    const owner = this.owners.get(device.userId);
    if (!owner) throw new AuthError("UNAUTHENTICATED", "device owner is unavailable");
    this.devices.touch(device.id, this.now());
    return {
      userId: owner.id,
      deviceId: device.id,
      user: userDto(owner),
      device: toDeviceDto(device)
    };
  }

  isDeviceActive(userId: string, deviceId: string): boolean {
    const device = this.devices.get(deviceId);
    return device !== null && device.userId === userId && device.revokedAt === null && this.owners.get(userId) !== null;
  }

  getMe(context: AuthContext): MeResponse {
    return { user: context.user, device: context.device };
  }

  listDevices(userId: string): Device[] {
    return this.devices.list(userId).map(toDeviceDto);
  }

  revokeDevice(userId: string, deviceId: string): DeviceRevocationResponse | null {
    const device = this.devices.revoke(userId, deviceId, this.now());
    if (!device || device.revokedAt === null) return null;
    return { id: device.id, revokedAt: new Date(device.revokedAt).toISOString() };
  }

  static tokenHash(token: string): string {
    return hashSecret(token);
  }
}

export function extractBearerToken(value: string | undefined): string {
  if (value === undefined) throw new AuthError("UNAUTHENTICATED", "valid device authentication is required");
  const match = /^Bearer ([^\s]+)$/i.exec(value);
  if (!match?.[1]) throw new AuthError("UNAUTHENTICATED", "valid device authentication is required");
  return match[1];
}
