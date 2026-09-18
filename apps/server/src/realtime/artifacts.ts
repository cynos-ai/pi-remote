import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, realpath, rename, rm, stat } from "node:fs/promises";
import { mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { artifactSchema, type Artifact } from "@pi-remote/protocol";
import type { AuthContext } from "../auth.js";
import {
  ArtifactRepository,
  type ArtifactRecord,
  validateArtifactRelativePath
} from "../storage/index.js";

export const DEFAULT_ARTIFACT_MAX_BYTES = 20 * 1024 * 1024;
export const DEFAULT_SESSION_ARTIFACT_QUOTA_BYTES = 100 * 1024 * 1024;

export class ArtifactStoreError extends Error {
  constructor(
    public readonly code: "ARTIFACT_UNAVAILABLE" | "ARTIFACT_STORAGE_LIMIT",
    message: string
  ) {
    super(message);
    this.name = "ArtifactStoreError";
  }
}

export interface ArtifactDownload {
  record: ArtifactRecord;
  metadata: Artifact;
  filePath: string;
}

export interface ArtifactStoreOptions {
  rootDir: string;
  maxArtifactBytes?: number;
  sessionQuotaBytes?: number;
  now?: () => number;
}

function ownerForSession(database: DatabaseSync, sessionId: string): string | null {
  const row = database.prepare(`
    SELECT p.user_id
    FROM sessions s JOIN projects p ON p.id = s.project_id
    WHERE s.id = ?
  `).get(sessionId) as { user_id?: unknown } | undefined;
  return typeof row?.user_id === "string" ? row.user_id : null;
}

function artifactMetadata(record: ArtifactRecord): Artifact {
  return artifactSchema.parse({
    id: record.id,
    sessionId: record.sessionId,
    mimeType: record.mimeType,
    byteLength: record.sizeBytes,
    sha256: record.sha256,
    createdAt: new Date(record.createdAt).toISOString()
  });
}

function safeSessionDirectory(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
}

function containsMimeControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function isWithin(rootDir: string, candidate: string): boolean {
  const root = resolve(rootDir);
  const child = resolve(candidate);
  const relativePath = relative(root, child);
  return relativePath !== "" && !relativePath.startsWith("..") && !isAbsolute(relativePath);
}

/**
 * Owns the server-generated output files. The database only stores metadata;
 * callers never provide a filesystem path to a download route.
 */
export class ArtifactStore {
  private readonly repository: ArtifactRepository;
  private readonly rootDir: string;
  private readonly maxArtifactBytes: number;
  private readonly sessionQuotaBytes: number;
  private readonly now: () => number;

  constructor(private readonly database: DatabaseSync, options: ArtifactStoreOptions) {
    this.repository = new ArtifactRepository(database);
    this.rootDir = resolve(options.rootDir);
    this.maxArtifactBytes = options.maxArtifactBytes ?? DEFAULT_ARTIFACT_MAX_BYTES;
    this.sessionQuotaBytes = options.sessionQuotaBytes ?? DEFAULT_SESSION_ARTIFACT_QUOTA_BYTES;
    this.now = options.now ?? (() => Date.now());
    if (!Number.isSafeInteger(this.maxArtifactBytes) || this.maxArtifactBytes < 1) {
      throw new Error("artifact max bytes must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.sessionQuotaBytes) || this.sessionQuotaBytes < this.maxArtifactBytes) {
      throw new Error("artifact session quota must cover one artifact");
    }
    mkdirSync(this.rootDir, { recursive: true });
  }

  /** Archive a full binary copy for later authorized download or attachment use. */
  async archiveBytes(input: {
    sessionId: string;
    runId?: string | null;
    bytes: Uint8Array;
    mimeType?: string;
  }): Promise<ArtifactRecord | null> {
    const bytes = Buffer.from(input.bytes);
    if (bytes.byteLength > this.maxArtifactBytes) return null;
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const existing = this.repository.findByHash(input.sessionId, sha256);
    if (existing) {
      try {
        this.resolvePath(existing);
        return existing;
      } catch {
        // A missing or replaced file is repaired by writing a fresh copy.
      }
    }
    if (!existing && this.repository.totalBytes(input.sessionId) + bytes.byteLength > this.sessionQuotaBytes) return null;

    const id = existing?.id ?? randomUUID();
    const relativePath = existing?.relativePath ?? validateArtifactRelativePath(`${safeSessionDirectory(input.sessionId)}/${id}.bin`);
    const mimeType = input.mimeType?.trim() || "application/octet-stream";
    if (mimeType.length > 255 || containsMimeControlCharacter(mimeType)) {
      throw new ArtifactStoreError("ARTIFACT_UNAVAILABLE", "artifact MIME type is invalid");
    }
    const finalPath = join(this.rootDir, relativePath);
    const temporaryPath = join(this.rootDir, `.${id}.${randomUUID()}.tmp`);
    await mkdir(dirname(finalPath), { recursive: true });
    try {
      const file = await open(temporaryPath, "wx", 0o600);
      try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      const written = await stat(temporaryPath);
      if (written.size !== bytes.byteLength) throw new ArtifactStoreError("ARTIFACT_UNAVAILABLE", "artifact size verification failed");
      if (!isWithin(await realpath(this.rootDir), await realpath(dirname(finalPath)))) {
        throw new ArtifactStoreError("ARTIFACT_UNAVAILABLE", "artifact root changed during archival");
      }
      await rename(temporaryPath, finalPath);
      const directory = await open(dirname(finalPath), "r");
      try { await directory.sync(); } finally { await directory.close(); }
      const rootDirectory = await open(this.rootDir, "r");
      try { await rootDirectory.sync(); } finally { await rootDirectory.close(); }
      // Repair with the original identity so retried event batches retain their hash.
      if (existing) return existing;
      try {
        this.repository.create({
          id,
          sessionId: input.sessionId,
          runId: input.runId ?? null,
          relativePath,
          mimeType,
          sizeBytes: bytes.byteLength,
          sha256,
          now: this.now()
        });
      } catch (error) {
        await rm(finalPath, { force: true });
        throw error;
      }
      return this.repository.get(id);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }

  /** Archive a full text copy for later authorized download. */
  async archiveText(input: {
    sessionId: string;
    runId?: string | null;
    text: string;
    mimeType?: string;
  }): Promise<ArtifactRecord | null> {
    return this.archiveBytes({
      sessionId: input.sessionId,
      runId: input.runId,
      bytes: Buffer.from(input.text, "utf8"),
      mimeType: input.mimeType ?? "text/plain; charset=utf-8"
    });
  }

  /** Return a path only after owner and root containment checks. */
  getForActor(actor: AuthContext, artifactId: string): ArtifactDownload | null {
    const record = this.repository.get(artifactId);
    if (!record || ownerForSession(this.database, record.sessionId) !== actor.userId) return null;
    const filePath = this.resolvePath(record);
    return { record, metadata: artifactMetadata(record), filePath };
  }

  /** Validate that an attachment belongs to this actor and exact Session. */
  getForSession(actor: AuthContext, sessionId: string, artifactId: string): ArtifactDownload | null {
    const artifact = this.getForActor(actor, artifactId);
    return artifact?.record.sessionId === sessionId ? artifact : null;
  }

  private resolvePath(record: ArtifactRecord): string {
    const candidate = resolve(this.rootDir, validateArtifactRelativePath(record.relativePath));
    if (!isWithin(this.rootDir, candidate)) {
      throw new ArtifactStoreError("ARTIFACT_UNAVAILABLE", "artifact path is outside the output directory");
    }
    let resolved: string;
    try {
      resolved = realpathSync(candidate);
    } catch {
      throw new ArtifactStoreError("ARTIFACT_UNAVAILABLE", "artifact file is unavailable");
    }
    if (!isWithin(this.rootDir, resolved)) {
      throw new ArtifactStoreError("ARTIFACT_UNAVAILABLE", "artifact file is outside the output directory");
    }
    let file;
    try {
      file = statSync(resolved);
    } catch {
      throw new ArtifactStoreError("ARTIFACT_UNAVAILABLE", "artifact file is unavailable");
    }
    if (!file.isFile() || file.size !== record.sizeBytes ||
        createHash("sha256").update(readFileSync(resolved)).digest("hex") !== record.sha256) {
      throw new ArtifactStoreError("ARTIFACT_UNAVAILABLE", "artifact file failed metadata verification");
    }
    return resolved;
  }
}
