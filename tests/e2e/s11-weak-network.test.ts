import { describe, expect, it } from "vitest";
import { createInitialState, toSnapshot, type Snapshot } from "../../packages/protocol/src/index.js";
import { MobileApiError } from "../../apps/mobile/src/api/client";
import { MobileCache, snapshotCacheKey } from "../../apps/mobile/src/storage/local-cache";
import { MobileRealtimeClient } from "../../apps/mobile/src/realtime";
import {
  DeterministicTimer,
  MemoryMobileSqlite,
  ScriptedSocketNetwork,
  flushMicrotasks
} from "./harness.js";

function snapshotAt(sequence: number): Snapshot {
  const state = createInitialState("s11-mobile-session", {
    projectId: "s11-mobile-project",
    title: "S11 mobile session"
  });
  state.lastSeq = sequence;
  return toSnapshot(state, {
    historyCursor: null,
    availableThinkingLevels: ["low", "high"],
    allowedCommands: ["prompt", "follow_up", "steer"]
  });
}

function notice(seq: number): Record<string, unknown> {
  return {
    schemaVersion: 1,
    sessionId: "s11-mobile-session",
    seq,
    runId: null,
    operationId: null,
    type: "runtime.notice",
    timestamp: "2026-09-13T00:00:00.000Z",
    payload: { kind: "generic", message: `s11-${seq}` }
  };
}

describe("S11 weak-network mobile contract", () => {
  it("replays after a gap, ignores duplicate frames, survives cache loss, and reconnects on foreground", async () => {
    const cache = new MobileCache(new MemoryMobileSqlite());
    const accountKey = "s11-account";
    await cache.saveResource(accountKey, snapshotCacheKey("s11-mobile-session"), snapshotAt(1), "1", 1);
    expect(await cache.getResource(accountKey, snapshotCacheKey("s11-mobile-session"))).not.toBeNull();
    await cache.deleteAccount(accountKey);
    expect(await cache.getResource(accountKey, snapshotCacheKey("s11-mobile-session"))).toBeNull();

    const timer = new DeterministicTimer();
    const network = new ScriptedSocketNetwork();
    const appliedEvents: number[] = [];
    const loadedSnapshots: number[] = [];
    let ticketNumber = 0;
    const client = new MobileRealtimeClient({
      api: {
        serverUrl: "https://s11.example.test/remote",
        issueWsTicket: async () => ({
          ticket: `s11-ticket-${++ticketNumber}`,
          expiresAt: "2026-09-13T00:10:00.000Z"
        })
      },
      sessionId: "s11-mobile-session",
      cursor: 0,
      loadSnapshot: async () => snapshotAt(2),
      onSnapshot: async (snapshot) => {
        loadedSnapshots.push(snapshot.snapshotSeq);
        await cache.saveResource(accountKey, snapshotCacheKey("s11-mobile-session"), snapshot, String(snapshot.snapshotSeq));
      },
      onEvent: async (event) => {
        appliedEvents.push(event.seq);
        await flushMicrotasks(1);
      },
      socketFactory: network.factory,
      timer: timer.adapter,
      random: () => 0
    });

    client.start();
    expect(timer.delays).toEqual([0]);
    timer.fireNext();
    await flushMicrotasks();
    const first = network.sockets[0];
    if (!first) throw new Error("first S11 scripted socket was not created");
    first.open();
    first.receive({ type: "authenticated", protocolVersion: 1 });
    await flushMicrotasks();
    expect(JSON.parse(first.sent[1] ?? "{}")).toEqual({
      type: "subscribe",
      sessionId: "s11-mobile-session",
      afterSeq: 0
    });
    first.receive({ type: "subscription.ready", sessionId: "s11-mobile-session", throughSeq: 0 });
    await flushMicrotasks();

    first.receive({ type: "event", sessionId: "s11-mobile-session", event: notice(1) });
    await flushMicrotasks();
    first.receive({ type: "event", sessionId: "s11-mobile-session", event: notice(1) });
    await flushMicrotasks();
    expect(appliedEvents).toEqual([1]);
    expect(client.cursor).toBe(1);

    // Frame 2 is lost, then frame 3 arrives. The client must snapshot before
    // opening another subscription, so the durable cursor never jumps to 3.
    first.receive({ type: "event", sessionId: "s11-mobile-session", event: notice(3) });
    await flushMicrotasks(12);
    expect(loadedSnapshots).toEqual([2]);
    expect(client.cursor).toBe(2);
    expect(await cache.getResource(accountKey, snapshotCacheKey("s11-mobile-session"))).toMatchObject({ cursor: "2" });
    expect(timer.delays).toEqual([0]);

    timer.fireNext();
    await flushMicrotasks();
    const second = network.sockets[1];
    if (!second) throw new Error("second S11 scripted socket was not created");
    second.open();
    second.receive({ type: "authenticated", protocolVersion: 1 });
    await flushMicrotasks();
    expect(JSON.parse(second.sent[1] ?? "{}")).toMatchObject({ afterSeq: 2 });
    second.receive({ type: "subscription.ready", sessionId: "s11-mobile-session", throughSeq: 2 });
    second.receive({ type: "event", sessionId: "s11-mobile-session", event: notice(3) });
    await flushMicrotasks(10);
    expect(appliedEvents).toEqual([1, 3]);
    expect(client.cursor).toBe(3);

    // A backgrounded app cancels backoff. Returning to the foreground starts
    // one immediate connection attempt without replaying a command or form.
    second.close(1006, "network changed");
    await flushMicrotasks();
    expect(timer.size).toBe(1);
    client.setAppActive(false);
    expect(timer.size).toBe(0);
    expect(network.sockets).toHaveLength(2);
    client.setAppActive(true);
    expect(timer.delays).toEqual([0]);
    timer.fireNext();
    await flushMicrotasks();
    expect(network.sockets).toHaveLength(3);
    client.stop();
  });

  it("stops retrying when the server reports a revoked device", async () => {
    const timer = new DeterministicTimer();
    const network = new ScriptedSocketNetwork();
    const statuses: string[] = [];
    const errors: unknown[] = [];
    const client = new MobileRealtimeClient({
      api: {
        serverUrl: "https://s11.example.test",
        issueWsTicket: async () => {
          throw new MobileApiError("DEVICE_REVOKED", "device revoked", 401);
        }
      },
      sessionId: "s11-mobile-session",
      loadSnapshot: async () => snapshotAt(0),
      onSnapshot: () => undefined,
      onEvent: () => undefined,
      onStatus: (status) => statuses.push(status),
      onError: (error) => errors.push(error),
      socketFactory: network.factory,
      timer: timer.adapter
    });

    client.start();
    timer.fireNext();
    await flushMicrotasks(8);
    expect(client.status).toBe("error");
    expect(timer.size).toBe(0);
    expect(network.sockets).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(statuses).toContain("error");
  });
});
