import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  migrateSessionEntries,
  SessionManager,
  type FileEntry,
  type SessionEntry,
  type SessionHeader
} from "@earendil-works/pi-coding-agent";

export type PiSessionFileState =
  | {
      kind: "missing";
      path: string;
    }
  | {
      kind: "empty";
      path: string;
      bytes: number;
    }
  | {
      kind: "persisted";
      path: string;
      bytes: number;
      header: SessionHeader;
      entryCount: number;
      hasAssistantMessage: boolean;
      hasNonAssistantEntry: boolean;
    }
  | {
      kind: "invalid";
      path: string;
      reason: string;
    }
  | {
      kind: "identity_mismatch";
      path: string;
      expectedCwd: string;
      actualCwd: string;
    };

export class PiSessionHistoryError extends Error {
  readonly state: Extract<PiSessionFileState, { kind: "invalid" | "identity_mismatch" }>;

  constructor(state: Extract<PiSessionFileState, { kind: "invalid" | "identity_mismatch" }>) {
    super(
      state.kind === "invalid"
        ? `Pi session history is invalid: ${state.path}: ${state.reason}`
        : `Pi session history belongs to ${state.actualCwd}, not ${state.expectedCwd}: ${state.path}`
    );
    this.name = "PiSessionHistoryError";
    this.state = state;
  }
}

function isSessionHeader(entry: FileEntry | undefined): entry is SessionHeader {
  return Boolean(
    entry &&
      entry.type === "session" &&
      typeof entry.id === "string" &&
      entry.id.length > 0 &&
      typeof entry.timestamp === "string" &&
      typeof entry.cwd === "string" &&
      entry.cwd.length > 0
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Parse every nonblank line before invoking the SDK's permissive migration. */
function validateEntries(content: string): FileEntry[] {
  const rows: Array<{ entry: Record<string, unknown>; line: number }> = [];
  for (const [index, line] of content.split("\n").entries()) {
    if (!line.trim()) continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw new Error(`line ${index + 1}: invalid JSON`); }
    if (!record(value)) throw new Error(`line ${index + 1}: expected a JSON object`);
    rows.push({ entry: value, line: index + 1 });
  }
  const first = rows[0];
  const fail = (line: number, reason: string): never => { throw new Error(`line ${line}: ${reason}`); };
  if (!first || !isSessionHeader(first.entry as unknown as FileEntry)) {
    fail(first?.line ?? 1, "invalid session header");
  }
  const header = first!.entry;
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(header.id as string)) fail(first!.line, "invalid session ID");
  const version = header.version ?? 1;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1 || version > 3) {
    fail(first!.line, "unsupported session version");
  }
  const knownTypes = new Set(["message", "thinking_level_change", "model_change", "compaction",
    "branch_summary", "custom", "label", "session_info", "custom_message"]);
  const ids = new Set<string>();
  for (const { entry, line } of rows.slice(1)) {
    if (typeof entry.type !== "string" || !knownTypes.has(entry.type)) fail(line, "invalid entry type");
    if (typeof entry.timestamp !== "string" || !Number.isFinite(Date.parse(entry.timestamp))) fail(line, "invalid timestamp");
    if (version !== 1) {
      if (typeof entry.id !== "string" || !entry.id.trim() || ids.has(entry.id) || entry.id === header.id) {
        fail(line, "missing or duplicate entry ID");
      }
      if (entry.parentId !== null && (typeof entry.parentId !== "string" || !ids.has(entry.parentId))) {
        fail(line, "parentId must reference an earlier entry or be null");
      }
      if (entry.type === "label" && (typeof entry.targetId !== "string" || !ids.has(entry.targetId))) {
        fail(line, "label targetId must reference an earlier entry");
      }
      if (entry.type === "compaction" && entry.firstKeptEntryId !== "" &&
          (typeof entry.firstKeptEntryId !== "string" || !ids.has(entry.firstKeptEntryId))) {
        fail(line, "firstKeptEntryId must reference an earlier entry");
      }
      ids.add(entry.id as string);
    }
    // Branch summaries may refer to an abandoned branch absent from a fork.
    if (entry.type === "branch_summary" && typeof entry.fromId !== "string") fail(line, "invalid fromId");
    if (entry.type === "message" && (!record(entry.message) || typeof entry.message.role !== "string")) {
      fail(line, "invalid message");
    }
    for (const key of entry.type === "model_change" ? ["provider", "modelId"] :
      entry.type === "thinking_level_change" ? ["thinkingLevel"] :
      entry.type === "compaction" || entry.type === "branch_summary" ? ["summary"] :
      entry.type === "custom" || entry.type === "custom_message" ? ["customType"] : []) {
      if (typeof entry[key] !== "string") fail(line, `invalid ${key}`);
    }
    if (entry.type === "compaction" && (typeof entry.tokensBefore !== "number" || !Number.isFinite(entry.tokensBefore))) {
      fail(line, "invalid tokensBefore");
    }
  }
  if (typeof header.timestamp !== "string" || !Number.isFinite(Date.parse(header.timestamp))) fail(first!.line, "invalid header timestamp");
  const entries = rows.map(({ entry }) => entry) as unknown as FileEntry[];
  migrateSessionEntries(entries);
  return entries;
}

