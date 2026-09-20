import { createHmac } from "node:crypto";
import { readdir, realpath, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { inspectPiSessionFile } from "@pi-remote/agent-pi";
import type { RecoverableHistory } from "@pi-remote/protocol";

export interface NativeHistoryCandidate extends RecoverableHistory {
  path: string;
  nativeId: string;
}

/** Read-only discovery of service-managed JSONL. Never calls permissive SDK open. */
export async function discoverNativeHistory(root: string, cwd: string, projectId: string, secret: string): Promise<NativeHistoryCandidate[]> {
  const candidates: NativeHistoryCandidate[] = [];
  let base: string;
  try { base = await realpath(root); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const projectPath = await realpath(cwd);
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      // Discovery is a file API boundary, not an agent execution sandbox.
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { await visit(path); continue; }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      let canonical: string;
      try { canonical = await realpath(path); } catch { continue; }
      const filename = relative(base, canonical);
      if (filename.startsWith(`..${sep}`) || filename === "..") continue;
      const inspected = await inspectPiSessionFile(canonical);
      if (inspected.kind !== "persisted") continue;
      try { if (await realpath(inspected.header.cwd) !== projectPath) continue; } catch { continue; }
      let modifiedAt: string;
      try { modifiedAt = (await stat(canonical)).mtime.toISOString(); } catch { continue; }
      candidates.push({
        candidateId: createHmac("sha256", secret).update(JSON.stringify([projectId, filename, inspected.header.id])).digest("hex"),
        filename, title: `找回的会话 ${inspected.header.id.slice(0, 8)}`,
        modifiedAt, entryCount: inspected.entryCount,
        path: canonical, nativeId: inspected.header.id
      });
    }
  }
  await visit(base);
  // Ambiguous copies of one native identity must not become separate Sessions.
  const counts = new Map<string, number>();
  for (const candidate of candidates) counts.set(candidate.nativeId, (counts.get(candidate.nativeId) ?? 0) + 1);
  return candidates.filter(candidate => counts.get(candidate.nativeId) === 1)
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || a.candidateId.localeCompare(b.candidateId));
}
