import type { IncomingMessage, Server } from "node:http";
import type { Socket } from "node:net";
import type { DatabaseSync } from "node:sqlite";
import { readEvents, type ArtifactRecord } from "../storage/index.js";
import type { AuthContext, AuthService } from "../auth.js";
import {
  type ProtocolEvent,
  type WsControlFrame,
  wsAuthenticateSchema,
  wsControlFrameSchema,
  wsServerFrameSchema,
  wsSubscribeSchema,
  wsTicketResponseSchema,
  wsUnsubscribeSchema,
  type WsServerFrame,
  type Attachment
} from "@pi-remote/protocol";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { ArtifactStore, type ArtifactDownload } from "./artifacts.js";
import { WsTicketStore, type IssuedWsTicket } from "./tickets.js";

export const WS_SUBPROTOCOL = "pi-remote.v1";
export const DEFAULT_WS_MAX_FRAME_BYTES = 1024 * 1024;
export const DEFAULT_WS_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

export interface RealtimeHubOptions {
  artifactRoot: string;
  maxSubscriptions?: number;
  maxFrameBytes?: number;
  maxBufferedBytes?: number;
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  pongTimeoutMs?: number;
  authTimeoutMs?: number;
  ticketTtlMs?: number;
  artifactMaxBytes?: number;
  sessionArtifactQuotaBytes?: number;
  now?: () => number;
}

export class RealtimeError extends Error {
  constructor(
    public readonly code: "NOT_FOUND" | "ARTIFACT_UNAVAILABLE",
    message: string
  ) {
    super(message);
    this.name = "RealtimeError";
  }
}

interface Subscription {
  sessionId: string;
  cursor: number;
  replayTarget: number;
  ready: boolean;
  pumping: boolean;
}

interface ClientConnection {
  socket: WebSocket;
  authenticated: AuthContext | null;
  authTimer: ReturnType<typeof setTimeout> | undefined;
  isAlive: boolean;
  lastPongAt: number;
  subscriptions: Map<string, Subscription>;
  messageChain: Promise<void>;
}

function rawDataText(data: RawData): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

function unrefTimer(timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval> | undefined): void {
  if (timer === undefined) return;
  (timer as unknown as { unref?: () => void }).unref?.();
}

/** Truncate by bytes while preserving both the beginning and the tail. */
function truncateText(value: string, maximumBytes: number): string {
  if (maximumBytes <= 0) return "";
  const source = Buffer.from(value, "utf8");
  if (source.byteLength <= maximumBytes) return value;
  const marker = Buffer.from("\n…[truncated for mobile display]…\n", "utf8");
  if (maximumBytes <= marker.byteLength) return source.subarray(0, maximumBytes).toString("utf8");
  const available = maximumBytes - marker.byteLength;
  const headBytes = Math.floor(available / 3);
  const tailBytes = available - headBytes;
  const head = source.subarray(0, headBytes).toString("utf8");
  const tail = source.subarray(Math.max(headBytes, source.byteLength - tailBytes)).toString("utf8");
  return `${head}${marker.toString("utf8")}${tail}`;
}

function protocolFrame(value: unknown): WsServerFrame {
  return wsServerFrameSchema.parse(value);
}

function offeredProtocols(request: IncomingMessage): Set<string> {
  const header = request.headers["sec-websocket-protocol"];
  const value = Array.isArray(header) ? header.join(",") : header ?? "";
  return new Set(value.split(",").map((item) => item.trim()).filter(Boolean));
}

