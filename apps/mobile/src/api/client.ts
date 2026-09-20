import {
  artifactSchema,
  recoverableHistoriesResponseSchema,
  historyImportRequestSchema,
  errorResponseSchema,
  capabilityResponseSchema,
  commandDetailResponseSchema,
  commandRequestDtoSchema,
  commandReceiptDtoSchema,
  historyResponseSchema,
  meResponseSchema,
  modelsResponseSchema,
  pairResponseSchema,
  projectMutationResponseSchema,
  projectsResponseSchema,
  sessionMutationResponseSchema,
  sessionsResponseSchema,
  snapshotResponseSchema,
  wsTicketResponseSchema,
  type CapabilityResponse,
  type Artifact,
  type CommandRecord,
  type CommandReceipt,
  type CommandRequest,
  type HistoryResponse,
  type MeResponse,
  type PairResponse,
  type Project,
  type ProjectSummary,
  type SessionSummary,
  type Snapshot,
  type User,
  type ModelInfo,
  type WsTicketResponse
} from "@pi-remote/protocol";

export interface DeviceCredentials {
  baseUrl: string;
  deviceId: string;
  deviceToken: string;
  user: User;
}

export interface ProjectCreateRequest {
  name: string;
  rootPath: string;
  defaultModel?: { provider: string; id: string };
  defaultThinkingLevel?: string;
}

export interface ProjectPatchRequest {
  expectedVersion: number;
  name?: string;
  defaultModel?: { provider: string; id: string } | null;
  defaultThinkingLevel?: string | null;
}

export interface SessionCreateRequest {
  title?: string;
  model?: { provider: string; id: string };
  thinkingLevel?: string;
}

export interface SessionPatchRequest {
  expectedVersion: number;
  title?: string;
  archived?: boolean;
}

export interface ProjectMutationResponse {
  project: Project;
  commandId: string;
}

