import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface OutboundSpoolOptions {
  /** Parent-provisioned, private directory for this worker epoch. */
  spoolDir: string;
  maxFrameBytes?: number;
}

/** Serialize without discarding SDK output. The returned string excludes its newline. */
export function encodeSpooledOutbound(
  message: { ipcVersion: number; sessionId: string; workerEpoch: string; type: string; payload: unknown },
  options: OutboundSpoolOptions
): string {
  const encoded = JSON.stringify(message);
  const bytes = Buffer.from(encoded, "utf8");
  const maximum = options.maxFrameBytes ?? 1024 * 1024;
  if (!Number.isSafeInteger(maximum) || maximum < 1024) throw new Error("invalid outbound frame limit");
  if (bytes.length <= maximum) return encoded;
  if (message.type === "auth_display") throw new Error("Authentication display exceeds the in-memory IPC frame limit");
  if (!options.spoolDir) throw new Error("oversized IPC output requires a parent-provisioned spool directory");
  const root = resolve(options.spoolDir);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const fileName = `${randomUUID()}.json`;
  const finalPath = join(root, fileName);
  const temporaryPath = `${finalPath}.tmp`;
  const reference = JSON.stringify({
    ipcVersion: message.ipcVersion, sessionId: message.sessionId, workerEpoch: message.workerEpoch,
    type: "transport_spool",
    payload: { fileName, byteLength: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }
  });
  if (Buffer.byteLength(reference) > maximum) throw new Error("spool reference exceeds IPC frame limit");
  try {
    const fd = openSync(temporaryPath, "wx", 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporaryPath, finalPath);
    const directory = openSync(root, "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
  return reference;
}
