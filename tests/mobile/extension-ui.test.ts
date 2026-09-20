import { describe, expect, it } from "vitest";
import { applyExtensionNotice, emptyExtensionUi } from "../../apps/mobile/src/extension-ui";
import { createInitialState, toSnapshot, snapshotSchema } from "../../packages/protocol/src/index";
import { stateFromSnapshot } from "../../apps/mobile/src/session-model";

describe("R10 extension UI", () => {
  it("replays scalar UI controls, native resets and repeated expansion overrides", () => {
    const calls: [string, unknown[]][] = [
      ["setWorkingVisible", [false]], ["setWorkingMessage", ["checking"]],
      ["setWorkingIndicator", [{ frames: ["a", "b"], intervalMs: 120 }]],
      ["setHiddenThinkingLabel", ["private reasoning"]], ["setTitle", ["Extension window"]],
      ["setToolsExpanded", [true]]
    ];
    const notices = calls.map(([method, args], index) => ({ seq: index + 1, kind: "extension_ui", message: method, details: { method, args } }));
    const source = createInitialState("session");
    source.notices = notices;
    const snapshot = snapshotSchema.parse(toSnapshot(source));
    const ui = snapshot.notices.reduce(applyExtensionNotice, emptyExtensionUi());
    expect(ui).toMatchObject({ workingVisible: false, workingMessage: "checking", workingIndicator: { frames: ["a", "b"], intervalMs: 120 }, hiddenThinkingLabel: "private reasoning", windowTitle: "Extension window", toolsExpanded: true, toolsExpansionSeq: 6, unsupported: null });
    expect(notices.reduce(applyExtensionNotice, ui)).toEqual(ui);
    expect(snapshot.session).toEqual(toSnapshot(createInitialState("session")).session);
    const apply = (method: string, args: unknown[]) => applyExtensionNotice(ui, { seq: 7, kind: "extension_ui", details: { method, args } });
    expect(apply("setToolsExpanded", [true]).toolsExpansionSeq).toBe(7);
    expect(apply("setToolsExpanded", [false]).toolsExpanded).toBe(false);
    expect(apply("setWorkingVisible", [true]).workingVisible).toBe(true);
    expect(apply("setWorkingIndicator", [{ frames: [] }]).workingIndicator?.frames).toEqual([]);
    expect(apply("setWorkingIndicator", [null]).workingIndicator).toBeNull();
    expect(apply("setWorkingIndicator", []).workingIndicator).toBeNull();
    expect(apply("setWorkingIndicator", [{ frames: [123] }]).unsupported).toContain("参数");
    expect(apply("setHiddenThinkingLabel", []).hiddenThinkingLabel).toBe(emptyExtensionUi().hiddenThinkingLabel);
  });

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
