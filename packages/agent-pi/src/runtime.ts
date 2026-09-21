import { AsyncLocalStorage } from "node:async_hooks";
import type { ModelInfo } from "@pi-remote/protocol";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  AgentSession,
  type AgentSessionEvent,
  type AgentSessionRuntime,
  type AgentSessionServices,
  type CreateAgentSessionResult,
  type ResourceLoader,
  type SessionStartEvent,
  type ToolDefinition
} from "@earendil-works/pi-coding-agent";
import type { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { stat } from "node:fs/promises";
import { initialProjectTrust } from "./project-trust.js";
import { inspectPiSessionFile, openPiSessionFile, PiSessionHistoryError, type PiSessionFileState } from "./session-file.js";

type SdkModel = Parameters<AgentSession["setModel"]>[0];
type SdkThinkingLevel = Parameters<AgentSession["setThinkingLevel"]>[0];
type SdkResourceLoaderOptions = ConstructorParameters<typeof DefaultResourceLoader>[0];
type ExtensionBindings = Parameters<AgentSession["bindExtensions"]>[0];
const nativePaths = await import(new URL("./utils/paths.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href) as {
  resolvePath(path: string): string;
};

export interface PiAgentSessionOptions {
  cwd: string;
  agentDir: string;
  sessionDir?: string;
  sessionFile?: string;
  sessionId?: string;
  persistenceState?: "uninitialized" | "unflushed" | "persisted";
  sessionManager?: SessionManager;
  settingsManager?: SettingsManager;
  modelRuntime?: ModelRuntime;
  resourceLoader?: ResourceLoader;
  resourceLoaderOptions?: Omit<SdkResourceLoaderOptions, "cwd" | "agentDir" | "settingsManager">;
  sessionStartEvent?: SessionStartEvent;
  model?: SdkModel;
  thinkingLevel?: SdkThinkingLevel;
  scopedModels?: Array<{ model: SdkModel; thinkingLevel?: SdkThinkingLevel }>;
  tools?: string[];
  excludeTools?: string[];
  noTools?: "all" | "builtin";
  customTools?: ToolDefinition[];
}

export interface PiAgentSessionHandle extends CreateAgentSessionResult {
  sessionManager: SessionManager;
  services: AgentSessionServices;
  /** The file state observed before SessionManager.open(), when a file was supplied. */
  sessionFileState?: PiSessionFileState;
  dispose(): void;
  bindExtensions(bindings: ExtensionBindings): Promise<void>;
  onEvent(listener: (event: AgentSessionEvent) => void): () => void;
  importFromJsonl?(path: string): Promise<{ cancelled: boolean }>;
}

async function resolveSessionManager(options: PiAgentSessionOptions): Promise<{
  manager: SessionManager;
  state?: PiSessionFileState;
}> {
  if ((options.persistenceState === "persisted" || options.persistenceState === "unflushed") && !options.sessionFile && !options.sessionManager) {
    throw new PiSessionHistoryError({ kind: "invalid", path: options.cwd, reason: "recovery requires the recorded session file" });
  }
  if (options.sessionManager) {
    return { manager: options.sessionManager };
  }

  if (options.sessionFile) {
    const opened = await openPiSessionFile({
      path: options.sessionFile,
      cwd: options.cwd,
      sessionDir: options.sessionDir,
      sessionId: options.sessionId,
      persistenceState: options.persistenceState
    });
    return { manager: opened.manager, state: opened.state };
  }

  return {
    manager: SessionManager.create(options.cwd, options.sessionDir, options.sessionId ? { id: options.sessionId } : undefined)
  };
}

async function resolveServices(
  options: PiAgentSessionOptions,
  cwd = options.cwd,
  agentDir = options.agentDir
): Promise<AgentSessionServices> {
  const settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir, {
    projectTrusted: initialProjectTrust(agentDir, cwd)
  });
  if (options.resourceLoader) {
    const modelRuntime = options.modelRuntime ?? await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
      refreshOnCreate: false
    });
    return {
      cwd,
      agentDir,
      modelRuntime,
      settingsManager,
      resourceLoader: options.resourceLoader,
      diagnostics: []
    };
  }

  return createAgentSessionServices({
    cwd,
    agentDir,
    modelRuntime: options.modelRuntime,
    settingsManager,
    resourceLoaderOptions: options.resourceLoaderOptions
  });
}

async function createFromServices(
  options: PiAgentSessionOptions,
  sessionManager: SessionManager,
  services: AgentSessionServices,
  sessionStartEvent = options.sessionStartEvent
): Promise<CreateAgentSessionResult> {
  return createAgentSessionFromServices({
    services,
    sessionManager,
    sessionStartEvent,
    model: options.model,
    thinkingLevel: options.thinkingLevel,
    scopedModels: options.scopedModels,
    tools: options.tools,
    excludeTools: options.excludeTools,
    noTools: options.noTools,
    customTools: options.customTools
  });
}

