import { parseProtocolEvent, type ProtocolEvent } from "@pi-remote/protocol";
import type { ArtifactStore } from "../realtime/artifacts.js";

export const OUTPUT_PREVIEW_BYTES = 32768;

/** Keep Unicode intact while bounding the display copy in UTF-8 bytes. */
function preview(text: string): string {
  const bytes = Buffer.from(text, "utf8");
  let end = OUTPUT_PREVIEW_BYTES;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

/** Must finish BEFORE appendBatch: HTTP history and WS replay share these durable refs. */
export async function archiveEventOutputs(events: readonly ProtocolEvent[], artifacts: Pick<ArtifactStore, "archiveText">): Promise<ProtocolEvent[]> {
  const result: ProtocolEvent[] = [];
  for (const original of events) {
    const event = structuredClone(original);
    const payload = event.payload as unknown as Record<string, unknown>;
    const archiveField = async (record: Record<string, unknown>, field: string, json = false, flag = "truncated") => {
      const value = record[field];
      const text = json ? JSON.stringify(value) : typeof value === "string" ? value : undefined;
      if (text === undefined || Buffer.byteLength(text, "utf8") <= OUTPUT_PREVIEW_BYTES) return;
      // A run.started in this same batch has not committed yet. Archive by Session;
      // the durable event retains Run ownership without a premature artifacts FK.
      const artifact = await artifacts.archiveText({ sessionId: event.sessionId, text,
        ...(json ? { mimeType: "application/json" } : {}) });
      // Quota refusal must not erase the only full copy. Keep the complete DB payload.
      if (!artifact) return;
      record[field] = json ? {} : preview(text);
      record[flag] = true;
      record.artifactId = artifact.id;
    };
    const archiveBlock = async (value: unknown) => {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return;
      const block = value as Record<string, unknown>;
      await archiveField(block, "text");
      if (block.kind === "tool_call") await archiveField(block, "arguments", true);
    };
    if (event.type === "tool.updated" || event.type === "tool.finished") {
      if (payload.output) await archiveField(payload.output as Record<string, unknown>, "text");
    } else if (event.type === "content.ended") {
      await archiveBlock(payload.block);
    } else if (event.type === "message.completed") {
      if (Array.isArray(payload.blocks)) for (const block of payload.blocks) await archiveBlock(block);
    } else if (event.type === "tool.started") {
      await archiveField(payload, "args", true, "argsTruncated");
    }
    // Delta schemas lack artifact refs. Preserve full deltas until a final block can archive them.
    result.push(parseProtocolEvent(event));
  }
  return result;
}
