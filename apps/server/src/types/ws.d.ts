declare module "ws" {
  import type { IncomingMessage } from "node:http";
  import type { Duplex } from "node:stream";

  export type RawData = Buffer | ArrayBuffer | Buffer[];

  export class WebSocket {
    static readonly OPEN: number;
    static readonly CONNECTING: number;
    static readonly CLOSED: number;
    readonly OPEN: number;
    readonly CONNECTING: number;
    readonly CLOSED: number;
    readonly readyState: number;
    readonly bufferedAmount: number;
    readonly protocol: string;
    on(event: "message", listener: (data: RawData, isBinary: boolean) => void): this;
    on(event: "pong", listener: () => void): this;
    on(event: "close", listener: (code: number, reason: Buffer) => void): this;
    on(event: "error", listener: (error: Error) => void): this;
    send(data: string): void;
    close(code?: number, reason?: string): void;
    terminate(): void;
    ping(): void;
  }

  export interface WebSocketServerOptions {
    noServer?: boolean;
    maxPayload?: number;
    perMessageDeflate?: boolean;
    handleProtocols?: (protocols: Set<string>, request: IncomingMessage) => string;
  }

  export class WebSocketServer {
    constructor(options?: WebSocketServerOptions);
    on(event: "connection", listener: (socket: WebSocket, request: IncomingMessage) => void): this;
    handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, callback: (socket: WebSocket) => void): void;
    close(callback?: (error?: Error) => void): void;
  }
}