export async function createPiAgentSession(options: PiAgentSessionOptions): Promise<PiAgentSessionHandle> {
  const { manager, state } = await resolveSessionManager(options);
  const services = await resolveServices(options);
  const created = await createFromServices(options, manager, services);
  let disposed = false;

  return {
    ...created,
    sessionManager: manager,
    services,
    sessionFileState: state,
    dispose() {
      if (!disposed) {
        disposed = true;
        created.session.dispose();
      }
    },
    bindExtensions(bindings) {
      return created.session.bindExtensions(bindings);
    },
    onEvent(listener) {
      return created.session.subscribe(listener);
    }
  };
}

export interface PiAgentRuntimeOptions extends Omit<PiAgentSessionOptions, "sessionManager" | "sessionFile"> {
  sessionManager?: SessionManager;
  sessionFile?: string;
  onSessionReplaced?: (session: AgentSession, request?: PiSessionReplacementRequest) => Promise<void>;
}

export interface PiAgentRuntimeHandle {
  runtime: AgentSessionRuntime;
  sessionFileState?: PiSessionFileState;
  dispose(): Promise<void>;
}

export async function createPiAgentRuntime(options: PiAgentRuntimeOptions): Promise<PiAgentRuntimeHandle> {
  const { manager: sessionManager, state: sessionFileState } = await resolveSessionManager(options);

  const createRuntime = async ({
    cwd,
    agentDir,
    sessionManager: replacementManager,
    sessionStartEvent
  }: {
    cwd: string;
    agentDir: string;
    sessionManager: SessionManager;
    sessionStartEvent?: SessionStartEvent;
  }) => {
    const services = await resolveServices(options, cwd, agentDir);
    const created = await createFromServices(options, replacementManager, services, sessionStartEvent);
    return {
      ...created,
      services,
      diagnostics: services.diagnostics
    };
  };

  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd: options.cwd,
    agentDir: options.agentDir,
    sessionManager,
    sessionStartEvent: options.sessionStartEvent
  });
  if (options.onSessionReplaced) {
    runtime.setRebindSession(options.onSessionReplaced);
  }

  return {
    runtime,
    sessionFileState,
    dispose: () => runtime.dispose()
  };
}

export function subscribePiSession(
  session: AgentSession,
  listener: (event: AgentSessionEvent) => void
): () => void {
  return session.subscribe(listener);
}

export interface PiSessionReplacementRequest {
  kind: "new" | "switch" | "fork" | "import";
  session: AgentSession;
  sessionPath?: string;
  entryId?: string;
}

export interface PiWorkerSessionOptions extends PiAgentRuntimeOptions {
  /** Persist replacement intent before the SDK can create/fork a target file. */
  onBeforeSessionReplace?: (request: PiSessionReplacementRequest) => Promise<void>;
  /** Establish destination operation context at the actual async callback boundary. */
  runInSessionContext?<T>(session: AgentSession, callback: () => Promise<T>): Promise<T>;
}

export interface PiWorkerSessionHandle extends PiAgentSessionHandle {
  runtime: AgentSessionRuntime;
  /** Await native shutdown hooks; dispose() retains the session-factory signature. */
  shutdown(): Promise<void>;
}

