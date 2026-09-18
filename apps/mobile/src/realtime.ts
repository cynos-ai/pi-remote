import {
  wsServerFrameSchema,
  type ProtocolEvent,
  type Snapshot,
  type WsServerFrame
} from "@pi-remote/protocol";
import { MobileApiError, type PiRemoteApi } from "./api/client";

const SOCKET_CONNECTING = 0;
const SOCKET_OPEN = 1;

export type RealtimeStatus =
  | "stopped"
  | "connecting"
  | "authenticating"
  | "connected"
  | "backing_off"
  | "resyncing"
  | "error";

export interface MobileWebSocket {
  readonly readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type WebSocketFactory = (url: string, protocols: string | string[]) => MobileWebSocket;

interface TimerAdapter {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

const defaultTimer: TimerAdapter = {
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
};

const defaultWebSocketFactory: WebSocketFactory = (url, protocols) => {
  return new globalThis.WebSocket(url, protocols) as unknown as MobileWebSocket;
};

export interface RealtimeClientOptions {
  api: Pick<PiRemoteApi, "issueWsTicket" | "serverUrl">;
  sessionId: string;
  cursor?: number;
  loadSnapshot: () => Promise<Snapshot>;
  onSnapshot: (snapshot: Snapshot) => void | Promise<void>;
  onEvent: (event: ProtocolEvent) => void | Promise<void>;
  onStatus?: (status: RealtimeStatus) => void;
  onError?: (error: unknown) => void;
  socketFactory?: WebSocketFactory;
  timer?: TimerAdapter;
  random?: () => number;
  autoReconnect?: boolean;
}

/** Convert the HTTPS API origin/path into the matching WSS endpoint. */
export function websocketUrl(serverUrl: string): string {
  const parsed = new URL(serverUrl);
  parsed.protocol = "wss:";
  parsed.search = "";
  parsed.hash = "";
  const basePath = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname = `${basePath}/v1/ws`;
  return parsed.toString();
}

/** Exponential backoff with bounded jitter, as required by the mobile contract. */
export function reconnectDelayMs(attempt: number, random = Math.random): number {
  const safeAttempt = Math.max(0, Math.floor(attempt));
  const base = Math.min(30_000, 1_000 * (2 ** Math.min(safeAttempt, 5)));
  const jitter = Math.min(1, Math.max(0, random()));
  return Math.min(30_000, Math.round(base * (0.75 + jitter * 0.5)));
}

function jsonFrame(value: unknown): string {
  return JSON.stringify(value);
}

/**
 * One authenticated WSS subscription. The server remains authoritative: the
 * client advances its cursor only after the reducer and its cache callback
 * have accepted the event. A gap or resync frame refreshes the snapshot
 * before another subscription is attempted.
 */
export class MobileRealtimeClient {
  private readonly socketFactory: WebSocketFactory;
  private readonly timer: TimerAdapter;
  private readonly random: () => number;
  private readonly autoReconnect: boolean;
  private socket: MobileWebSocket | null = null;
  private reconnectTimer: unknown;
  private messageChain: Promise<void> = Promise.resolve();
  private connectionGeneration = 0;
  private reconnectAttempt = 0;
  private started = false;
  private appActive = true;
  private resyncing = false;
  private currentStatus: RealtimeStatus = "stopped";
  private currentCursor: number;

  constructor(private readonly options: RealtimeClientOptions) {
    this.socketFactory = options.socketFactory ?? defaultWebSocketFactory;
    this.timer = options.timer ?? defaultTimer;
    this.random = options.random ?? Math.random;
    this.autoReconnect = options.autoReconnect ?? true;
    this.currentCursor = options.cursor ?? 0;
  }

  get cursor(): number {
    return this.currentCursor;
  }

  get status(): RealtimeStatus {
    return this.currentStatus;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.appActive = true;
    this.reconnectAttempt = 0;
    this.scheduleConnect(0);
  }

  stop(): void {
    this.started = false;
    this.resyncing = false;
    this.clearReconnectTimer();
    this.connectionGeneration += 1;
    const socket = this.socket;
    this.socket = null;
    if (socket && (socket.readyState === SOCKET_CONNECTING || socket.readyState === SOCKET_OPEN)) {
      try { socket.close(1000, "client stopped"); } catch { /* best effort */ }
    }
    this.setStatus("stopped");
  }

  /** Backgrounded apps should not spin through reconnect attempts. */
  setAppActive(active: boolean): void {
    if (this.appActive === active) return;
    this.appActive = active;
    if (!active) {
      this.clearReconnectTimer();
      const socket = this.socket;
      this.socket = null;
      this.connectionGeneration += 1;
      if (socket && (socket.readyState === SOCKET_CONNECTING || socket.readyState === SOCKET_OPEN)) {
        try { socket.close(1000, "app backgrounded"); } catch { /* best effort */ }
      }
      return;
    }
    if (this.started) {
      this.reconnectAttempt = 0;
      this.scheduleConnect(0);
    }
  }

