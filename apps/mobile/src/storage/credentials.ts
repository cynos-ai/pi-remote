import type { User } from "@pi-remote/protocol";
import { normalizeServerUrl, type DeviceCredentials } from "../api/client";

export const CREDENTIALS_KEY = "pi-remote.credentials.v1";

export interface CredentialsStoreAdapter {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

interface SerializedCredentials {
  baseUrl: string;
  deviceId: string;
  deviceToken: string;
  user: User;
}

function isUser(value: unknown): value is User {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === "string" && candidate.id.length > 0
    && typeof candidate.displayName === "string" && candidate.displayName.length > 0;
}

export function parseStoredCredentials(value: unknown): DeviceCredentials | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<SerializedCredentials>;
  if (typeof candidate.baseUrl !== "string" || typeof candidate.deviceId !== "string"
    || typeof candidate.deviceToken !== "string" || candidate.deviceToken.length === 0
    || !isUser(candidate.user)) return null;
  let baseUrl: string;
  try {
    baseUrl = normalizeServerUrl(candidate.baseUrl);
  } catch {
    return null;
  }
  return {
    baseUrl,
    deviceId: candidate.deviceId,
    deviceToken: candidate.deviceToken,
    user: candidate.user
  };
}

export function serializeCredentials(credentials: DeviceCredentials): string {
  return JSON.stringify({
    baseUrl: credentials.baseUrl,
    deviceId: credentials.deviceId,
    deviceToken: credentials.deviceToken,
    user: credentials.user
  } satisfies SerializedCredentials);
}

export function accountCacheKey(credentials: Pick<DeviceCredentials, "baseUrl" | "deviceId" | "user">): string {
  // This identifier is intentionally not a secret. It separates local data by
  // server, owner, and device without ever copying the bearer token to SQLite.
  return [credentials.baseUrl, credentials.user.id, credentials.deviceId].join("\u001f");
}

export class SecureCredentialsStore {
  constructor(private readonly adapter: CredentialsStoreAdapter) {}

  async load(): Promise<DeviceCredentials | null> {
    const raw = await this.adapter.getItemAsync(CREDENTIALS_KEY);
    if (raw === null) return null;
    try {
      return parseStoredCredentials(JSON.parse(raw) as unknown);
    } catch {
      return null;
    }
  }

  async save(credentials: DeviceCredentials): Promise<void> {
    await this.adapter.setItemAsync(CREDENTIALS_KEY, serializeCredentials(credentials));
  }

  async clear(): Promise<void> {
    await this.adapter.deleteItemAsync(CREDENTIALS_KEY);
  }
}
