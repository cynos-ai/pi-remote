import { describe, expect, it } from "vitest";
import { applyExtensionNotice, emptyExtensionUi } from "../../apps/mobile/src/extension-ui";
import { createInitialState, toSnapshot, snapshotSchema } from "../../packages/protocol/src/index";
import { stateFromSnapshot } from "../../apps/mobile/src/session-model";

describe("R10 extension UI", () => {
  it("restores notices, applies text UI and does not replay editor mutations twice", () => {
    const notices = [
      { seq: 1, kind: "extension_ui", message: "", details: { method: "setStatus", args: ["build", "running"] } },
      { seq: 2, kind: "extension_ui", message: "", details: { method: "setWidget", args: ["tests", ["one", "two"]] } },
      { seq: 3, kind: "extension_ui", message: "", details: { method: "setEditorText", args: ["draft"] } },
      { seq: 4, kind: "extension_ui", message: "", details: { method: "pasteToEditor", args: [" suffix"] } },
      { seq: 5, kind: "extension_ui", message: "", details: { method: "setWorkingMessage", args: ["checking"] } }
    ];
    const state = createInitialState("session");
    state.notices = notices;
    const snapshot = snapshotSchema.parse(toSnapshot(state));
    let ui = stateFromSnapshot(snapshot).notices.reduce(applyExtensionNotice, emptyExtensionUi());
    expect(ui).toMatchObject({ statuses: { build: "running" }, widgets: { tests: ["one", "two"] }, editorText: "draft suffix", workingMessage: "checking" });
    expect(notices.reduce(applyExtensionNotice, ui)).toEqual(ui);
    ui = applyExtensionNotice(ui, { seq: 6, kind: "extension_ui", details: { method: "setStatus", args: ["build", null] } });
    ui = applyExtensionNotice(ui, { seq: 7, kind: "extension_ui", details: { method: "setWidget", args: ["tests", null] } });
    expect(ui.statuses).toEqual({});
    expect(ui.widgets).toEqual({});
  });

  it("reports unsupported terminal UI instead of claiming successful rendering", () => {
    expect(applyExtensionNotice(emptyExtensionUi(), { seq: 1, kind: "extension_ui", details: { method: "custom", args: [] } }).unsupported).toContain("custom");
    expect(applyExtensionNotice(emptyExtensionUi(), { seq: 1, kind: "other" })).toEqual(emptyExtensionUi());
  });
});
