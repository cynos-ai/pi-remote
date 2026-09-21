import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { initializeNativeMenu } from "./model-selector.js";
import { savedProjectTrust, type TrustSelection, type TrustEntry } from "./project-trust.js";
const native = await import(new URL("./modes/interactive/components/trust-selector.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href) as {
  TrustSelectorComponent: new (options: { cwd: string; savedDecision: TrustEntry; projectTrusted: boolean;
    onSelect(selection: TrustSelection): void; onCancel(): void }) => Component;
};

export function createTrustSelector(keys: KeybindingsManager, agentDir: string, cwd: string, projectTrusted: boolean,
  done: (selection?: TrustSelection) => void): Component {
  initializeNativeMenu(keys);
  return new native.TrustSelectorComponent({ cwd, projectTrusted, savedDecision: savedProjectTrust(agentDir, cwd),
    onSelect: done, onCancel: () => done() });
}
