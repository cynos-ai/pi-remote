import type { AgentSession, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { initializeNativeMenu } from "./model-selector.js";

type Messages = ReturnType<AgentSession["getUserMessagesForForking"]>;
const native = await import(new URL("./modes/interactive/components/user-message-selector.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href) as {
  UserMessageSelectorComponent: new (messages: { id: string; text: string }[], select: (id: string) => void,
    cancel: () => void, initialSelectedId?: string) => Component & { getMessageList(): Component };
};

export function createForkSelector(keys: KeybindingsManager, messages: Messages,
  done: (message?: Messages[number]) => void): Component {
  initializeNativeMenu(keys);
  const selector = new native.UserMessageSelectorComponent(messages.map(message => ({ id: message.entryId, text: message.text })),
    id => done(messages.find(message => message.entryId === id)), () => done(), messages.at(-1)?.entryId);
  // Native interactive mode focuses the list, not its surrounding container.
  return {
    render: width => selector.render(width), invalidate: () => selector.invalidate(),
    handleInput: data => selector.getMessageList().handleInput?.(data)
  };
}