  private scheduleConnect(delayMs?: number): void {
    if (!this.started || !this.appActive || this.socket !== null || this.reconnectTimer !== undefined) return;
    if (!this.autoReconnect && delayMs !== 0) {
      this.setStatus("error");
      return;
    }
    const delay = delayMs ?? reconnectDelayMs(this.reconnectAttempt, this.random);
    if (delay > 0) {
      this.setStatus("backing_off");
      this.reconnectAttempt += 1;
    }
    this.reconnectTimer = this.timer.set(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer === undefined) return;
    this.timer.clear(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private async connect(): Promise<void> {
    if (!this.started || !this.appActive || this.socket !== null) return;
    const generation = ++this.connectionGeneration;
    this.setStatus("connecting");
    let ticket: string;
    try {
      ticket = (await this.options.api.issueWsTicket()).ticket;
    } catch (error) {
      if (!this.isCurrentGeneration(generation)) return;
      this.reportError(error);
      if (error instanceof MobileApiError && (error.code === "UNAUTHENTICATED" || error.code === "DEVICE_REVOKED")) {
        this.started = false;
        this.setStatus("error");
        return;
      }
      this.scheduleConnect();
      return;
    }
    if (!this.isCurrentGeneration(generation)) return;
    let socket: MobileWebSocket;
    try {
      socket = this.socketFactory(websocketUrl(this.options.api.serverUrl ?? ""), "pi-remote.v1");
    } catch (error) {
      this.reportError(error);
      this.scheduleConnect();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      if (!this.isCurrentSocket(socket)) return;
      this.setStatus("authenticating");
      try {
        socket.send(jsonFrame({ type: "authenticate", ticket }));
      } catch (error) {
        this.reportError(error);
        try { socket.close(1011, "authentication send failed"); } catch { /* best effort */ }
      }
    };
    socket.onmessage = (event) => {
      this.messageChain = this.messageChain
        .then(() => this.handleMessage(socket, event.data))
        .catch((error: unknown) => {
          this.reportError(error);
          void this.requestResync();
        });
    };
    socket.onerror = (error) => this.reportError(error);
    socket.onclose = (event) => this.handleClose(socket, event.code ?? 0, event.reason ?? "");
  }

  private async handleMessage(socket: MobileWebSocket, raw: unknown): Promise<void> {
    if (!this.isCurrentSocket(socket)) return;
    let value: unknown;
    try {
      value = typeof raw === "string" ? JSON.parse(raw) as unknown : raw;
    } catch {
      throw new Error("服务器 WebSocket 返回了无法解析的响应");
    }
    const parsed = wsServerFrameSchema.safeParse(value);
    if (!parsed.success) throw new Error(`WebSocket 响应格式不符合协议：${parsed.error.message}`);
    await this.handleServerFrame(socket, parsed.data);
  }

  private async handleServerFrame(socket: MobileWebSocket, frame: WsServerFrame): Promise<void> {
    if (frame.type === "authenticated") {
      if (frame.protocolVersion !== 1) throw new Error("服务器 WebSocket 协议版本不兼容");
      socket.send(jsonFrame({ type: "subscribe", sessionId: this.options.sessionId, afterSeq: this.currentCursor }));
      return;
    }
    if (frame.type === "subscription.ready") {
      if (frame.sessionId !== this.options.sessionId) return;
      this.reconnectAttempt = 0;
      this.setStatus("connected");
      return;
    }
    if (frame.type === "event") {
      if (frame.sessionId !== this.options.sessionId) return;
      const event = frame.event;
      if (event.seq <= this.currentCursor) return;
      if (event.seq !== this.currentCursor + 1) {
        await this.requestResync();
        return;
      }
      await this.options.onEvent(event);
      this.currentCursor = event.seq;
      return;
    }
    if (frame.type === "resync_required") {
      if (frame.sessionId !== undefined && frame.sessionId !== this.options.sessionId) return;
      await this.requestResync();
      return;
    }
    // Error frames are actionable even when the server keeps the socket open.
    this.reportError(new MobileApiError(frame.code, frame.message));
    if (frame.code === "UNAUTHENTICATED" || frame.code === "DEVICE_REVOKED") {
      this.started = false;
      this.setStatus("error");
      try { socket.close(4401, "authentication failed"); } catch { /* best effort */ }
    }
  }

  private async requestResync(): Promise<void> {
    if (this.resyncing || !this.started) return;
    this.resyncing = true;
    this.setStatus("resyncing");
    try {
      const snapshot = await this.options.loadSnapshot();
      await this.options.onSnapshot(snapshot);
      this.currentCursor = snapshot.snapshotSeq;
    } catch (error) {
      this.reportError(error);
    } finally {
      this.resyncing = false;
    }
    if (!this.started || !this.appActive) return;
    const socket = this.socket;
    this.socket = null;
    this.connectionGeneration += 1;
    if (socket && (socket.readyState === SOCKET_CONNECTING || socket.readyState === SOCKET_OPEN)) {
      try { socket.close(1000, "snapshot resync"); } catch { /* best effort */ }
    }
    this.scheduleConnect(0);
  }

  private handleClose(socket: MobileWebSocket, code: number, reason: string): void {
    if (!this.isCurrentSocket(socket)) return;
    this.socket = null;
    if (!this.started || !this.appActive) return;
    if (code === 4401) {
      this.started = false;
      this.reportError(new MobileApiError("DEVICE_REVOKED", "设备凭据已失效，请重新配对"));
      this.setStatus("error");
      return;
    }
    if (code !== 1000 && reason.length > 0) this.reportError(new Error(`实时连接已断开：${reason}`));
    this.scheduleConnect();
  }

  private isCurrentGeneration(generation: number): boolean {
    return this.started && this.appActive && generation === this.connectionGeneration;
  }

  private isCurrentSocket(socket: MobileWebSocket): boolean {
    return this.socket === socket && this.started;
  }

  private setStatus(status: RealtimeStatus): void {
    this.currentStatus = status;
    this.options.onStatus?.(status);
  }

  private reportError(error: unknown): void {
    this.options.onError?.(error);
  }
}
