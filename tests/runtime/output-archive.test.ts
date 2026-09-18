import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseProtocolEvent, type ProtocolEvent } from "../../packages/protocol/src/index.js";
import { encodeSpooledOutbound } from "../../packages/agent-pi/src/outbound-spool.js";
import { EventBacklog } from "../../packages/agent-pi/src/event-backlog.js";
import { hydrateSpooledOutbound } from "../../apps/server/src/runtime/outbound-hydration.js";
import { archiveEventOutputs } from "../../apps/server/src/runtime/output-archive.js";
import { ArtifactStore } from "../../apps/server/src/realtime/artifacts.js";
import { OwnerRepository, ProjectRepository, SessionRepository, openServerDatabase } from "../../apps/server/src/storage/index.js";
import type { AuthContext } from "../../apps/server/src/auth.js";
const roots: string[] = [];
function root() { const path = mkdtempSync(join(tmpdir(), "r14-output-")); roots.push(path); return path; }
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
const identity = { sessionId: "session", workerEpoch: "epoch" };
function event(text: string): ProtocolEvent {
  return parseProtocolEvent({ schemaVersion: 1, sessionId: "session", seq: 1, runId: null, operationId: "op", timestamp: "2026-09-15T00:00:00.000Z", type: "tool.finished", payload: { toolCallId: "tool", output: { text, truncated: false }, isError: false } });
}
function envelope(text: string) { return { ipcVersion: 1, ...identity, type: "event_batch", payload: { batchNo: 1, events: [event(text)] } }; }

describe("R14 durable outbound output", () => {
  it("preserves >1MiB Unicode/escaped payload through a bounded reference and repeat hydration", () => {
    const spoolDir = root(); const message = envelope('漢😀\\\n"'.repeat(180000));
    const encoded = encodeSpooledOutbound(message, { spoolDir });
    expect(Buffer.byteLength(encoded)).toBeLessThan(1024);
    const reference = JSON.parse(encoded);
    expect(hydrateSpooledOutbound(reference, { spoolDir, ...identity })).toEqual(message);
    expect(hydrateSpooledOutbound(reference, { spoolDir, ...identity })).toEqual(message);
    expect(readdirSync(spoolDir)).toHaveLength(1);
  });
  it("passes normal frames unchanged and rejects missing spool configuration for huge frames", () => {
    expect(encodeSpooledOutbound(envelope("small"), { spoolDir: "" })).toBe(JSON.stringify(envelope("small")));
    expect(() => encodeSpooledOutbound(envelope("x".repeat(1100000)), { spoolDir: "" })).toThrow(/spool directory/);
  });
  it("rejects traversal, wrong epoch, corruption and symlink references", () => {
    const spoolDir = root(); const reference = JSON.parse(encodeSpooledOutbound(envelope("x".repeat(1100000)), { spoolDir }));
    const hydrate = (value: unknown) => hydrateSpooledOutbound(value, { spoolDir, ...identity });
    expect(() => hydrate({ ...reference, workerEpoch: "other" })).toThrow(/ownership/);
    expect(() => hydrate({ ...reference, payload: { ...reference.payload, fileName: "../outside.json" } })).toThrow(/reference/);
    const path = join(spoolDir, reference.payload.fileName);
    const original = readFileSync(path);
    writeFileSync(path, Buffer.alloc(original.length, 120));
    expect(() => hydrate(reference)).toThrow(/integrity/);
    rmSync(path); const outside = join(root(), "data.json"); writeFileSync(outside, original); symlinkSync(outside, path);
    expect(() => hydrate(reference)).toThrow(/escaped/);
  });
  it("archives full text before replacing the DB display copy and supports authorized retrieval", async () => {
    const directory = root(); const db = await openServerDatabase({ filename: join(directory, "db.sqlite") });
    try {
      new OwnerRepository(db).ensure({ id: "owner", displayName: "Owner" });
      new ProjectRepository(db).create({ id: "project", userId: "owner", name: "Project", rootPath: directory, workspaceKey: "key", rootIdentity: "identity" });
      new SessionRepository(db).create({ id: "session", projectId: "project", title: "Test" });
      const artifacts = new ArtifactStore(db, { rootDir: join(directory, "outputs") });
      const text = "😀漢".repeat(170000); const original = { ...event(text), runId: "not-persisted-yet" };
      const [archived] = await archiveEventOutputs([original], artifacts);
      if (archived?.type !== "tool.finished") throw new Error("wrong event");
      expect(archived.payload.output?.truncated).toBe(true);
      expect(Buffer.byteLength(archived.payload.output!.text)).toBeLessThanOrEqual(32768);
      expect(archived.payload.output!.text).not.toContain("�");
      const artifact = artifacts.getForActor({ userId: "owner" } as AuthContext, archived.payload.output!.artifactId!);
      expect(readFileSync(artifact!.filePath, "utf8")).toBe(text);
      const blocks = [
        { id: "thinking", index: 0, kind: "thinking", text },
        { id: "args", index: 1, kind: "tool_call", toolCallId: "tool", toolName: "bash", arguments: { value: text } }
      ];
      const completed = parseProtocolEvent({ ...original, type: "message.completed", payload: { messageId: "message", role: "assistant", blocks } });
      const [projected] = await archiveEventOutputs([completed], artifacts);
      if (projected?.type !== "message.completed") throw new Error("wrong completion");
      for (const block of projected.payload.blocks) {
        expect(block.truncated).toBe(true);
        const stored = artifacts.getForActor({ userId: "owner" } as AuthContext, block.artifactId!);
        expect(readFileSync(stored!.filePath, "utf8")).toBe(block.kind === "tool_call" ? JSON.stringify({ value: text }) : text);
      }
      const started = parseProtocolEvent({ ...original, type: "tool.started", payload: { toolCallId: "tool", toolName: "bash", args: { value: text } } });
      const [tool] = await archiveEventOutputs([started], artifacts);
      expect(tool?.payload).toMatchObject({ args: {}, argsTruncated: true });
      expect(artifacts.getForActor({ userId: "other" } as AuthContext, artifact!.record.id)).toBeNull();
      expect(original).toEqual({ ...event(text), runId: "not-persisted-yet" });
      const [replay] = await archiveEventOutputs([original], artifacts);
      expect(replay).toEqual(archived);
      writeFileSync(artifact!.filePath, Buffer.alloc(Buffer.byteLength(text), 120));
      expect(await archiveEventOutputs([original], artifacts)).toEqual([archived]);
      expect(readFileSync(artifact!.filePath, "utf8")).toBe(text);
      rmSync(artifact!.filePath);
      expect(await archiveEventOutputs([original], artifacts)).toEqual([archived]);
      expect(readFileSync(artifact!.filePath, "utf8")).toBe(text);
    } finally { db.close(); }
  });
  it("preserves the only full copy when quota refuses and propagates storage failure", async () => {
    const original = event("x".repeat(40000));
    expect(await archiveEventOutputs([original], { archiveText: async () => null })).toEqual([original]);
    await expect(archiveEventOutputs([original], { archiveText: async () => { throw new Error("disk full"); } })).rejects.toThrow("disk full");
  });
});