export interface SessionMutationResponse {
  session: SessionSummary;
  commandId: string;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type MobileApiErrorCode =
  | "INVALID_SERVER_URL"
  | "NETWORK_UNAVAILABLE"
  | "UNAUTHENTICATED"
  | "DEVICE_REVOKED"
  | "IDEMPOTENCY_CONFLICT"
  | "INVALID_RESPONSE"
  | string;

export class MobileApiError extends Error {
  constructor(
    public readonly code: MobileApiErrorCode,
    message: string,
    public readonly status?: number,
    public readonly details?: Record<string, unknown>,
    public readonly retryable = false
  ) {
    super(message);
    this.name = "MobileApiError";
  }
}

interface ParseSchema<T> {
  parse(value: unknown): T;
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  idempotencyKey?: string;
  authenticated?: boolean;
}

const defaultFetch: FetchLike = (input, init) => globalThis.fetch(input, init);

export function normalizeServerUrl(value: string): string {
  const trimmed = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new MobileApiError("INVALID_SERVER_URL", "服务器地址不是有效的 URL");
  }
  if (parsed.protocol !== "https:") {
    throw new MobileApiError("INVALID_SERVER_URL", "为了保护设备凭据，服务器地址必须使用 HTTPS");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new MobileApiError("INVALID_SERVER_URL", "服务器地址不能包含账号、密码、查询参数或片段");
  }
  const pathname = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.origin}${pathname}`;
}

export function makeIdempotencyKey(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") return cryptoApi.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof cryptoApi?.getRandomValues === "function") cryptoApi.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function containsMimeControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function responseMessage(body: unknown, fallback: string): string {
  const record = asRecord(body);
  const error = asRecord(record?.error);
  return typeof error?.message === "string" && error.message.length > 0 ? error.message : fallback;
}

function queryString(values: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const encoded = params.toString();
  return encoded.length > 0 ? `?${encoded}` : "";
}

export class PiRemoteApi {
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private deviceToken: string | undefined;

  constructor(
    baseUrlOrCredentials: string | DeviceCredentials,
    options: { fetchImpl?: FetchLike } = {}
  ) {
    const credentials = typeof baseUrlOrCredentials === "string" ? undefined : baseUrlOrCredentials;
    const baseUrl = typeof baseUrlOrCredentials === "string"
      ? baseUrlOrCredentials
      : baseUrlOrCredentials.baseUrl;
    this.baseUrl = normalizeServerUrl(baseUrl);
    this.deviceToken = credentials?.deviceToken;
    this.fetchImpl = options.fetchImpl ?? defaultFetch;
  }

  get serverUrl(): string {
    return this.baseUrl;
  }

  setDeviceToken(deviceToken: string | undefined): void {
    this.deviceToken = deviceToken;
  }

  async pair(pairingToken: string, deviceName: string): Promise<DeviceCredentials> {
    const response = await this.request("/v1/pair", {
      method: "POST",
      body: { pairingToken, deviceName },
      authenticated: false
    }, pairResponseSchema);
    return { baseUrl: this.baseUrl, ...response };
  }

  async getMe(): Promise<MeResponse> {
    return this.request("/v1/me", {}, meResponseSchema);
  }

  async getCapabilities(): Promise<CapabilityResponse> {
    return this.request("/v1/capabilities", {}, capabilityResponseSchema);
  }

  async getModels(sessionId?: string, refresh = false): Promise<{ items: ModelInfo[] }> {
    return this.request(`/v1/models${queryString({ sessionId, refresh: refresh ? "true" : undefined })}`, {}, modelsResponseSchema);
  }

  /** The server must acknowledge only after the worker receives editor_state. */
  async syncEditorState(sessionId: string, text: string): Promise<void> {
    await this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/editor-state`, {
      method: "POST", body: { text }, idempotencyKey: makeIdempotencyKey()
    }, { parse: () => undefined });
  }

  async issueWsTicket(): Promise<WsTicketResponse> {
    return this.request("/v1/ws-tickets", { method: "POST", body: {} }, wsTicketResponseSchema);
  }

  async listProjects(cursor: string | null = null, limit = 50): Promise<{ items: ProjectSummary[]; nextCursor: string | null }> {
    return this.request(`/v1/projects${queryString({ cursor: cursor ?? undefined, limit })}`, {}, projectsResponseSchema);
  }

  async createProject(body: ProjectCreateRequest, idempotencyKey = makeIdempotencyKey()): Promise<ProjectMutationResponse> {
    return this.request("/v1/projects", { method: "POST", body, idempotencyKey }, projectMutationResponseSchema);
  }

  async patchProject(projectId: string, body: ProjectPatchRequest, idempotencyKey = makeIdempotencyKey()): Promise<ProjectMutationResponse> {
    return this.request(`/v1/projects/${encodeURIComponent(projectId)}`, { method: "PATCH", body, idempotencyKey }, projectMutationResponseSchema);
  }

  async listSessions(
    projectId: string,
    archived: "exclude" | "only" | "all" = "exclude",
    cursor: string | null = null,
    limit = 50
  ): Promise<{ items: SessionSummary[]; nextCursor: string | null }> {
    return this.request(
      `/v1/projects/${encodeURIComponent(projectId)}/sessions${queryString({ archived, cursor: cursor ?? undefined, limit })}`,
      {},
      sessionsResponseSchema
    );
  }

  async createSession(projectId: string, body: SessionCreateRequest = {}, idempotencyKey = makeIdempotencyKey()): Promise<SessionMutationResponse> {
    return this.request(`/v1/projects/${encodeURIComponent(projectId)}/sessions`, { method: "POST", body, idempotencyKey }, sessionMutationResponseSchema);
  }

  async listRecoverableHistory(projectId: string) {
    return this.request(`/v1/projects/${encodeURIComponent(projectId)}/recoverable-history`, {}, recoverableHistoriesResponseSchema);
  }

  async importHistory(projectId: string, candidateId: string, idempotencyKey = makeIdempotencyKey()): Promise<SessionMutationResponse> {
    return this.request(`/v1/projects/${encodeURIComponent(projectId)}/history-imports`, {
      method: "POST", body: historyImportRequestSchema.parse({ candidateId }), idempotencyKey
    }, sessionMutationResponseSchema);
  }

  async patchSession(sessionId: string, body: SessionPatchRequest, idempotencyKey = makeIdempotencyKey()): Promise<SessionMutationResponse> {
    return this.request(`/v1/sessions/${encodeURIComponent(sessionId)}`, { method: "PATCH", body, idempotencyKey }, sessionMutationResponseSchema);
  }

  async getSnapshot(sessionId: string): Promise<Snapshot> {
    return this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/snapshot`, {}, snapshotResponseSchema);
  }

  async getHistory(sessionId: string, cursor: string | null = null, limit = 50): Promise<HistoryResponse> {
    return this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/history${queryString({ cursor: cursor ?? undefined, limit })}`, {}, historyResponseSchema);
  }

  async submitCommand(
    sessionId: string,
    command: CommandRequest,
    idempotencyKey = makeIdempotencyKey()
  ): Promise<CommandReceipt> {
    const validated = commandRequestDtoSchema.parse(command);
    return this.request(
      `/v1/sessions/${encodeURIComponent(sessionId)}/commands`,
      { method: "POST", body: validated, idempotencyKey },
      commandReceiptDtoSchema
    );
  }

  /**
   * A lost HTTP response is safe to retry with the same key. The server owns
   * the durable receipt; the client never invents a second command id.
   */
  async submitCommandWithRetry(
    sessionId: string,
    command: CommandRequest,
    idempotencyKey: string
  ): Promise<CommandReceipt> {
    try {
      return await this.submitCommand(sessionId, command, idempotencyKey);
    } catch (error) {
      if (!(error instanceof MobileApiError) || !error.retryable) throw error;
      return this.submitCommand(sessionId, command, idempotencyKey);
    }
  }

  async getCommand(commandId: string): Promise<CommandRecord> {
    return this.request(`/v1/commands/${encodeURIComponent(commandId)}`, {}, commandDetailResponseSchema);
  }

  /** Upload a bounded binary artifact without ever exposing a local path to the server. */
  async uploadArtifact(
    sessionId: string,
    file: { body: Blob; mimeType: string },
    idempotencyKey = makeIdempotencyKey()
  ): Promise<Artifact> {
    const mimeType = file.mimeType.trim() || "application/octet-stream";
    if (mimeType.length > 255 || containsMimeControlCharacter(mimeType)) {
      throw new MobileApiError("INVALID_RESPONSE", "附件 MIME 类型无效");
    }
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": mimeType,
      "Idempotency-Key": idempotencyKey
    };
    if (this.deviceToken !== undefined) headers.Authorization = `Bearer ${this.deviceToken}`;

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/artifacts`, {
        method: "POST",
        headers,
        body: file.body
      });
    } catch {
      throw new MobileApiError("NETWORK_UNAVAILABLE", "无法上传附件，网络恢复后可重新选择", undefined, undefined, true);
    }

    const text = await response.text();
    let body: unknown = null;
    if (text.length > 0) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        throw new MobileApiError("INVALID_RESPONSE", "服务器返回了无法解析的附件响应", response.status);
      }
    }
    if (!response.ok) {
      const parsed = errorResponseSchema.safeParse(body);
      const code = parsed.success
        ? parsed.data.error.code
        : response.status === 401
          ? "UNAUTHENTICATED"
          : response.status === 403
            ? "DEVICE_REVOKED"
            : `HTTP_${response.status}`;
      throw new MobileApiError(
        code,
        responseMessage(body, `附件上传失败（${response.status}）`),
        response.status,
        parsed.success ? parsed.data.error.details : undefined,
        response.status >= 500 || response.status === 408 || response.status === 429
      );
    }
    try {
      return artifactSchema.parse(body);
    } catch (error) {
      throw new MobileApiError(
        "INVALID_RESPONSE",
        `附件响应格式不符合协议：${error instanceof Error ? error.message : String(error)}`,
        response.status
      );
    }
  }

  private async request<T>(path: string, options: RequestOptions, schema: ParseSchema<T>): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    if (options.idempotencyKey !== undefined) headers["Idempotency-Key"] = options.idempotencyKey;
    if (options.authenticated !== false && this.deviceToken !== undefined) {
      headers.Authorization = `Bearer ${this.deviceToken}`;
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: options.method ?? "GET",
        headers,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
      });
    } catch {
      throw new MobileApiError(
        "NETWORK_UNAVAILABLE",
        "无法连接服务器，已保留本地缓存",
        undefined,
        undefined,
        true
      );
    }

    const text = await response.text();
    let body: unknown = null;
    if (text.length > 0) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        throw new MobileApiError("INVALID_RESPONSE", "服务器返回了无法解析的响应", response.status);
      }
    }
    if (!response.ok) {
      const parsed = errorResponseSchema.safeParse(body);
      const code = parsed.success
        ? parsed.data.error.code
        : response.status === 401
          ? "UNAUTHENTICATED"
          : response.status === 403
            ? "DEVICE_REVOKED"
            : `HTTP_${response.status}`;
      const details = parsed.success ? parsed.data.error.details : undefined;
      throw new MobileApiError(
        code,
        responseMessage(body, `服务器请求失败（${response.status}）`),
        response.status,
        details,
        response.status >= 500 || response.status === 408 || response.status === 429
      );
    }
    try {
      return schema.parse(body);
    } catch (error) {
      throw new MobileApiError(
        "INVALID_RESPONSE",
        `服务器响应格式不符合协议：${error instanceof Error ? error.message : String(error)}`,
        response.status
      );
    }
  }
}

export type { HistoryResponse, MeResponse, PairResponse, Project, ProjectSummary, SessionSummary, Snapshot };
