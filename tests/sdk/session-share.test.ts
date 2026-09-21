import { writeFile, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { shareSession, type ShareTransport, type ShareUi } from "../../packages/agent-pi/src/session-share.js";

type Session = Parameters<typeof shareSession>[0];
function fixture() {
  let source = "<html>synthetic private message</html>", exported = "";
  const session = { modelRuntime: { getProvider: () => undefined }, exportToHtml: async (path: string) => {
    exported = path; await writeFile(path, source); return path;
  } } as unknown as Session;
  const transport: ShareTransport = { gh: vi.fn(async (args: string[]) => ({ code: 0,
    stdout: args[0] === "auth" ? "signed in" : "https://gist.github.com/test/abcdef1234\n" })), fetch: vi.fn() };
  const ui: ShareUi = { choose: vi.fn(async () => "gist" as const), preview: vi.fn(async () => {}), confirm: vi.fn(async () => true) };
  return { session, transport, ui, signal: new AbortController(), change: () => { source = "changed after preview"; }, path: () => exported };
}

it("publishes exactly the reviewed bytes only after confirmation and removes temporary export", async () => {
  const f = fixture(); let reviewed = "";
  f.ui.preview = async value => {
    reviewed = value.text; f.change();
    expect(value.sha256).toBe(createHash("sha256").update(reviewed).digest("hex"));
    expect(value.bytes).toBe(Buffer.byteLength(reviewed));
    await expect(access(f.path())).rejects.toThrow();
    expect(f.transport.gh).toHaveBeenCalledTimes(1);
    value.text = "mutated UI view";
  };
  f.ui.confirm = async value => { expect(value.text).toBe(reviewed); expect(f.transport.gh).toHaveBeenCalledTimes(1); return true; };
  expect(await shareSession(f.session, f.signal.signal, f.ui, f.transport)).toContain("https://gist.github.com/test/abcdef1234");
  expect(f.transport.gh).toHaveBeenLastCalledWith(["gist", "create", "--public=false", "--filename", "session.html", "-"], f.signal.signal, reviewed);
  expect(f.transport.fetch).not.toHaveBeenCalled();
});

it.each(["target", "confirm", "preview-abort"])("does not upload on %s cancellation", async phase => {
  const f = fixture();
  if (phase === "target") f.ui.choose = async () => undefined;
  if (phase === "confirm") f.ui.confirm = async () => false;
  if (phase === "preview-abort") f.ui.preview = async () => { f.signal.abort(); };
  expect(await shareSession(f.session, f.signal.signal, f.ui, f.transport)).toBeUndefined();
  expect(vi.mocked(f.transport.gh).mock.calls.every(([args]) => args[0] === "auth")).toBe(true);
});

it("rejects missing GitHub authentication without preview, upload, or raw diagnostics", async () => {
  const f = fixture(); f.transport.gh = vi.fn(async () => { throw new Error("private gh token"); });
  await expect(shareSession(f.session, f.signal.signal, f.ui, f.transport)).rejects.toThrow("GitHub CLI 未就绪");
  expect(f.ui.preview).not.toHaveBeenCalled(); expect(f.transport.gh).toHaveBeenCalledTimes(1);
});

it("retains a confirmed Gist result when the optional viewer URL is invalid", async () => {
  const f = fixture(); vi.stubEnv("PI_SHARE_VIEWER_URL", "javascript:invalid");
  try {
    const result = await shareSession(f.session, f.signal.signal, f.ui, f.transport);
    expect(result).toContain("https://gist.github.com/test/abcdef1234");
    expect(result).toContain("查看器地址配置无效"); expect(result).not.toContain("javascript");
  } finally { vi.unstubAllEnvs(); }
});

it.each(["failure", "abort", "invalid-url"])("never retries or claims cancellation before dispatch on %s after dispatch", async kind => {
  const f = fixture(); f.transport.gh = vi.fn(async args => {
    if (args[0] === "auth") return { code: 0, stdout: "" };
    if (kind === "abort") f.signal.abort();
    if (kind !== "invalid-url") throw new Error("private transport detail");
    return { code: 0, stdout: "javascript:secret" };
  });
  await expect(shareSession(f.session, f.signal.signal, f.ui, f.transport)).rejects.toThrow("远端可能已创建内容");
  expect(f.transport.gh).toHaveBeenCalledTimes(2); expect(f.transport.fetch).not.toHaveBeenCalled();
});

it("cleans a partial export and never uploads after export failure", async () => {
  const f = fixture(); let path = "";
  f.session.exportToHtml = async p => { path = p!; await writeFile(path, "partial"); throw new Error("export failure"); };
  await expect(shareSession(f.session, f.signal.signal, f.ui, f.transport)).rejects.toThrow("export failure");
  await expect(access(path)).rejects.toThrow(); expect(f.ui.preview).not.toHaveBeenCalled();
});

it("uses native Radius branch metadata and organization visibility with no Gist fallback", async () => {
  const f = fixture(); let reviewed = "";
  f.session = { modelRuntime: { getProvider: () => ({}), getAuth: async () => ({ auth: { apiKey: "synthetic-radius-token" } }) },
    state: { systemPrompt: "synthetic-system", tools: [{ name: "test", description: "test tool", parameters: { type: "object" } }] },
    sessionManager: { getSessionId: () => "synthetic", getCwd: () => "/tmp/synthetic", getBranch: () => [
      { type: "message", id: "one", parentId: "outside-branch", message: { role: "user", content: "synthetic-message" } }
    ] }
  } as unknown as Session;
  f.ui.choose = async available => { expect(available).toBe(true); return "radius"; };
  f.ui.preview = async value => {
    reviewed = value.text;
    const rows = reviewed.trim().split("\n").map(line => JSON.parse(line));
    expect(rows[1].parentId).toBeNull(); expect(rows[2].customType).toBe("pi.share");
    expect(rows[2].data.systemPrompt).toBe("synthetic-system");
    expect(rows[2].data.tools[0].name).toBe("test");
  };
  f.transport.fetch = vi.fn(async (_url, options) => {
    expect(options?.body).toBe(reviewed); expect(options?.redirect).toBe("error");
    expect(options?.headers).toMatchObject({ Authorization: "Bearer synthetic-radius-token" });
    expect(String(_url)).toContain("visibility=organization");
    return new Response(JSON.stringify({ artifact: { canonical_url: "https://example.test/artifact/one" } }));
  });
  expect(await shareSession(f.session, f.signal.signal, f.ui, f.transport)).toBe("Radius: https://example.test/artifact/one");
  expect(f.transport.gh).not.toHaveBeenCalled();
  f.transport.fetch = vi.fn(async () => { throw new Error("synthetic-radius-token"); });
  await expect(shareSession(f.session, f.signal.signal, f.ui, f.transport)).rejects.toThrow("远端可能已创建内容");
  expect(f.transport.fetch).toHaveBeenCalledTimes(1); expect(f.transport.gh).not.toHaveBeenCalled();
});
