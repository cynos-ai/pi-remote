import { randomUUID } from "node:crypto";

export type SchedulerLimit = number | 0 | null | undefined;

export interface SchedulerOptions {
  /** 0 / null / undefined means unlimited. */
  maxWorkers?: SchedulerLimit;
  /** 0 / null / undefined means unlimited. */
  maxRuns?: SchedulerLimit;
  /** Disabled by default; when enabled, one model Run owns a workspace at a time. */
  serializeWorkspace?: boolean;
}

export interface WorkerSlotRequest {
  workerId: string;
  sessionId: string;
  workspaceKey: string;
}

export interface RunSlotRequest {
  sessionId: string;
  workspaceKey: string;
  runId?: string;
}

export interface ScheduleLease {
  leaseId: string;
  sessionId: string;
  workspaceKey: string;
  runId: string | null;
  acquiredAt: number;
}

export type ScheduleRejectionCode = "SESSION_BUSY" | "WORKSPACE_BUSY" | "RUN_CAPACITY" | "WORKER_CAPACITY";

export interface ScheduleDecision {
  allowed: boolean;
  code?: ScheduleRejectionCode;
  message?: string;
}

export interface WorkerActivity {
  activeCall: boolean;
  pendingInteractions: number;
  lastActivityAt: number;
}

interface WorkerSlot extends WorkerSlotRequest {
  activity: WorkerActivity;
}

function checkLimit(limit: SchedulerLimit, count: number): boolean {
  return limit === undefined || limit === null || limit === 0 || (Number.isSafeInteger(limit) && limit > count);
}

function requirePositiveLimit(limit: SchedulerLimit, name: string): void {
  if (limit === undefined || limit === null || limit === 0) return;
  if (!Number.isSafeInteger(limit) || (limit as number) < 1) throw new Error(`${name} must be a positive integer or zero`);
}

/**
 * In-memory admission control for the model-run boundary.
 *
 * It deliberately does not serialize workspaces unless the operator opts in.
 * SDK steer/follow-up/abort and user Bash are control paths, not model-run
 * leases, so they can continue while a lease is held.
 */
export class Scheduler {
  private readonly options: Required<Pick<SchedulerOptions, "serializeWorkspace">> & SchedulerOptions;
  private readonly workers = new Map<string, WorkerSlot>();
  private readonly runsBySession = new Map<string, ScheduleLease>();
  private readonly runsByWorkspace = new Map<string, ScheduleLease>();
  private readonly runsByLease = new Map<string, ScheduleLease>();

  constructor(options: SchedulerOptions = {}) {
    requirePositiveLimit(options.maxWorkers, "maxWorkers");
    requirePositiveLimit(options.maxRuns, "maxRuns");
    this.options = { serializeWorkspace: options.serializeWorkspace === true, ...options };
  }

  get activeWorkerCount(): number {
    return this.workers.size;
  }

  get activeRunCount(): number {
    return this.runsByLease.size;
  }

  workerDecision(): ScheduleDecision {
    return checkLimit(this.options.maxWorkers, this.workers.size)
      ? { allowed: true }
      : { allowed: false, code: "WORKER_CAPACITY", message: "configured worker capacity has been reached" };
  }

  registerWorker(input: WorkerSlotRequest, now = Date.now()): ScheduleDecision {
    if (this.workers.has(input.workerId)) return { allowed: true };
    const decision = this.workerDecision();
    if (!decision.allowed) return decision;
    this.workers.set(input.workerId, {
      ...input,
      activity: { activeCall: false, pendingInteractions: 0, lastActivityAt: now }
    });
    return { allowed: true };
  }

  unregisterWorker(workerId: string): void {
    this.workers.delete(workerId);
  }

  worker(workerId: string): WorkerSlotRequest & { activity: WorkerActivity } | null {
    const worker = this.workers.get(workerId);
    return worker ? { ...worker, activity: { ...worker.activity } } : null;
  }

  updateWorkerActivity(workerId: string, activity: Partial<WorkerActivity>, now = Date.now()): void {
    const worker = this.workers.get(workerId);
    if (!worker) return;
    worker.activity = {
      ...worker.activity,
      ...activity,
      lastActivityAt: activity.lastActivityAt ?? now
    };
  }

  /** Returns false for an active call or a worker-owned pending interaction. */
  canReapWorker(workerId: string, now = Date.now(), idleWorkerMs = 0): boolean {
    if (idleWorkerMs <= 0) return false;
    const worker = this.workers.get(workerId);
    if (!worker || worker.activity.activeCall || worker.activity.pendingInteractions > 0) return false;
    return now - worker.activity.lastActivityAt >= idleWorkerMs;
  }

  runDecision(input: RunSlotRequest): ScheduleDecision {
    if (this.runsBySession.has(input.sessionId)) {
      return { allowed: false, code: "SESSION_BUSY", message: `session ${input.sessionId} already has an active model Run` };
    }
    if (this.options.serializeWorkspace && this.runsByWorkspace.has(input.workspaceKey)) {
      return { allowed: false, code: "WORKSPACE_BUSY", message: `workspace ${input.workspaceKey} is occupied` };
    }
    if (!checkLimit(this.options.maxRuns, this.runsByLease.size)) {
      return { allowed: false, code: "RUN_CAPACITY", message: "configured model-run capacity has been reached" };
    }
    return { allowed: true };
  }

  acquireRun(input: RunSlotRequest, now = Date.now()): ScheduleLease {
    const decision = this.runDecision(input);
    if (!decision.allowed) {
      throw new SchedulerBusyError(
        (decision.code ?? "RUN_CAPACITY") as Exclude<ScheduleRejectionCode, "WORKER_CAPACITY">,
        decision.message ?? "model-run admission was rejected"
      );
    }
    const lease: ScheduleLease = {
      leaseId: randomUUID(),
      sessionId: input.sessionId,
      workspaceKey: input.workspaceKey,
      runId: input.runId ?? null,
      acquiredAt: now
    };
    this.runsBySession.set(input.sessionId, lease);
    this.runsByLease.set(lease.leaseId, lease);
    if (this.options.serializeWorkspace) this.runsByWorkspace.set(input.workspaceKey, lease);
    return lease;
  }

  releaseRun(leaseOrId: ScheduleLease | string): boolean {
    const lease = typeof leaseOrId === "string" ? this.runsByLease.get(leaseOrId) : leaseOrId;
    if (!lease || !this.runsByLease.has(lease.leaseId)) return false;
    this.runsByLease.delete(lease.leaseId);
    if (this.runsBySession.get(lease.sessionId)?.leaseId === lease.leaseId) this.runsBySession.delete(lease.sessionId);
    if (this.runsByWorkspace.get(lease.workspaceKey)?.leaseId === lease.leaseId) this.runsByWorkspace.delete(lease.workspaceKey);
    return true;
  }

  activeRunForSession(sessionId: string): ScheduleLease | null {
    return this.runsBySession.get(sessionId) ?? null;
  }

  activeRunForWorkspace(workspaceKey: string): ScheduleLease | null {
    return this.runsByWorkspace.get(workspaceKey) ?? null;
  }

  clear(): void {
    this.runsBySession.clear();
    this.runsByWorkspace.clear();
    this.runsByLease.clear();
    this.workers.clear();
  }
}

export class SchedulerBusyError extends Error {
  constructor(public readonly code: Exclude<ScheduleRejectionCode, "WORKER_CAPACITY">, message: string) {
    super(message);
    this.name = "SchedulerBusyError";
  }
}

export const WorkspaceScheduler = Scheduler;
