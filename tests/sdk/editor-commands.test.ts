import { describe, expect, it } from "vitest";
import { EDITOR_COMMANDS, PENDING_EDITOR_COMMANDS, editorPathArgument, createInformationViewer } from "../../packages/agent-pi/src/editor-commands.js";

describe("hosted editor builtins", () => {
  it("parses native quoted paths without shell interpolation", () => {
    expect(editorPathArgument('/export "a b.jsonl" ignored', "/export")).toBe("a b.jsonl");
    expect(editorPathArgument("/export 'a b.html'", "/export")).toBe("a b.html");
    expect(editorPathArgument("/export a.jsonl ignored", "/export")).toBe("a.jsonl");
    expect(editorPathArgument('/export "unclosed', "/export")).toBeUndefined();
    expect(editorPathArgument("/export $(touch).jsonl", "/export")).toBe("$(touch).jsonl");
  });
  it("keeps every known builtin explicit and separates remote exit from worker termination", () => {
    const names = [...Object.keys(EDITOR_COMMANDS), ...Object.keys(PENDING_EDITOR_COMMANDS)];
    expect(new Set(names).size).toBe(23);
    expect(EDITOR_COMMANDS.quit).toContain("后端会话继续运行");
    expect(PENDING_EDITOR_COMMANDS.share).toContain("发布确认");
  });
  it("pages the full rendered text and clamps both boundaries", () => {
    let closed = false;
    const viewer = createInformationViewer(Array.from({ length: 100 }, (_, i) => `row-${i}`).join("\n"), () => { closed = true; });
    expect(viewer.render(120)[0]).toContain("row-0");
    viewer.handleInput?.("\u001b[6~"); expect(viewer.render(120)[0]).toContain("row-18");
    viewer.handleInput?.("\u001b[F"); expect(viewer.render(120).join("\n")).toContain("row-99");
    viewer.handleInput?.("\u001b[H"); viewer.handleInput?.("\u001b[A"); expect(viewer.render(120)[0]).toContain("row-0");
    viewer.handleInput?.("\u001b"); expect(closed).toBe(true);
  });
});
