import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { DEFAULT_RADIUS_GATEWAY } from "@earendil-works/pi-ai/providers/radius-config";

const sdk = import.meta.resolve("@earendil-works/pi-coding-agent");
const native = await import(new URL("./modes/interactive/session-share.js", sdk).href) as {
  exportSessionForShare(path: string, session: AgentSession): void;
};
const auth = await import(new URL("./cli/auth-command.js", sdk).href) as {
  getAuthCredential(value: Awaited<ReturnType<AgentSession["modelRuntime"]["getAuth"]>>): string | undefined;
};
const config = await import(new URL("./config.js", sdk).href) as { getShareViewerUrl(id: string): string };

export type ShareTarget = "gist" | "radius";
export interface SharePreview { target: ShareTarget; text: string; bytes: number; sha256: string }
export interface ShareUi {
  choose(hasRadius: boolean): Promise<ShareTarget | undefined>;
  preview(value: SharePreview): Promise<void>;
  confirm(value: SharePreview): Promise<boolean>;
}
export interface ShareTransport {
  gh(args: string[], signal: AbortSignal, input?: string): Promise<{ code: number; stdout: string }>;
  fetch: typeof fetch;
}

// Never interpolate shell arguments or include gh stderr (which can contain credentials).
export const shareTransport: ShareTransport = {
  gh: (args, signal, input) => new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const child = spawn("gh", args, { signal, env: { ...process.env, GH_HOST: "github.com" }, stdio: ["pipe", "pipe", "ignore"] });
    let stdout = "", overflow = false;
    child.stdout.on("data", chunk => {
      if (stdout.length + chunk.length > 65536) { overflow = true; child.kill(); }
      else stdout += chunk.toString();
    });
    child.stdin.on("error", () => { /* exit code is authoritative */ });
    child.on("error", () => reject(new Error("GitHub CLI 不可用或操作已取消")));
    child.on("close", code => overflow ? reject(new Error("GitHub CLI 响应过大")) : resolve({ code: code ?? -1, stdout }));
    child.stdin.end(input);
  }),
  fetch: (...args) => fetch(...args)
};

function webUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 4096) throw new Error("Invalid share URL");
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid share URL");
  return url.href;
}

/** Freeze once, preview those exact bytes, and publish only after an explicit confirmation. */
export async function shareSession(session: AgentSession, signal: AbortSignal, ui: ShareUi,
  transport: ShareTransport = shareTransport): Promise<string | undefined> {
  signal.throwIfAborted();
  const target = await ui.choose(!!session.modelRuntime.getProvider("radius"));
  if (!target || signal.aborted) return;
  let token: string | undefined;
  try {
    if (target === "gist") {
      if ((await transport.gh(["auth", "status", "--hostname", "github.com"], signal)).code !== 0)
        throw new Error("not authenticated");
    } else {
      token = auth.getAuthCredential(await session.modelRuntime.getAuth("radius", { minOAuthValidityMs: 5 * 60_000 }));
      if (!token) throw new Error("not authenticated");
    }
  } catch {
    if (signal.aborted) return;
    throw new Error(target === "gist" ? "GitHub CLI 未就绪；请在服务端安装 gh 并通过 gh auth login 登录 github.com" : "Radius 未登录或凭据不可用；请先登录 Radius");
  }
  signal.throwIfAborted();
  const dir = await mkdtemp(join(tmpdir(), "pi-remote-share-"));
  let text: string;
  try {
    const path = join(dir, target === "gist" ? "session.html" : "session.jsonl");
    if (target === "gist") await session.exportToHtml(path, { themeName: "dark" });
    else native.exportSessionForShare(path, session);
    text = await readFile(path, "utf8");
  } finally { await rm(dir, { recursive: true, force: true }); }
  const value: SharePreview = { target, text, bytes: Buffer.byteLength(text), sha256: createHash("sha256").update(text).digest("hex") };
  signal.throwIfAborted();
  await ui.preview({ ...value });
  if (signal.aborted || !await ui.confirm({ ...value }) || signal.aborted) return;
  // No retries or fallback after dispatch: a lost reply may still mean publication succeeded.
  try {
    if (target === "gist") {
      const result = await transport.gh(["gist", "create", "--public=false", "--filename", "session.html", "-"], signal, text);
      if (result.code !== 0) throw new Error("Upload failed");
      const url = new URL(webUrl(result.stdout.trim()));
      if (url.hostname !== "gist.github.com" || !/^\/[^/]+\/[a-f0-9]+\/?$/i.test(url.pathname)) throw new Error("Invalid gist URL");
      const id = url.pathname.split("/").filter(Boolean).at(-1)!;
      // A broken optional viewer configuration must not erase a known publication result.
      let viewer: string | undefined;
      try { viewer = webUrl(config.getShareViewerUrl(id)); } catch { /* Gist itself remains usable. */ }
      return `Gist: ${url.href}${viewer ? `\n查看: ${viewer}` : "\n查看器地址配置无效，请使用 Gist 链接"}`;
    }
    const url = new URL("/v1/artifacts", DEFAULT_RADIUS_GATEWAY);
    url.searchParams.set("visibility", "organization"); url.searchParams.set("title", "Pi session");
    const response = await transport.fetch(url, { method: "POST", headers: {
      Authorization: `Bearer ${token}`, "Content-Type": "application/x-ndjson", "Content-Length": String(value.bytes)
    }, body: text, signal, redirect: "error" });
    if (!response.ok) throw new Error("Upload failed");
    const result = await response.json() as { artifact?: { canonical_url?: string } };
    return `Radius: ${webUrl(result.artifact?.canonical_url)}`;
  } catch {
    throw new Error("分享上传未确认完成，远端可能已创建内容；请先检查目标账号，系统不会自动重试或切换上传目标");
  }
}
