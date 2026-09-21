import { afterEach, expect, it, vi } from "vitest";
import { AuthDisplayClient } from "../../apps/mobile/src/auth-display-client";
import type { AuthDisplay } from "../../packages/protocol/src/index.js";
afterEach(() => vi.useRealTimers());

it("discards delayed auth replies after backgrounding and refetches on resume without caching", async () => {
  vi.useFakeTimers();
  const items: AuthDisplay[] = [{ operationId: "op", title: "OAuth", links: [{ url: "https://example.test/?state=private", label: "Authorize" }] }];
  let resolve!: (value: { items: AuthDisplay[] }) => void;
  const fetch = vi.fn(() => new Promise<{ items: AuthDisplay[] }>(done => { resolve = done; }));
  const publish = vi.fn();
  const client = new AuthDisplayClient(fetch, publish);
  client.setActive(true); client.setActive(false); resolve({ items });
  await Promise.resolve(); expect(publish).toHaveBeenLastCalledWith([]);
  await vi.advanceTimersByTimeAsync(5000); expect(fetch).toHaveBeenCalledTimes(1);
  client.setActive(true); resolve({ items }); await Promise.resolve();
  expect(publish).toHaveBeenLastCalledWith(items);
  client.setActive(false); expect(publish).toHaveBeenLastCalledWith([]);
});

it("clears auth display on network failure without exposing response errors", async () => {
  vi.useFakeTimers(); const publish = vi.fn();
  const client = new AuthDisplayClient(async () => { throw new Error("private-link"); }, publish);
  client.setActive(true); await Promise.resolve();
  expect(publish).toHaveBeenLastCalledWith([]);
  client.setActive(false);
});