function rejectUpgrade(socket: Socket, status: number, message: string): void {
  if (socket.destroyed) return;
  const body = `${message}\n`;
  socket.end(
    `HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
  );
}

function sessionOwner(database: DatabaseSync, sessionId: string): string | null {
  const row = database.prepare(`
    SELECT p.user_id
    FROM sessions s JOIN projects p ON p.id = s.project_id
    WHERE s.id = ?
  `).get(sessionId) as { user_id?: unknown } | undefined;
  return typeof row?.user_id === "string" ? row.user_id : null;
}

function highWater(database: DatabaseSync, sessionId: string): number | null {
  const row = database.prepare("SELECT last_event_seq FROM sessions WHERE id = ?").get(sessionId) as { last_event_seq?: unknown } | undefined;
  if (!row) return null;
  const value = typeof row.last_event_seq === "bigint" ? Number(row.last_event_seq) : Number(row.last_event_seq);
  if (!Number.isSafeInteger(value) || value < 0) throw new RealtimeError("ARTIFACT_UNAVAILABLE", "session event sequence is invalid");
  return value;
}

function eventPayload(event: ProtocolEvent): Record<string, unknown> {
  return event.payload as Record<string, unknown>;
}

function setPayloadText(payload: Record<string, unknown>, maximumBytes: number): void {
  const output = payload.output;
  if (output !== null && typeof output === "object" && !Array.isArray(output)) {
    const outputRecord = output as Record<string, unknown>;
    if (typeof outputRecord.text === "string") outputRecord.text = truncateText(outputRecord.text, maximumBytes);
  }
  if (typeof payload.delta === "string") payload.delta = truncateText(payload.delta, maximumBytes);
  const block = payload.block;
  if (block !== null && typeof block === "object" && !Array.isArray(block)) {
    const blockRecord = block as Record<string, unknown>;
    if (typeof blockRecord.text === "string") blockRecord.text = truncateText(blockRecord.text, maximumBytes);
    if (typeof blockRecord.argumentsText === "string") blockRecord.argumentsText = truncateText(blockRecord.argumentsText, maximumBytes);
  }
  const blocks = payload.blocks;
  if (Array.isArray(blocks)) {
    for (const item of blocks) {
      if (item !== null && typeof item === "object" && !Array.isArray(item)) {
        const blockRecord = item as Record<string, unknown>;
        if (typeof blockRecord.text === "string") blockRecord.text = truncateText(blockRecord.text, maximumBytes);
        if (typeof blockRecord.argumentsText === "string") blockRecord.argumentsText = truncateText(blockRecord.argumentsText, maximumBytes);
      }
    }
  }
}

/**
 * Streams committed events one at a time. The database remains authoritative
 * across disconnects; the in-memory cursor is only a delivery position.
 */
export class RealtimeHub {
  private readonly tickets: WsTicketStore;
  private readonly artifacts: ArtifactStore;
  private readonly clients = new Set<ClientConnection>();
  private readonly now: () => number;
  private readonly maxSubscriptions: number;
  private readonly maxFrameBytes: number;
  private readonly maxBufferedBytes: number;
  private readonly pollIntervalMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly pongTimeoutMs: number;
  private readonly authTimeoutMs: number;
  private readonly wss = new WebSocketServer({
    noServer: true,
    maxPayload: 64 * 1024,
    perMessageDeflate: false,
    handleProtocols: (protocols) => protocols.has(WS_SUBPROTOCOL) ? WS_SUBPROTOCOL : ""
  });
  private server: Server | null = null;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private readonly handleUpgrade = (request: IncomingMessage, socket: Socket, head: Buffer): void => {
    let path: string;
    try {
      path = new URL(request.url ?? "/", "http://localhost").pathname;
    } catch {
      rejectUpgrade(socket, 400, "Bad Request");
      return;
    }
    if (path !== "/v1/ws") {
      rejectUpgrade(socket, 404, "Not Found");
      return;
    }
    if (!offeredProtocols(request).has(WS_SUBPROTOCOL)) {
      rejectUpgrade(socket, 426, "Upgrade Required");
      return;
    }
    this.wss.handleUpgrade(request, socket, head, (client) => this.accept(client));
  };

  constructor(
    private readonly database: DatabaseSync,
    private readonly auth: AuthService,
    options: RealtimeHubOptions
  ) {
    this.now = options.now ?? (() => Date.now());
    this.maxSubscriptions = options.maxSubscriptions ?? 4;
    this.maxFrameBytes = options.maxFrameBytes ?? DEFAULT_WS_MAX_FRAME_BYTES;
    this.maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_WS_MAX_BUFFERED_BYTES;
    this.pollIntervalMs = options.pollIntervalMs ?? 100;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 25_000;
    this.pongTimeoutMs = options.pongTimeoutMs ?? 60_000;
    this.authTimeoutMs = options.authTimeoutMs ?? 5_000;
    if (!Number.isSafeInteger(this.maxSubscriptions) || this.maxSubscriptions < 1) throw new Error("WebSocket subscription limit is invalid");
    if (!Number.isSafeInteger(this.maxFrameBytes) || this.maxFrameBytes < 512) throw new Error("WebSocket frame limit is invalid");
    if (!Number.isSafeInteger(this.maxBufferedBytes) || this.maxBufferedBytes < 1) throw new Error("WebSocket buffer limit is invalid");
    this.tickets = new WsTicketStore(this.now, options.ticketTtlMs ?? 60_000);
    this.artifacts = new ArtifactStore(database, {
      rootDir: options.artifactRoot,
      maxArtifactBytes: options.artifactMaxBytes,
      sessionQuotaBytes: options.sessionArtifactQuotaBytes,
      now: this.now
    });
    this.wss.on("connection", (socket) => {
      socket.on("error", () => {
        // The close event owns connection cleanup. Avoid surfacing a socket
        // error as an uncaught process exception.
      });
    });
  }

  attach(server: Server): void {
    if (this.server !== null) return;
    this.server = server;
    server.on("upgrade", this.handleUpgrade);
    this.pollTimer = setInterval(() => this.poll(), this.pollIntervalMs);
    this.heartbeatTimer = setInterval(() => this.heartbeat(), this.heartbeatIntervalMs);
    unrefTimer(this.pollTimer);
    unrefTimer(this.heartbeatTimer);
  }

  issueTicket(actor: AuthContext): IssuedWsTicket {
    return wsTicketResponseSchema.parse(this.tickets.issue(actor));
  }

  revokeDevice(deviceId: string): void {
    this.tickets.revokeDevice(deviceId);
    for (const client of this.clients) {
      if (client.authenticated?.deviceId === deviceId) this.closeClient(client, 4401, "device revoked");
    }
  }

  getArtifact(actor: AuthContext, artifactId: string): ArtifactDownload | null {
    return this.artifacts.getForActor(actor, artifactId);
  }

  getSessionAttachment(actor: AuthContext, sessionId: string, artifactId: string): ArtifactDownload | null {
    return this.artifacts.getForSession(actor, sessionId, artifactId);
  }

  validateAttachments(actor: AuthContext, sessionId: string, attachments: readonly Attachment[]): void {
    for (const attachment of attachments) {
      if (!this.getSessionAttachment(actor, sessionId, attachment.artifactId)) {
        throw new RealtimeError("NOT_FOUND", "attachment was not found");
      }
    }
  }

  async archiveText(input: {
    sessionId: string;
    runId?: string | null;
    text: string;
    mimeType?: string;
  }): Promise<ArtifactRecord | null> {
    return this.artifacts.archiveText(input);
  }

  async archiveBytes(input: {
    sessionId: string;
    bytes: Uint8Array;
    mimeType?: string;
  }): Promise<ArtifactRecord | null> {
    return this.artifacts.archiveBytes(input);
  }

  close(): void {
    if (this.pollTimer !== undefined) clearInterval(this.pollTimer);
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
    this.pollTimer = undefined;
    this.heartbeatTimer = undefined;
    for (const client of [...this.clients]) this.closeClient(client, 1001, "server closing");
    this.clients.clear();
    this.tickets.clear();
    if (this.server !== null) this.server.off("upgrade", this.handleUpgrade);
    this.server = null;
    this.wss.close();
  }

  private accept(socket: WebSocket): void {
    const client: ClientConnection = {
      socket,
      authenticated: null,
      authTimer: undefined,
      isAlive: true,
      lastPongAt: this.now(),
      subscriptions: new Map(),
      messageChain: Promise.resolve()
    };
    this.clients.add(client);
    client.authTimer = setTimeout(() => {
      if (client.authenticated === null) this.closeClient(client, 4401, "authentication required");
    }, this.authTimeoutMs);
    unrefTimer(client.authTimer);
    socket.on("pong", () => {
      client.isAlive = true;
      client.lastPongAt = this.now();
    });
    socket.on("message", (data) => {
      client.messageChain = client.messageChain
        .then(() => this.handleMessage(client, data))
        .catch(() => this.closeClient(client, 1011, "protocol failure"));
    });
    socket.on("close", () => this.removeClient(client));
  }

  private async handleMessage(client: ClientConnection, data: RawData): Promise<void> {
    if (client.socket.readyState !== WebSocket.OPEN) return;
    const text = rawDataText(data);
    if (Buffer.byteLength(text, "utf8") > 64 * 1024) {
      this.sendError(client, "INVALID_REQUEST", "WebSocket control frame is too large");
      this.closeClient(client, 4400, "invalid request");
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      this.sendError(client, "INVALID_REQUEST", "WebSocket frame is not valid JSON");
      this.closeClient(client, 4400, "invalid request");
      return;
    }
    if (client.authenticated === null) {
      const parsed = wsAuthenticateSchema.safeParse(value);
      if (!parsed.success) {
        this.closeClient(client, 4401, "authentication failed");
        return;
      }
      const principal = this.tickets.consume(parsed.data.ticket);
      if (!principal || !this.auth.isDeviceActive(principal.userId, principal.deviceId)) {
        this.closeClient(client, 4401, "authentication failed");
        return;
      }
      try {
        client.authenticated = this.auth.contextForDevice(principal.userId, principal.deviceId);
      } catch {
        this.closeClient(client, 4401, "authentication failed");
        return;
      }
      if (client.authTimer !== undefined) clearTimeout(client.authTimer);
      client.authTimer = undefined;
      this.send(client, protocolFrame({ type: "authenticated", protocolVersion: 1 }));
      return;
    }

    const parsed = wsControlFrameSchema.safeParse(value);
    if (!parsed.success || parsed.data.type === "authenticate") {
      this.sendError(client, "INVALID_REQUEST", "unsupported WebSocket frame");
      return;
    }
    await this.handleAuthenticatedFrame(client, parsed.data);
  }

  private async handleAuthenticatedFrame(client: ClientConnection, frame: Exclude<WsControlFrame, { type: "authenticate" }>): Promise<void> {
    if (frame.type === "unsubscribe") {
      const parsed = wsUnsubscribeSchema.parse(frame);
      client.subscriptions.delete(parsed.sessionId);
      return;
    }
    const parsed = wsSubscribeSchema.parse(frame);
    if (!client.authenticated) return;
    if (!this.sessionIsOwnedBy(client.authenticated.userId, parsed.sessionId)) {
      this.sendError(client, "NOT_FOUND", "session was not found");
      return;
    }
    const currentHighWater = highWater(this.database, parsed.sessionId);
    if (currentHighWater === null) {
      this.sendError(client, "NOT_FOUND", "session was not found");
      return;
    }
    if (parsed.afterSeq > currentHighWater) {
      this.sendError(client, "INVALID_REQUEST", "afterSeq is above the session high-water mark");
      return;
    }
    if (!client.subscriptions.has(parsed.sessionId) && client.subscriptions.size >= this.maxSubscriptions) {
      this.sendError(client, "SUBSCRIPTION_LIMIT", "subscription limit reached");
      return;
    }
    const subscription: Subscription = {
      sessionId: parsed.sessionId,
      cursor: parsed.afterSeq,
      replayTarget: currentHighWater,
      ready: false,
      pumping: false
    };
    client.subscriptions.set(parsed.sessionId, subscription);
    await this.pump(client, subscription);
  }

  private sessionIsOwnedBy(userId: string, sessionId: string): boolean {
    return sessionOwner(this.database, sessionId) === userId;
  }

  private async pump(client: ClientConnection, subscription: Subscription): Promise<void> {
    if (subscription.pumping || client.socket.readyState !== WebSocket.OPEN) return;
    subscription.pumping = true;
    try {
      while (
        client.socket.readyState === WebSocket.OPEN &&
        client.subscriptions.get(subscription.sessionId) === subscription
      ) {
        const currentHighWater = highWater(this.database, subscription.sessionId);
        if (currentHighWater === null) {
          this.sendError(client, "NOT_FOUND", "session was not found");
          return;
        }
        if (currentHighWater > subscription.replayTarget) subscription.replayTarget = currentHighWater;
        const page = readEvents(this.database, subscription.sessionId, subscription.cursor, 100);
        if (page.events.length > 0) {
          for (const event of page.events) {
            if (event.seq <= subscription.cursor) continue;
            const frame = await this.toEventFrame(event);
            if (!frame) {
              this.resyncAndClose(client, subscription.sessionId, "event_too_large");
              return;
            }
            if (!this.send(client, frame)) return;
            subscription.cursor = event.seq;
          }
          continue;
        }
        const checkedHighWater = highWater(this.database, subscription.sessionId);
        if (checkedHighWater === null) return;
        if (checkedHighWater > subscription.cursor) {
          subscription.replayTarget = checkedHighWater;
          continue;
        }
        if (!subscription.ready) {
          if (!this.send(client, protocolFrame({
            type: "subscription.ready",
            sessionId: subscription.sessionId,
            throughSeq: subscription.cursor
          }))) return;
          subscription.ready = true;
        }
        return;
      }
    } catch {
      this.sendError(client, "STORAGE_UNAVAILABLE", "event replay is temporarily unavailable");
      this.closeClient(client, 1011, "event replay failed");
    } finally {
      subscription.pumping = false;
    }
  }

  private async toEventFrame(event: ProtocolEvent): Promise<WsServerFrame | null> {
    const original = protocolFrame({ type: "event", sessionId: event.sessionId, event });
    if (byteLength(original) <= this.maxFrameBytes) return original;

    const candidate = structuredClone(event) as ProtocolEvent;
    const payload = eventPayload(candidate);
    const runId = candidate.runId;
    try {
      if (candidate.type === "tool.updated" || candidate.type === "tool.finished") {
        const output = payload.output;
        if (output !== null && typeof output === "object" && !Array.isArray(output)) {
          const outputRecord = output as Record<string, unknown>;
          if (typeof outputRecord.text === "string") {
            const artifact = await this.artifacts.archiveText({
              sessionId: candidate.sessionId,
              runId,
              text: outputRecord.text
            });
            outputRecord.truncated = true;
            if (artifact) outputRecord.artifactId = artifact.id;
          }
        }
      } else if (candidate.type === "content.delta") {
        if (typeof payload.delta === "string") payload.truncated = true;
      } else if (candidate.type === "content.ended") {
        await this.archiveBlock(candidate.sessionId, runId, payload.block);
      } else if (candidate.type === "message.completed") {
        if (Array.isArray(payload.blocks)) {
          for (const block of payload.blocks) await this.archiveBlock(candidate.sessionId, runId, block);
        }
      } else if (candidate.type === "tool.started") {
        const artifact = await this.archiveJson(candidate.sessionId, runId, payload.args);
        payload.args = {};
        payload.argsTruncated = true;
        if (artifact) payload.artifactId = artifact.id;
      }
    } catch {
      // The display copy still gets an explicit truncation marker if the
      // optional artifact quota or filesystem is unavailable.
    }

    for (let budget = Math.max(128, Math.floor(this.maxFrameBytes / 2)); budget >= 32; budget = Math.floor(budget / 2)) {
      setPayloadText(payload, budget);
      if (candidate.type === "content.delta") payload.truncated = true;
      if (candidate.type === "content.ended" || candidate.type === "message.completed") markBlockTextTruncated(payload);
      const projected = protocolFrame({ type: "event", sessionId: candidate.sessionId, event: candidate });
      if (byteLength(projected) <= this.maxFrameBytes) return projected;
    }
    return null;
  }

  private async archiveBlock(sessionId: string, runId: string | null, value: unknown): Promise<void> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return;
    const block = value as Record<string, unknown>;
    if (typeof block.text === "string") {
      const artifact = await this.artifacts.archiveText({ sessionId, runId, text: block.text });
      block.text = truncateText(block.text, Math.floor(this.maxFrameBytes / 2));
      block.truncated = true;
      if (artifact) block.artifactId = artifact.id;
    }
    if (typeof block.arguments === "object" && block.arguments !== null && !Array.isArray(block.arguments)) {
      const artifact = await this.archiveJson(sessionId, runId, block.arguments);
      block.arguments = {};
      block.truncated = true;
      if (artifact) block.artifactId = artifact.id;
    }
  }

  private async archiveJson(sessionId: string, runId: string | null, value: unknown): Promise<ArtifactRecord | null> {
    const json = JSON.stringify(value);
    return this.artifacts.archiveText({ sessionId, runId, text: json, mimeType: "application/json" });
  }

  private send(client: ClientConnection, frame: WsServerFrame, allowOverLimit = false): boolean {
    if (client.socket.readyState !== WebSocket.OPEN) return false;
    const encoded = JSON.stringify(frame);
    const length = Buffer.byteLength(encoded, "utf8");
    if (length > this.maxFrameBytes && !allowOverLimit) {
      this.resyncAndClose(client, frame.type === "event" ? frame.sessionId : undefined, "event_too_large");
      return false;
    }
    if (!allowOverLimit && frame.type === "event" && client.socket.bufferedAmount + length > this.maxBufferedBytes) {
      this.resyncAndClose(client, frame.type === "event" ? frame.sessionId : undefined, "slow_consumer");
      return false;
    }
    try {
      client.socket.send(encoded);
      return true;
    } catch {
      this.closeClient(client, 1011, "socket send failed");
      return false;
    }
  }

  private sendError(client: ClientConnection, code: string, message: string): void {
    const frame = protocolFrame({ type: "error", code, message: message.slice(0, 1000) });
    this.send(client, frame);
  }

  private resyncAndClose(client: ClientConnection, sessionId: string | undefined, reason: "slow_consumer" | "event_too_large" | "snapshot_required"): void {
    if (client.socket.readyState === WebSocket.OPEN) {
      const frame = protocolFrame({ type: "resync_required", ...(sessionId ? { sessionId } : {}), reason });
      this.send(client, frame, true);
      this.closeClient(client, 4408, "resync required");
    }
  }

  private closeClient(client: ClientConnection, code: number, reason: string): void {
    if (client.authTimer !== undefined) clearTimeout(client.authTimer);
    client.authTimer = undefined;
    if (client.socket.readyState === WebSocket.OPEN || client.socket.readyState === WebSocket.CONNECTING) {
      try {
        client.socket.close(code, reason.slice(0, 120));
      } catch {
        client.socket.terminate();
      }
    }
    if (client.socket.readyState === WebSocket.CLOSED) this.removeClient(client);
  }

  private removeClient(client: ClientConnection): void {
    if (client.authTimer !== undefined) clearTimeout(client.authTimer);
    client.authTimer = undefined;
    client.subscriptions.clear();
    this.clients.delete(client);
  }

  private poll(): void {
    for (const client of this.clients) {
      if (client.authenticated === null) continue;
      if (!this.auth.isDeviceActive(client.authenticated.userId, client.authenticated.deviceId)) {
        this.closeClient(client, 4401, "device revoked");
        continue;
      }
      for (const subscription of client.subscriptions.values()) void this.pump(client, subscription);
    }
  }

  private heartbeat(): void {
    const now = this.now();
    for (const client of this.clients) {
      if (client.authenticated !== null && !this.auth.isDeviceActive(client.authenticated.userId, client.authenticated.deviceId)) {
        this.closeClient(client, 4401, "device revoked");
        continue;
      }
      if (!client.isAlive && now - client.lastPongAt >= this.pongTimeoutMs) {
        this.closeClient(client, 4408, "heartbeat timeout");
        continue;
      }
      client.isAlive = false;
      try {
        client.socket.ping();
      } catch {
        this.closeClient(client, 1011, "heartbeat failed");
      }
    }
  }
}

function markBlockTextTruncated(payload: Record<string, unknown>): void {
  const block = payload.block;
  if (block !== null && typeof block === "object" && !Array.isArray(block)) (block as Record<string, unknown>).truncated = true;
  if (Array.isArray(payload.blocks)) {
    for (const item of payload.blocks) {
      if (item !== null && typeof item === "object" && !Array.isArray(item)) (item as Record<string, unknown>).truncated = true;
    }
  }
}
