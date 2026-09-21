export type TrustSelection = { trusted: boolean; updates: Array<{ path: string; decision: boolean | null }> };
export type TrustEntry = { path: string; decision: boolean } | null;
const native = await import(new URL("./core/trust-manager.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href) as {
  ProjectTrustStore: new (agentDir: string) => { getEntry(cwd: string): TrustEntry; setMany(updates: TrustSelection["updates"]): void };
  hasTrustRequiringProjectResources(cwd: string): boolean;
};

export function savedProjectTrust(agentDir: string, cwd: string): TrustEntry {
  return new native.ProjectTrustStore(agentDir).getEntry(cwd);
}

/** Apply explicit decisions at runtime creation; retain the existing fallback. */
export function initialProjectTrust(agentDir: string, cwd: string): boolean {
  return !native.hasTrustRequiringProjectResources(cwd) || (savedProjectTrust(agentDir, cwd)?.decision ?? true);
}

/** Native locked read/merge/write preserves decisions made by other workers. */
export function saveProjectTrust(agentDir: string, selection: TrustSelection): void {
  new native.ProjectTrustStore(agentDir).setMany(selection.updates);
}
