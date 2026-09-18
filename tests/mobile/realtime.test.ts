import { describe, expect, it } from "vitest";
import { toSnapshot, createInitialState, type Snapshot } from "../../packages/protocol/src/index";
import {
  MobileRealtimeClient,
  reconnectDelayMs,
  websocketUrl,
  type MobileWebSocket,
  type WebSocketFactory
} from "../../apps/mobile/src/realtime";

class TimerHarness {
  private readonly callbacks: Array<() => void> = [];

  readonly adapter = {
    set: (callback: () => void) => {
      this.callbacks.push(callback);
      return callback;
    },
    clear: (handle: unknown) => {
      const callback = handle as () => void;
      const index = this.callbacks.indexOf(callback);
      if (index >= 0) this.callbacks.splice(index, 1);
    }
  };

  fireNext(): void {
    this.callbacks.shift()?.();
  }

  get size(): number {
    return this.callbacks.length;
  }
}

class FakeSocket implements MobileWebSocket {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;
  readonly sent: string[] = [];

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  receive(value: unknown): void {
    this.onmessage?.({ data: JSON.stringify(value) });
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = ""): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

function snapshotAt(seq: number): Snapshot {
  const state = createInitialState("session-a");
  state.lastSeq = seq;
  return toSnapshot(state, { historyCursor: null, availableThinkingLevels: [], allowedCommands: ["prompt", "follow_up"] });
}

async function flushMessages(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

const notice = (seq: number) => ({
  schemaVersion: 1,
  sessionId: "session-a",
  seq,
  runId: null,
  operationId: null,
  type: "runtime.notice" as const,
  timestamp: "2026-09-13T00:00:00.000Z",
  payload: { kind: "generic" as const, message: `notice-${seq}` }
});

describe("S10 mobile realtime client", () => {
  it("maps HTTPS base paths to WSS and bounds jittered reconnect delay", () => {
    expect(websocketUrl("https://pi.example.test/remote")).toBe("wss://pi.example.test/remote/v1/ws");
    expect(reconnectDelayMs(0, () => 0)).toBe(750);
    expect(reconnectDelayMs(99, () => 1)).toBe(30_000);
    expect(reconnectDelayMs(5, () => 0.5)).toBe(30_000);
  });

  it("authenticates, subscribes from the durable cursor, de-duplicates, and resyncs gaps", async () => {
    const timers = new TimerHarness();
    const sockets: FakeSocket[] = [];
    const factory: WebSocketFactory = (url, protocol) => {
      void url;
      void protocol;
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    };
    const events: number[] = [];
    const snapshots: number[] = [];
    const api = {
      serverUrl: "https://pi.example.test/remote",
      issueWsTicket: async () => ({ ticket: "one-use-ticket", expiresAt: "2026-09-13T00:01:00.000Z" })
    };
    const client = new MobileRealtimeClient({
      api,
      sessionId: "session-a",
      cursor: 0,
      loadSnapshot: async () => snapshotAt(2),
      onSnapshot: (snapshot) => { snapshots.push(snapshot.snapshotSeq); },
      onEvent: (event) => { events.push(event.seq); },
      socketFactory: factory,
      timer: timers.adapter,
      autoReconnect: true,
      random: () => 0
    });

    client.start();
    expect(timers.size).toBe(1);
    timers.fireNext();
    await Promise.resolve();
    expect(sockets).toHaveLength(1);
    const socket = sockets[0]!;
    socket.open();
    expect(JSON.parse(socket.sent[0]!)).toEqual({ type: "authenticate", ticket: "one-use-ticket" });
    socket.receive({ type: "authenticated", protocolVersion: 1 });
    await Promise.resolve();
    expect(JSON.parse(socket.sent[1]!)).toEqual({ type: "subscribe", sessionId: "session-a", afterSeq: 0 });
    socket.receive({ type: "subscription.ready", sessionId: "session-a", throughSeq: 0 });
    await flushMessages();
    expect(client.status).toBe("connected");

    socket.receive({ type: "event", sessionId: "session-a", event: notice(1) });
    await flushMessages();
    expect(events).toEqual([1]);
    expect(client.cursor).toBe(1);
    socket.receive({ type: "event", sessionId: "session-a", event: notice(1) });
    await flushMessages();
    expect(events).toEqual([1]);

    socket.receive({ type: "event", sessionId: "session-a", event: notice(3) });
    await flushMessages();
    expect(snapshots).toEqual([2]);
    expect(client.cursor).toBe(2);
    expect(timers.size).toBe(1);
    client.stop();
  });
});
