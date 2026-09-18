import { describe, expect, it } from "vitest";
import { EditorSync } from "../../apps/mobile/src/editor-sync";
import { PiRemoteApi } from "../../apps/mobile/src/api/client";

describe("R10 handset editor synchronization", () => {
  it("serializes updates and waits for the latest acknowledgment before extension dispatch", async () => {
    const sent: string[] = [];
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const sync = new EditorSync(async (text) => {
      sent.push(text);
      if (text === "old") await barrier;
    });
    const old = sync.update("old");
    const latest = sync.update("latest").then(() => { sent.push("extension dispatch"); });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent).toEqual(["old"]);
    release();
    await Promise.all([old, latest]);
    expect(sent).toEqual(["old", "latest", "extension dispatch"]);
  });

  it("surfaces a failed update and permits subsequent synchronization", async () => {
    let attempts = 0;
    const sync = new EditorSync(async () => { if (++attempts === 1) throw new Error("offline"); });
    await expect(sync.update("first")).rejects.toThrow("offline");
    await expect(sync.update("second")).resolves.toBeUndefined();
  });

  it("uses the authenticated session editor control endpoint", async () => {
    const api = new PiRemoteApi("https://example.test", { fetchImpl: async (url, init) => {
      expect(url).toBe("https://example.test/v1/sessions/session%2Fa/editor-state");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({ text: "draft" });
      expect((init?.headers as Record<string, string>)["Idempotency-Key"]).toBeTruthy();
      return new Response(null, { status: 204 });
    } });
    await api.syncEditorState("session/a", "draft");
  });
});