describe("R15 disk-backed event backlog", () => {
  it("retains leased records before ACK, removes them after ACK, and recovers an unacknowledged lease", () => {
    const spoolDir = root();
    const queue = new EventBacklog({ spoolDir, memoryLimit: 0 });
    const first = event("leased-before-ack");
    queue.enqueue(first);
    const batch = queue.takeBatch(1);
    expect(batch.leaseId).toEqual(expect.any(String));
    expect(batch.events).toEqual([first]);
    expect(queue.length).toBe(0);
    expect(readdirSync(spoolDir).filter((name) => name.endsWith(".event.json"))).toHaveLength(1);

    queue.ack(batch.leaseId!);
    expect(readdirSync(spoolDir).filter((name) => name.endsWith(".event.json"))).toHaveLength(0);

    const second = event("recover-after-crash");
    queue.enqueue(second);
    const pending = queue.takeBatch(1);
    expect(pending.leaseId).not.toBeNull();
    queue.dispose();
    const recovered = new EventBacklog({ spoolDir, memoryLimit: 0 });
    expect(recovered.take(1)).toEqual([second]);
    recovered.dispose();
  });

  it("queues beyond 256 batches, drains FIFO, and recovers pending records after disposal", () => {
    const spoolDir = root(); const queue = new EventBacklog({ spoolDir, memoryLimit: 2 });
    for (let i = 0; i < 300; i++) queue.enqueue(event(String(i)));
    expect(queue.length).toBe(300);
    expect(queue.take(11)).toEqual(Array.from({ length: 11 }, (_, i) => event(String(i))));
    queue.dispose();
    const recovered = new EventBacklog({ spoolDir, memoryLimit: 0 });
    expect(recovered.length).toBe(289);
    expect(recovered.take(500)).toEqual(Array.from({ length: 289 }, (_, i) => event(String(i + 11))));
    expect(recovered.length).toBe(0); expect(recovered.take(5)).toEqual([]);
    recovered.dispose();
  });
  it("spills a single huge event intact and rejects invalid limits", () => {
    const queue = new EventBacklog({ spoolDir: root(), memoryLimit: 0 });
    const huge = event("x".repeat(1200000)); queue.enqueue(huge);
    expect(queue.take(1)).toEqual([huge]); queue.dispose();
    expect(() => queue.enqueue(huge)).toThrow(/disposed/);
    expect(() => new EventBacklog({ spoolDir: root(), memoryLimit: -1 })).toThrow(/limit/);
  });
});
