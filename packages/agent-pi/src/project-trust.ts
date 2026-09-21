import type { LoadExtensionsResult, ProjectTrustContext, SettingsManager } from "@earendil-works/pi-coding-agent";

export type TrustSelection = { trusted: boolean; updates: Array<{ path: string; decision: boolean | null }> };
export type TrustEntry = { path: string; decision: boolean } | null;
const native = await import(new URL("./core/trust-manager.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href) as {
  ProjectTrustStore: new (agentDir: string) => { getEntry(cwd: string): TrustEntry; get(cwd: string): boolean | null; set(cwd: string, decision: boolean | null): void; setMany(updates: TrustSelection["updates"]): void };
  hasTrustRequiringProjectResources(cwd: string): boolean;
};
const resolver = await import(new URL("./core/project-trust.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href) as {
  resolveProjectTrusted(options: { cwd: string; trustStore: InstanceType<typeof native.ProjectTrustStore>;
    defaultProjectTrust: ReturnType<SettingsManager["getDefaultProjectTrust"]>; extensionsResult: LoadExtensionsResult;
    projectTrustContext: ProjectTrustContext; onExtensionError?: (message: string) => void }): Promise<boolean>;
};

export const hasTrustRequiringProjectResources = native.hasTrustRequiringProjectResources;

export function resolveProjectTrust(agentDir: string, settings: SettingsManager, extensionsResult: LoadExtensionsResult,
  context: ProjectTrustContext, onExtensionError?: (message: string) => void): Promise<boolean> {
  return resolver.resolveProjectTrusted({ cwd: context.cwd, trustStore: new native.ProjectTrustStore(agentDir),
    defaultProjectTrust: settings.getDefaultProjectTrust(), extensionsResult, projectTrustContext: context, onExtensionError });
}

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
