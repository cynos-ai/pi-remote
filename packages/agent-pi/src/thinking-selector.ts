import type { AgentSession, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { initializeNativeMenu } from "./model-selector.js";

type Level = Parameters<AgentSession["setThinkingLevel"]>[0];
export type ThinkingSelection = { level: Level; persist: boolean };
const defaults = await import(new URL("./core/defaults.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href) as {
  DEFAULT_THINKING_LEVEL: Level;
};
const native = await import(new URL("./modes/interactive/components/thinking-selector.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href) as {
  ThinkingSelectorComponent: new (current: Level, available: Level[], select: (level: Level) => void,
    cancel: () => void, save: (level: Level) => void, defaultLevel: Level) => Component & { focused: boolean };
};

export function createThinkingSelector(keys: KeybindingsManager, session: AgentSession, defaultLevel: Level | undefined,
  done: (result?: ThinkingSelection) => void): Component & { focused: boolean } {
  initializeNativeMenu(keys);
  return new native.ThinkingSelectorComponent(session.thinkingLevel ?? defaults.DEFAULT_THINKING_LEVEL,
    session.getAvailableThinkingLevels(), level => done({ level, persist: false }), () => done(),
    level => done({ level, persist: true }), defaultLevel ?? defaults.DEFAULT_THINKING_LEVEL);
}
