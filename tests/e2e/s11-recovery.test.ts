import { describe, expect, it } from "vitest";
import { CommandRepository, loadReducerState } from "../../apps/server/src/storage/index.js";
import { RecoveryManager } from "../../apps/server/src/runtime/index.js";
import {
  S11_DEVICE_ID,
  S11_OWNER_ID,
  S11_SESSION_ID,
  appendS11Events,
  createS11Fixture
} from "./harness.js";

describe("S11 synthetic durable recovery projection contract", () => {
  it("projects seeded interrupted state and leaves explicit new work usable", async () => {
    const fixture = await createS11Fixture();
    try {
      const commands = new CommandRepository(fixture.database);
      commands.create({
        id: "s11-command-active",
        userId: S11_OWNER_ID,
        deviceId: S11_DEVICE_ID,
        sessionId: S11_SESSION_ID,
        scope: "POST:/v1/sessions/s11-session/commands",
        clientCommandId: "s11-client-active",
        kind: "prompt",
        payload: { kind: "prompt", payload: { text: "继续执行" } },
        state: "accepted"
      });
      commands.create({
        id: "s11-command-tail",
        userId: S11_OWNER_ID,
        deviceId: S11_DEVICE_ID,
        sessionId: S11_SESSION_ID,
        scope: "POST:/v1/sessions/s11-session/commands",
        clientCommandId: "s11-client-tail",
        kind: "follow_up",
        payload: { kind: "follow_up", payload: { text: "旧队列项" } },
        state: "queued"
      });

      appendS11Events(fixture, [
        {
          type: "command.updated",
          payload: {
            commandId: "s11-command-active",
            kind: "prompt",
            state: "accepted",
            targetRunId: "s11-run-active",
            runs: [{ runId: "s11-run-active", sessionId: S11_SESSION_ID }]
          }
        },
        {
          type: "operation.updated",
          runId: "s11-run-active",
          operationId: "s11-operation-active",
          payload: {
            operationId: "s11-operation-active",
            kind: "run",
            status: "running",
            runId: "s11-run-active",
            commandId: "s11-command-active"
          }
        },
        {
          type: "run.updated",
          runId: "s11-run-active",
          operationId: "s11-operation-active",
          payload: {
            kind: "prompt",
            status: "running",
            phase: "tool",
            source: "command",
            commandId: "s11-command-active"
          }
        },
        {
          type: "message.started",
          runId: "s11-run-active",
          operationId: "s11-operation-active",
          payload: { messageId: "s11-message-active", role: "assistant" }
        },
        {
          type: "content.started",
          runId: "s11-run-active",
          operationId: "s11-operation-active",
          payload: { messageId: "s11-message-active", blockId: "s11-block-active", kind: "text", index: 0 }
        },
        {
          type: "content.delta",
          runId: "s11-run-active",
          operationId: "s11-operation-active",
          payload: { messageId: "s11-message-active", blockId: "s11-block-active", delta: "已开始执行" }
        },
        {
          type: "tool.started",
          runId: "s11-run-active",
          operationId: "s11-operation-active",
          payload: { toolCallId: "s11-tool-active", messageId: "s11-message-active", toolName: "bash", args: { command: "long-task" } }
        },
        {
          type: "input.updated",
          runId: "s11-run-active",
          operationId: "s11-operation-active",
          payload: {
            inputId: "s11-input-uncertain",
            delivery: "steer",
            state: "queued",
            commandId: "s11-command-active",
            content: {
              text: "网络恢复后继续",
              attachments: [{ artifactId: "s11-artifact-input", mimeType: "text/plain" }]
            }
          }
        },
        {
          type: "interaction.requested",
          runId: "s11-run-active",
          operationId: "s11-operation-active",
          payload: {
            interactionId: "s11-interaction-pending",
            operationId: "s11-operation-active",
            origin: "run",
            kind: "confirm",
            title: "确认继续执行？"
          }
        },
        {
          type: "command.updated",
          payload: {
            commandId: "s11-command-tail",
            kind: "follow_up",
            state: "queued",
            runs: []
          }
        },
        {
          type: "queue.updated",
          payload: {
            state: "ready",
            version: 1,
            pause: null,
            items: [{ commandId: "s11-command-tail", runId: "s11-tail-run", kind: "follow_up", position: 0 }]
          }
        }
      ]);

      const report = new RecoveryManager(fixture.database, { now: () => Date.parse("2026-09-13T00:00:01.000Z") })
        .recoverSession(S11_SESSION_ID, "s11-recovery-epoch");
      const recovered = loadReducerState(fixture.database, S11_SESSION_ID);

      expect(report.unknownCommandIds).toContain("s11-command-active");
      expect(report.pausedQueue).toBe(true);
      expect(recovered.runs["s11-run-active"]).toMatchObject({ status: "interrupted", contentSealed: true });
      expect(recovered.operations["s11-operation-active"]).toMatchObject({ status: "interrupted" });
      expect(recovered.commands["s11-command-active"]).toMatchObject({ state: "unknown" });
      expect(recovered.commands["s11-command-tail"]).toMatchObject({ state: "queued" });
      expect(recovered.queue).toMatchObject({
        state: "paused",
        pause: { runId: "s11-run-active", reason: "interrupted" },
        items: [{ commandId: "s11-command-tail", runId: "s11-tail-run" }]
      });
      expect(recovered.inputs["s11-input-uncertain"]).toMatchObject({
        state: "unknown",
        content: { text: "网络恢复后继续", attachments: [{ artifactId: "s11-artifact-input" }] }
      });
      expect(recovered.interactions["s11-interaction-pending"]).toMatchObject({
        status: "cancelled",
        reason: "operation_ended"
      });
      const partialMessage = recovered.timelineItems.find((item) => item.itemId === "s11-message-active");
      const partialTool = recovered.timelineItems.find((item) => item.itemId === "s11-tool-active");
      expect(partialMessage).toMatchObject({ completeness: "partial", endReason: "interrupted" });
      expect(partialTool).toMatchObject({ completeness: "partial", endReason: "interrupted", data: { outcome: "unknown" } });
      expect(recovered.liveItems).toEqual({});

      // A new, explicit operation is allowed while the old tail remains
      // paused. It is not a replay of the unknown prompt.
      commands.create({
        id: "s11-command-new",
        userId: S11_OWNER_ID,
        deviceId: S11_DEVICE_ID,
        sessionId: S11_SESSION_ID,
        scope: "POST:/v1/sessions/s11-session/commands",
        clientCommandId: "s11-client-new",
        kind: "bash",
        payload: { kind: "bash", payload: { command: "printf new" } },
        state: "queued"
      });
      appendS11Events(fixture, [
        { type: "command.updated", payload: { commandId: "s11-command-new", kind: "bash", state: "queued", runs: [] } },
        {
          type: "operation.updated",
          operationId: "s11-operation-new",
          payload: { operationId: "s11-operation-new", kind: "bash", status: "running", commandId: "s11-command-new" }
        },
        {
          type: "operation.updated",
          operationId: "s11-operation-new",
          payload: { operationId: "s11-operation-new", kind: "bash", status: "completed", commandId: "s11-command-new" }
        },
        { type: "command.updated", payload: { commandId: "s11-command-new", kind: "bash", state: "completed", runs: [] } }
      ], "s11-new-operation-epoch");
      const afterNewOperation = loadReducerState(fixture.database, S11_SESSION_ID);
      expect(afterNewOperation.operations["s11-operation-new"]?.status).toBe("completed");
      expect(afterNewOperation.commands["s11-command-new"]?.state).toBe("completed");
      expect(afterNewOperation.queue.state).toBe("paused");
    } finally {
      await fixture.close();
    }
  });
});
