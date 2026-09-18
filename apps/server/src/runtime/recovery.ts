import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  commandKindSchema,
  parseProtocolEvent,
  type CommandKind,
  type ProtocolEvent,
  type ReducerState,
  type RunProjection
} from "@pi-remote/protocol";
import {
  EventStore,
  loadReducerState,
  type AppendEventBatchResult
} from "../storage/index.js";

type Row = Record<string, unknown>;

export interface RecoveryOptions {
  eventStore?: EventStore;
  now?: () => number;
  /** Optional actor used when a recovery event must materialize a command row. */
  commandActor?: { userId: string; deviceId: string };
}

export interface RecoveryReport {
  sessionId: string;
  interruptedRunIds: string[];
  interruptedOperationIds: string[];
  unknownCommandIds: string[];
  staleCommandIds: string[];
  pausedQueue: boolean;
  appendedEvents: number;
}

function text(row: Row, key: string): string | null {
  const value = row[key];
  return value === null || value === undefined ? null : typeof value === "string" ? value : null;
}

function timestamp(now: number): string {
  return new Date(now).toISOString();
}

function activeRun(run: RunProjection): boolean {
  // A queued Run has not crossed the IPC boundary. It is handled below as
  // stale_runtime, while running/stopping Runs have an uncertain outcome.
  return run.status === "running" || run.status === "stopping";
}

function operationActive(state: ReducerState, operationId: string): boolean {
  const operation = state.operations[operationId];
  return operation?.status === "running" || operation?.status === "waiting_input";
}

function commandKind(value: string): CommandKind | null {
  return commandKindSchema.safeParse(value).success ? value as CommandKind : null;
}

function commandError(code: string, message: string): { code: string; message: string } {
  return { code, message };
}

function commandRefs(state: ReducerState, commandId: string, extraRunId?: string): Array<{ runId: string; sessionId: string }> {
  const existing = state.commands[commandId]?.runs ?? [];
  if (!extraRunId || existing.some((ref) => ref.runId === extraRunId && ref.sessionId === state.sessionId)) return structuredClone(existing);
  return [...structuredClone(existing), { runId: extraRunId, sessionId: state.sessionId }];
}

function operationForCommand(state: ReducerState, commandId: string): string | null {
  return Object.values(state.operations).find((operation) => operation.commandId === commandId)?.operationId ?? null;
}

function eventBase(
  state: ReducerState,
  seq: number,
  runId: string | null,
  operationId: string | null,
  type: ProtocolEvent["type"],
  payload: unknown,
  now: number
): unknown {
  return { schemaVersion: 1, sessionId: state.sessionId, seq, runId, operationId, type, timestamp: timestamp(now), payload };
}

function isControlKind(kind: CommandKind): boolean {
  return kind === "steer" || kind === "abort" || kind === "respond" || kind === "abort_bash";
}

function isQueueCommand(kind: CommandKind): boolean {
  return kind === "prompt" || kind === "follow_up" || kind === "compact";
}

function commandRow(database: DatabaseSync, commandId: string): Row | undefined {
  return database.prepare("SELECT id, kind, state, target_run_id, worker_epoch, dispatched_at FROM commands WHERE id = ?").get(commandId) as Row | undefined;
}

function appendInChunks(
  eventStore: EventStore,
  sessionId: string,
  workerEpoch: string,
  events: ProtocolEvent[]
): AppendEventBatchResult[] {
  const results: AppendEventBatchResult[] = [];
  let batchNo = 1;
  for (let index = 0; index < events.length; index += 500) {
    results.push(eventStore.appendBatch({
      sessionId,
      workerEpoch,
      batchNo,
      events: events.slice(index, index + 500)
    }));
    batchNo += 1;
  }
  return results;
}

/**
 * Convert only durable, previously dispatched work into honest recovery
 * states. No old prompt or control is sent to a replacement worker.
 */
export class RecoveryManager {
  private readonly eventStore: EventStore;
  private readonly now: () => number;

  constructor(private readonly database: DatabaseSync, options: RecoveryOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.eventStore = options.eventStore ?? new EventStore(database, {
      now: this.now,
      commandActor: options.commandActor
    });
  }

  recoverAll(workerEpoch = `recovery-${randomUUID()}`): RecoveryReport[] {
    const rows = this.database.prepare("SELECT id FROM sessions ORDER BY id").all() as Row[];
    return rows
      .map((row) => text(row, "id"))
      .filter((sessionId): sessionId is string => sessionId !== null)
      .map((sessionId) => this.recoverSession(sessionId, `${workerEpoch}:${sessionId}`));
  }