function isAssistantMessage(entry: SessionEntry): boolean {
  return entry.type === "message" && entry.message.role === "assistant";
}

function hasNonAssistantEntry(entries: SessionEntry[]): boolean {
  return entries.some((entry) => !isAssistantMessage(entry));
}

function normalizedPath(path: string): string {
  return resolve(path);
}

/**
 * Inspect a pi JSONL file without allowing the SDK to silently create a new
 * session for a missing, empty, or damaged path.
 *
 * Missing and empty files are deliberately reported as uninitialized. The SDK
 * currently initializes both when SessionManager.open() is called; callers
 * must decide whether that is acceptable for their persisted-state policy.
 */
export async function inspectPiSessionFile(
  path: string,
  expectedCwd?: string
): Promise<PiSessionFileState> {
  const absolutePath = normalizedPath(path);

  let bytes: number;
  let content: string;
  try {
    const fileStat = await stat(absolutePath);
    bytes = fileStat.size;
    content = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(absolutePath));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "missing", path: absolutePath };
    }
    return {
      kind: "invalid",
      path: absolutePath,
      reason: error instanceof Error ? error.message : String(error)
    };
  }

  if (bytes === 0 || content.trim().length === 0) {
    return { kind: "empty", path: absolutePath, bytes };
  }

  let entries: FileEntry[];
  try {
    entries = validateEntries(content);
  } catch (error: unknown) {
    return {
      kind: "invalid",
      path: absolutePath,
      reason: error instanceof Error ? error.message : String(error)
    };
  }

  const [header, ...rawSessionEntries] = entries;
  if (!isSessionHeader(header)) {
    return {
      kind: "invalid",
      path: absolutePath,
      reason: "first JSONL entry is not a valid session header"
    };
  }

  if (expectedCwd !== undefined && normalizedPath(header.cwd) !== normalizedPath(expectedCwd)) {
    return {
      kind: "identity_mismatch",
      path: absolutePath,
      expectedCwd: normalizedPath(expectedCwd),
      actualCwd: normalizedPath(header.cwd)
    };
  }

  const sessionEntries = rawSessionEntries as SessionEntry[];

  return {
    kind: "persisted",
    path: absolutePath,
    bytes,
    header,
    entryCount: sessionEntries.length,
    hasAssistantMessage: sessionEntries.some(isAssistantMessage),
    hasNonAssistantEntry: hasNonAssistantEntry(sessionEntries)
  };
}

export interface OpenPiSessionFileOptions {
  path: string;
  cwd: string;
  sessionDir?: string;
  sessionId?: string;
  persistenceState?: "uninitialized" | "unflushed" | "persisted";
}

/**
 * Open a known JSONL path only after inspecting its persisted identity.
 * With a persistence policy, only missing uninitialized/unflushed paths may
 * initialize. Unflushed recovery retains the ID and allocates a fresh SDK path.
 * Persisted histories, including header-only files, must match their mapping.
 */
export async function openPiSessionFile(options: OpenPiSessionFileOptions): Promise<{
  manager: SessionManager;
  state: PiSessionFileState;
}> {
  const state = await inspectPiSessionFile(options.path, options.cwd);
  if (state.kind === "invalid" || state.kind === "identity_mismatch") {
    throw new PiSessionHistoryError(state);
  }

  const reject = (reason: string): never => {
    throw new PiSessionHistoryError({ kind: "invalid", path: state.path, reason });
  };
  if (state.kind === "persisted" && options.sessionId !== undefined && state.header.id !== options.sessionId) {
    reject("line 1: session ID does not match the recorded mapping");
  }
  if (options.persistenceState === "persisted" && state.kind !== "persisted") {
    reject(`persisted history is ${state.kind}`);
  }
  // Preserve the legacy SDK-boundary probe when no persistence policy is given.
  // Production initialization always supplies the recorded policy.
  if (options.persistenceState !== undefined && state.kind === "empty") {
    reject("existing session file is empty");
  }
  if (state.kind === "missing" && options.persistenceState === "unflushed") {
    if (!options.sessionId) reject("unflushed recovery requires the recorded session ID");
    return {
      manager: SessionManager.create(options.cwd, options.sessionDir ?? dirname(state.path), { id: options.sessionId }),
      state
    };
  }
  return {
    manager: SessionManager.open(
      state.path,
      options.sessionDir ?? dirname(state.path),
      options.cwd
    ),
    state
  };
}
