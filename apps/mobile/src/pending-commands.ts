import { commandRequestDtoSchema, type CommandRequest } from "@pi-remote/protocol";
import { makeIdempotencyKey, type PiRemoteApi } from "./api/client";
import type { MobileCache } from "./storage/local-cache";

export interface PendingCommand {
  key: string;
  sessionId: string;
  command: CommandRequest;
  createdAt: number;
  phase: "prepared" | "unknown";
  editorText: string;
}

/** Persist identity and the validated payload before any network activity. */
export class PendingCommands {
  constructor(
    private cache: MobileCache,
    private accountKey: string,
    private api: PiRemoteApi,
    private syncEditor?: (text: string) => Promise<void>
  ) {}

  async list(sessionId: string): Promise<PendingCommand[]> {
    return (await this.cache.listResources<PendingCommand>(this.accountKey, "pending-command:"))
      .filter((entry) => entry.sessionId === sessionId);
  }

  async prepare(sessionId: string, command: CommandRequest, editorText = ""): Promise<PendingCommand> {
    const entry: PendingCommand = { key: makeIdempotencyKey(), sessionId, command: commandRequestDtoSchema.parse(command), createdAt: Date.now(), phase: "prepared", editorText };
    await this.cache.saveResource(this.accountKey, `pending-command:${entry.key}`, entry);
    return entry;
  }

  async reconcile(entry: PendingCommand) {
    // Read the durable original, never a caller's edited payload. A server
    // receipt resolves transport uncertainty, not the command's execution result.
    const stored = await this.cache.getResource<PendingCommand>(this.accountKey, `pending-command:${entry.key}`);
    if (!stored) throw new Error("待确认提交不存在；未发送请求");
    const original = stored.value;
    if (original.phase === "prepared") {
      // Control/answer paths must remain usable while initialization or a previous edit is waiting.
      if (["prompt", "bash", "extension_command"].includes(original.command.kind)) await this.syncEditor?.(original.editorText);
      original.phase = "unknown";
      // Reconciliation must not depend on waking a worker or changing its editor.
      await this.cache.saveResource(this.accountKey, `pending-command:${original.key}`, original);
    }
    const receipt = await this.api.submitCommandWithRetry(original.sessionId, original.command, original.key);
    await this.cache.deleteResource(this.accountKey, `pending-command:${entry.key}`);
    return receipt;
  }
}