/** Production session facade: all access and extension actions follow the current runtime. */
export async function createPiWorkerSession(options: PiWorkerSessionOptions): Promise<PiWorkerSessionHandle> {
  const handle = await createPiAgentRuntime(options);
  const { runtime } = handle;
  let bindings: ExtensionBindings | undefined;
  let shutdown: Promise<void> | undefined;
  const listeners = new Map<(event: AgentSessionEvent) => void, () => void>();
  // Unrelated requests serialize through the root queue. An awaited native
  // hook/withSession continuation may replace again: give that transition its
  // own child queue rather than waiting for the ancestor holding the root.
  // Sibling nested requests still serialize, and detached callbacks from a
  // finished transition return to the root queue.
  interface ReplacementQueue { tail: Promise<void>; active: boolean; request?: PiSessionReplacementRequest }
  const rootQueue: ReplacementQueue = { tail: Promise.resolve(), active: true };
  const replacementContext = new AsyncLocalStorage<ReplacementQueue>();
  const replace = <T>(callback: () => Promise<T>): Promise<T> => {
    const inherited = replacementContext.getStore();
    const queue = inherited?.active ? inherited : rootQueue;
    const previous = queue.tail;
    let release!: () => void;
    queue.tail = new Promise<void>((resolve) => { release = resolve; });
    return (async () => {
      await previous;
      const children: ReplacementQueue = { tail: Promise.resolve(), active: true };
      try { return await replacementContext.run(children, callback); }
      finally {
        children.active = false;
        await children.tail;
        release();
      }
    })();
  };
  const before = (request: Omit<PiSessionReplacementRequest, "session">) => {
    const transition = replacementContext.getStore()!;
    transition.request = { ...request, session: runtime.session };
    return options.onBeforeSessionReplace?.(transition.request);
  };
  const inSessionContext = <T>(callback: () => Promise<T>): Promise<T> =>
    options.runInSessionContext ? options.runInSessionContext(runtime.session, callback) : callback();
  type Continuation = NonNullable<NonNullable<Parameters<AgentSessionRuntime["newSession"]>[0]>["withSession"]>;
  const wrapContinuation = (callback: Continuation | undefined): Continuation | undefined =>
    callback ? (context) => inSessionContext(() => callback(context)) : undefined;
  const actions: NonNullable<ExtensionBindings["commandContextActions"]> = {
    waitForIdle: () => runtime.session.waitForIdle(),
    newSession: (request) => replace(async () => {
      await before({ kind: "new" });
      return runtime.newSession(request ? { ...request, withSession: wrapContinuation(request.withSession) } : undefined);
    }),
    switchSession: (sessionPath, request) => replace(async () => {
      // Native switchSession calls permissive SDK open internally. Validate first.
      const state = await inspectPiSessionFile(sessionPath);
      if (state.kind !== "persisted") {
        throw new PiSessionHistoryError(state.kind === "invalid" || state.kind === "identity_mismatch"
          ? state : { kind: "invalid", path: state.path, reason: `switch history is ${state.kind}` });
      }
      await before({ kind: "switch", sessionPath });
      return runtime.switchSession(sessionPath, request ? { ...request, withSession: wrapContinuation(request.withSession) } : undefined);
    }),
    fork: (entryId, request) => replace(async () => {
      await before({ kind: "fork", entryId });
      return runtime.fork(entryId, request ? { ...request, withSession: wrapContinuation(request.withSession) } : undefined);
    }),
    navigateTree: (targetId, request) => runtime.session.navigateTree(targetId, request),
    reload: () => runtime.session.reload()
  };
  runtime.setRebindSession(async (session) => {
    for (const unsubscribe of listeners.values()) unsubscribe();
    for (const listener of listeners.keys()) listeners.set(listener, session.subscribe(listener));
    // ACK identity before session_start or withSession can emit new work.
    await options.onSessionReplaced?.(session, replacementContext.getStore()?.request);
    if (bindings) await inSessionContext(() => session.bindExtensions({ ...bindings!, commandContextActions: actions }));
  });
  const stop = () => {
    shutdown ??= (async () => {
      try { await runtime.dispose(); }
      finally {
        for (const unsubscribe of listeners.values()) unsubscribe();
        listeners.clear();
      }
    })();
    return shutdown;
  };
  return {
    runtime,
    importFromJsonl: (inputPath: string) => replace(async () => {
      const path = nativePaths.resolvePath(inputPath);
      const state = await inspectPiSessionFile(path);
      if (state.kind !== "persisted") throw new Error(`导入历史不可用：${state.kind === "invalid" ? state.reason : state.kind}`);
      // A cwd override is not written back by the pinned SDK. Do not accept an
      // in-memory repair that would fail durable recovery on the next worker.
      const cwd = await stat(state.header.cwd).catch(() => undefined);
      if (!cwd?.isDirectory()) throw new Error(`导入工作目录不存在：${state.header.cwd}；请恢复该目录后重试。持久化 cwd 重定位仍待适配`);
      await before({ kind: "import", sessionPath: path });
      return runtime.importFromJsonl(path);
    }),
    get session() { return runtime.session; },
    get sessionManager() { return runtime.session.sessionManager; },
    get services() { return runtime.services; },
    get modelFallbackMessage() { return runtime.modelFallbackMessage; },
    get extensionsResult() { return runtime.services.resourceLoader.getExtensions(); },
    sessionFileState: handle.sessionFileState,
    async bindExtensions(nextBindings) {
      bindings = nextBindings;
      await runtime.session.bindExtensions({ ...nextBindings, commandContextActions: actions });
    },
    onEvent(listener) {
      // Each subscription owns its identity, even if the callback is reused.
      const forward = (event: AgentSessionEvent) => listener(event);
      listeners.set(forward, runtime.session.subscribe(forward));
      return () => { listeners.get(forward)?.(); listeners.delete(forward); };
    },
    dispose() { void stop().catch(() => { /* Await shutdown() to observe hook failures. */ }); },
    shutdown: stop
  };
}

/** Configured catalog without creating an application or SDK session. */
export async function readPiModelCatalog(options: { agentDir: string; refresh?: boolean }): Promise<ModelInfo[]> {
  const modelRuntime = await ModelRuntime.create({
    authPath: join(options.agentDir, "auth.json"),
    modelsPath: join(options.agentDir, "models.json"),
    refreshOnCreate: false
  });
  if (options.refresh) await modelRuntime.refresh();
  const error = modelRuntime.getError();
  if (error) throw new Error(error);
  return modelRuntime.getModels().map((model) => ({
    model: { provider: model.provider, id: model.id },
    name: model.name,
    contextWindow: model.contextWindow,
    // SDK 0.85.1 delegates this method solely to its model capability helper.
    thinkingLevels: Reflect.apply(AgentSession.prototype.getAvailableThinkingLevels, { model }, []) as string[]
  }));
}
