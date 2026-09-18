import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

const outboundSpoolFilePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/;

export interface OutboundHydrationOptions {
  /** Trusted parent-selected directory, never a path supplied by the IPC frame. */
  spoolDir: string;
  sessionId: string;
  workerEpoch: string;
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid spool envelope");
  return value as Record<string, unknown>;
}

/**
 * Extract only a validated basename from an untrusted transport reference.
 * The manager uses it after hydration to remove a file once the corresponding
 * event batch has been committed and ACKed; invalid references are left for
 * the normal protocol error path.
 */
export function outboundSpoolFileName(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const envelope = value as Record<string, unknown>;
  if (envelope.type !== "transport_spool") return null;
  if (envelope.payload === null || typeof envelope.payload !== "object" || Array.isArray(envelope.payload)) return null;
  const fileName = (envelope.payload as Record<string, unknown>).fileName;
  return typeof fileName === "string" && outboundSpoolFilePattern.test(fileName) ? fileName : null;
}

/** Hydrate before normal IPC schema validation; retain files through DB failure/replay. */
export function hydrateSpooledOutbound(value: unknown, options: OutboundHydrationOptions): unknown {
  const envelope = object(value);
  if (envelope.type !== "transport_spool") return value;
  if (envelope.ipcVersion !== 1 || envelope.sessionId !== options.sessionId || envelope.workerEpoch !== options.workerEpoch) {
    throw new Error("spool envelope ownership mismatch");
  }
  const payload = object(envelope.payload);
  if (typeof payload.fileName !== "string" || !outboundSpoolFilePattern.test(payload.fileName) ||
      !Number.isSafeInteger(payload.byteLength) || (payload.byteLength as number) < 1 ||
      typeof payload.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(payload.sha256)) throw new Error("invalid spool reference");
  const root = realpathSync(options.spoolDir);
  const filePath = join(root, payload.fileName);
  if (dirname(realpathSync(filePath)) !== root) throw new Error("spool path escaped worker directory");
  const fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bytes: Buffer;
  try {
    const metadata = fstatSync(fd);
    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size !== payload.byteLength) throw new Error("spool file metadata mismatch");
    bytes = readFileSync(fd);
  } finally { closeSync(fd); }
  if (bytes.length !== payload.byteLength || createHash("sha256").update(bytes).digest("hex") !== payload.sha256) {
    throw new Error("spool file integrity mismatch");
  }
  const hydrated = object(JSON.parse(bytes.toString("utf8")) as unknown);
  if (hydrated.ipcVersion !== 1 || hydrated.sessionId !== options.sessionId || hydrated.workerEpoch !== options.workerEpoch ||
      hydrated.type === "transport_spool") throw new Error("hydrated spool envelope ownership mismatch");
  return hydrated;
}
