import { describe, expect, it } from "vitest";
import {
  accountCacheKey,
  parseStoredCredentials,
  SecureCredentialsStore,
  serializeCredentials,
  type CredentialsStoreAdapter
} from "../../apps/mobile/src/storage/credentials";
import type { DeviceCredentials } from "../../apps/mobile/src/api/client";

const stored: DeviceCredentials = {
  baseUrl: "https://pi.example.test",
  deviceId: "device-a",
  deviceToken: "bearer-secret",
  user: { id: "owner-a", displayName: "Owner A" }
};

class MemoryStore implements CredentialsStoreAdapter {
  value: string | null = null;

  async getItemAsync(): Promise<string | null> {
    return this.value;
  }

  async setItemAsync(_key: string, value: string): Promise<void> {
    this.value = value;
  }

  async deleteItemAsync(): Promise<void> {
    this.value = null;
  }
}

describe("S09 secure credential boundary", () => {
  it("round-trips only valid credentials and rejects malformed storage", () => {
    expect(parseStoredCredentials(JSON.parse(serializeCredentials(stored)))).toEqual(stored);
    expect(parseStoredCredentials(null)).toBeNull();
    expect(parseStoredCredentials({ ...stored, baseUrl: "http://pi.example.test" })).toBeNull();
    expect(parseStoredCredentials({ ...stored, deviceToken: "" })).toBeNull();
    expect(parseStoredCredentials({ ...stored, user: { id: "", displayName: "Owner A" } })).toBeNull();
    expect(parseStoredCredentials({ ...stored, extra: "must be rejected" })).toEqual(expect.objectContaining(stored));
  });

  it("keeps account cache identity separate from the bearer token", () => {
    const key = accountCacheKey(stored);
    expect(key).toContain(stored.baseUrl);
    expect(key).toContain(stored.user.id);
    expect(key).toContain(stored.deviceId);
    expect(key).not.toContain(stored.deviceToken);
    expect(accountCacheKey({ ...stored, deviceId: "device-b" })).not.toBe(key);
    expect(accountCacheKey({ ...stored, user: { id: "owner-b", displayName: "Owner B" } })).not.toBe(key);
  });

  it("stores credentials through the injected secure adapter and clears them", async () => {
    const adapter = new MemoryStore();
    const store = new SecureCredentialsStore(adapter);
    await store.save(stored);
    expect(adapter.value).toContain(stored.deviceToken);
    await expect(store.load()).resolves.toEqual(stored);
    adapter.value = "{broken";
    await expect(store.load()).resolves.toBeNull();
    await store.save(stored);
    await store.clear();
    await expect(store.load()).resolves.toBeNull();
  });
});