  recoverSession(sessionId: string, workerEpoch = `recovery-${randomUUID()}`): RecoveryReport {
    const state = loadReducerState(this.database, sessionId);
    const now = this.now();
    const events: ProtocolEvent[] = [];
    const interruptedRunIds: string[] = [];
    const interruptedOperationIds: string[] = [];
    const unknownCommandIds: string[] = [];
    const staleCommandIds: string[] = [];
    const terminalCommandIds = new Set<string>();
    const terminalRunIds = new Set<string>();
    let nextSeq = state.lastSeq + 1;
    let pausedQueue = false;

    const queuedTargetRunIds = new Set<string>();
    for (const command of Object.values(state.commands)) {
      if (command.targetRunId && state.runs[command.targetRunId]?.status === "queued") {
        queuedTargetRunIds.add(command.targetRunId);
      }
    }
    const queuedTargetRows = this.database.prepare(`
      SELECT target_run_id FROM commands
      WHERE state IN ('queued','dispatching','accepted') AND session_id = ? AND target_run_id IS NOT NULL
    `).all(sessionId) as Row[];
    for (const row of queuedTargetRows) {
      const targetRunId = text(row, "target_run_id");
      if (targetRunId && state.runs[targetRunId]?.status === "queued") queuedTargetRunIds.add(targetRunId);
    }

    const add = (runId: string | null, operationId: string | null, type: ProtocolEvent["type"], payload: unknown): void => {
      const parsed = parseProtocolEvent(eventBase(state, nextSeq, runId, operationId, type, payload, now));
      events.push(parsed);
      nextSeq += 1;
    };

    const affectedOperationIds = new Set<string>();
    for (const run of Object.values(state.runs)) {
      if (!activeRun(run)) continue;
      affectedOperationIds.add(run.operationId);
      interruptedRunIds.push(run.runId);
      if (!run.contentSealed) {
        add(run.runId, run.operationId, "run.content_sealed", { reason: "interrupted" });
      }
      add(run.runId, run.operationId, "run.updated", {
        kind: run.kind,
        status: "interrupted",
        phase: null,
        source: run.source,
        ...(run.commandId ? { commandId: run.commandId } : {}),
        error: commandError("WORKER_EXITED", "worker exited before the Run settled")
      });
      terminalRunIds.add(run.runId);
      interruptedOperationIds.push(run.operationId);
    }

    for (const operation of Object.values(state.operations)) {
      if (!operationActive(state, operation.operationId)) continue;
      if (operation.runId && queuedTargetRunIds.has(operation.runId)) continue;
      if (!affectedOperationIds.has(operation.operationId)) {
        affectedOperationIds.add(operation.operationId);
        interruptedOperationIds.push(operation.operationId);
      }
      if (Object.values(state.liveItems).some((item) => item.operationId === operation.operationId && item.runId === null)) {
        add(null, operation.operationId, "operation.content_sealed", { reason: "interrupted" });
      }
    }

    // Inputs that were queued inside a call whose delivery result is now
    // unknowable remain visible as drafts; they are never silently consumed.
    for (const input of Object.values(state.inputs)) {
      if (input.state !== "queued" || !affectedOperationIds.has(input.operationId)) continue;
      add(input.runId, input.operationId, "input.updated", {
        inputId: input.inputId,
        delivery: input.delivery,
        state: "unknown",
        ...(input.commandId ? { commandId: input.commandId } : {})
      });
    }

    // Close the operation only after its live content and uncertain inputs
    // have been represented. Reducer terminal states reject late content.
    for (const operationId of interruptedOperationIds) {
      const operation = state.operations[operationId];
      if (!operation) continue;
      add(operation.runId, operation.operationId, "operation.updated", {
        operationId: operation.operationId,
        kind: operation.kind,
        status: "interrupted",
        ...(operation.commandId ? { commandId: operation.commandId } : {}),
        ...(operation.runId ? { runId: operation.runId } : {}),
        error: commandError("WORKER_EXITED", "worker exited before the operation settled")
      });
    }

    // Targeted commands are classified before their kind. A queued target
    // never reached IPC and is stale_runtime; a running target had an
    // uncertain invocation and is unknown.
    const candidateCommandIds = new Set<string>(Object.keys(state.commands));
    const commandRows = this.database.prepare(`
      SELECT id FROM commands
      WHERE state IN ('queued','dispatching','accepted')
        AND (session_id = ? OR id IN (SELECT command_id FROM runs WHERE session_id = ? AND command_id IS NOT NULL))
    `).all(sessionId, sessionId) as Row[];
    for (const row of commandRows) {
      const id = text(row, "id");
      if (id) candidateCommandIds.add(id);
    }

    const queueItems = state.queue.items.filter((item) => {
      const command = state.commands[item.commandId];
      return !command || !terminalCommandIds.has(item.commandId);
    });
    let queueChanged = queueItems.length !== state.queue.items.length;

    for (const commandId of candidateCommandIds) {
      const projection = state.commands[commandId];
      const row = commandRow(this.database, commandId);
      const rawKind = projection?.kind ?? text(row ?? {}, "kind");
      const kind = rawKind ? commandKind(rawKind) : null;
      if (!kind) continue;
      const currentState = projection?.state ?? text(row ?? {}, "state");
      if (currentState !== "queued" && currentState !== "dispatching" && currentState !== "accepted") continue;
      const targetRunId = projection?.targetRunId ?? text(row ?? {}, "target_run_id");
      const targetRun = targetRunId ? state.runs[targetRunId] ?? null : null;
      const refs = commandRefs(state, commandId, targetRunId ?? undefined);
      let nextState: "cancelled" | "unknown" | null = null;
      let error: { code: string; message: string } | null = null;

      const crossedIpc = row?.dispatched_at !== null && row?.dispatched_at !== undefined;
      const ownsQueuedRun = targetRun?.status === "queued" && targetRun.commandId === commandId &&
        isQueueCommand(kind) && currentState === "queued" && !crossedIpc;
      // targetRunId historically also names the Run allocated for a new
      // command. That ownership is different from a control's old target.
      if (ownsQueuedRun) continue;

      if (targetRunId !== null) {
        if (targetRun && targetRun.status === "queued") {
          nextState = crossedIpc ? "unknown" : "cancelled";
          error = crossedIpc
            ? commandError("UNKNOWN_RUNTIME", "the command crossed IPC but its Run was still queued when the worker exited")
            : commandError("STALE_RUNTIME", "the targeted Run was queued but never dispatched");
          if (!terminalRunIds.has(targetRun.runId)) {
            add(targetRun.runId, targetRun.operationId, "run.updated", {
              kind: targetRun.kind,
              status: crossedIpc ? "interrupted" : "cancelled",
              phase: null,
              source: targetRun.source,
              ...(targetRun.commandId ? { commandId: targetRun.commandId } : {}),
              error
            });
            terminalRunIds.add(targetRun.runId);
            interruptedRunIds.push(...(crossedIpc ? [targetRun.runId] : []));
            if (crossedIpc) interruptedOperationIds.push(targetRun.operationId);
            add(targetRun.runId, targetRun.operationId, "operation.updated", {
              operationId: targetRun.operationId,
              kind: "run",
              status: crossedIpc ? "interrupted" : "cancelled",
              runId: targetRun.runId,
              ...(targetRun.commandId ? { commandId: targetRun.commandId } : {}),
              error
            });
          }
          queueChanged = true;
        } else if (targetRun && activeRun(targetRun)) {
          nextState = "unknown";
          error = commandError("UNKNOWN_RUNTIME", "the targeted Run was active when its worker exited");
        } else {
          nextState = isControlKind(kind) ? "cancelled" : currentState === "queued" ? "cancelled" : "unknown";
          error = nextState === "unknown"
            ? commandError("UNKNOWN_RUNTIME", "the targeted runtime result is unknown")
            : commandError("STALE_RUNTIME", "the targeted runtime was no longer available");
        }
      } else if (isControlKind(kind)) {
        nextState = "cancelled";
        error = commandError("STALE_RUNTIME", "the old control command was not delivered to the replacement worker");
      } else if (currentState === "dispatching" || currentState === "accepted") {
        nextState = "unknown";
        error = commandError("UNKNOWN_RUNTIME", "the command was dispatched before the worker exited");
      } else if (!isQueueCommand(kind)) {
        nextState = "cancelled";
        error = commandError("RESTART_BEFORE_DISPATCH", "the configuration command was not dispatched before restart");
      }

      if (!nextState || !error || terminalCommandIds.has(commandId)) continue;
      add(null, operationForCommand(state, commandId), "command.updated", {
        commandId,
        kind,
        state: nextState,
        ...(targetRunId ? { targetRunId } : {}),
        runs: refs,
        error
      });
      terminalCommandIds.add(commandId);
      if (nextState === "unknown") unknownCommandIds.push(commandId);
      else staleCommandIds.push(commandId);
    }

    // A worker loss pauses only the already queued tail. A queue with no tail
    // is ready immediately; new commands are never blocked by this marker.
    if (interruptedRunIds.length > 0 && queueItems.length > 0) {
      queueChanged = true;
      pausedQueue = true;
    }
    if (queueChanged) {
      const items = queueItems
        .filter((item) => !terminalCommandIds.has(item.commandId))
        .map((item, index) => ({ ...item, position: index }));
      const pause = pausedQueue && items.length > 0
        ? { runId: interruptedRunIds[0]!, reason: "interrupted" as const }
        : null;
      add(null, null, "queue.updated", {
        state: pause ? "paused" : "ready",
        version: state.queue.version + 1,
        pause,
        items
      });
    }

    if (events.length === 0) {
      return {
        sessionId,
        interruptedRunIds,
        interruptedOperationIds,
        unknownCommandIds,
        staleCommandIds,
        pausedQueue: false,
        appendedEvents: 0
      };
    }

    const results = appendInChunks(this.eventStore, sessionId, workerEpoch, events);
    return {
      sessionId,
      interruptedRunIds,
      interruptedOperationIds,
      unknownCommandIds,
      staleCommandIds,
      pausedQueue,
      appendedEvents: results.reduce((total, result) => total + (result.duplicate ? 0 : result.events.length), 0)
    };
  }
}

export function recoverSession(
  database: DatabaseSync,
  sessionId: string,
  options: RecoveryOptions = {}
): RecoveryReport {
  return new RecoveryManager(database, options).recoverSession(sessionId);
}

export function recoverAllSessions(database: DatabaseSync, options: RecoveryOptions = {}): RecoveryReport[] {
  return new RecoveryManager(database, options).recoverAll();
}
