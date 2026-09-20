import { afterEach, describe, expect, it } from "vitest";
import {
  MobileApiError,
  PiRemoteApi,
  type DeviceCredentials,
  type FetchLike
} from "../../apps/mobile/src/api/client";

const credentials: DeviceCredentials = {
  baseUrl: "https://pi.example.test/remote",
  deviceId: "device-a",
  deviceToken: "device-secret",
  user: { id: "owner-a", displayName: "Owner A" }
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status
  });
}

function projectSummary(id = "project-a") {
  return {
    id,
    name: "Project A",
    version: 1,
    lastActivityAt: null,
    runningCount: 0,
    waitingInputCount: 0,
    blockedReason: null
  };
}

describe("S09 mobile API client", () => {
  it("validates recovery candidates and preserves the import key across explicit retries", async () => {
    const candidateId = "a".repeat(64);
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const api = new PiRemoteApi(credentials, { fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith("recoverable-history")) return jsonResponse({ items: [{ candidateId, filename: "orphan.jsonl", title: "Recovered", modifiedAt: new Date().toISOString(), entryCount: 0 }] });
      return jsonResponse({ error: { code: "NOT_FOUND", message: "Refresh candidates", requestId: "recovery-test" } }, 404);
    } });
    expect((await api.listRecoverableHistory("project-a")).items[0]?.candidateId).toBe(candidateId);
    for (let retry = 0; retry < 2; retry++) await expect(api.importHistory("project-a", candidateId, "recovery-key")).rejects.toMatchObject({ code: "NOT_FOUND" });
    const imports = calls.filter(call => call.url.endsWith("history-imports"));
    expect(imports).toHaveLength(2);
    for (const call of imports) {
      expect(new Headers(call.init?.headers).get("idempotency-key")).toBe("recovery-key");
      expect(JSON.parse(String(call.init?.body))).toEqual({ candidateId });
    }
    await expect(api.importHistory("project-a", "../../auth.json")).rejects.toThrow();
    expect(calls).toHaveLength(3);
  });
  const clients: Array<{ calls: Array<{ input: string; init?: RequestInit }> }> = [];

  afterEach(() => {
    clients.length = 0;
  });

  it("consumes custom model discovery and refreshes advertised thinking capabilities", async () => {
    let levels = ["off", "high"];
    const api = new PiRemoteApi(credentials, { fetchImpl: async (url) => {
      expect(url).toBe("https://pi.example.test/remote/v1/models?sessionId=session-a&refresh=true");
      return jsonResponse({ items: [{ model: { provider: "custom", id: "local-model" }, name: "Custom model", thinkingLevels: levels, contextWindow: 32768 }] });
    } });
    expect((await api.getModels("session-a", true)).items[0]).toMatchObject({ model: { provider: "custom", id: "local-model" }, thinkingLevels: ["off", "high"], contextWindow: 32768 });
    levels = ["off"];
    expect((await api.getModels("session-a", true)).items[0]?.thinkingLevels).toEqual(["off"]);
  });

  it("requires HTTPS and normalizes a server base path", () => {
    expect(new PiRemoteApi("  https://pi.example.test/remote///  ").serverUrl)
      .toBe("https://pi.example.test/remote");
    for (const value of [
      "http://pi.example.test",
      "https://pi.example.test?token=secret",
      "https://user:password@pi.example.test",
      "https://pi.example.test/#fragment",
      "not a url"
    ]) {
      expect(() => new PiRemoteApi(value)).toThrowError(MobileApiError);
      expect(() => new PiRemoteApi(value)).toThrow(/HTTPS|有效的 URL|不能包含/);
    }
  });

  it("sends pairing without a bearer token and validates the response", async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    const fetchImpl: FetchLike = async (input, init) => {
      calls.push({ input, init });
      return jsonResponse({
        deviceId: "device-b",
        deviceToken: "new-secret",
        user: { id: "owner-a", displayName: "Owner A" }
      }, 201);
    };
    const api = new PiRemoteApi("https://pi.example.test", { fetchImpl });

    await expect(api.pair("one-time-token", "Phone")).resolves.toMatchObject({
      baseUrl: "https://pi.example.test",
      deviceId: "device-b"
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe("https://pi.example.test/v1/pair");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.headers).toEqual({ Accept: "application/json", "Content-Type": "application/json" });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      pairingToken: "one-time-token",
      deviceName: "Phone"
    });
  });

  it("uses protocol DTOs, encoded cursors, bearer auth, and idempotency keys", async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    const fetchImpl: FetchLike = async (input, init) => {
      calls.push({ input, init });
      if (input.includes("/projects/project%2Fone/sessions")) {
        return jsonResponse({ items: [], nextCursor: null });
      }
      if (new URL(input).pathname === "/remote/v1/projects" && init?.method === "GET") {
        return jsonResponse({ items: [projectSummary()], nextCursor: "cursor-2" });
      }
      return jsonResponse({
        project: {
          ...projectSummary(),
          rootPath: "/workspaces/project-a",
          workspaceKey: "workspace-a",
          rootIdentity: "identity-a",
          gitCommonDir: null,
          defaultModel: null,
          defaultThinkingLevel: null
        },
        commandId: "command-a"
      }, 201);
    };
    const api = new PiRemoteApi(credentials, { fetchImpl });

    await expect(api.listProjects("cursor/one", 25)).resolves.toMatchObject({ nextCursor: "cursor-2" });
    await expect(api.listSessions("project/one", "all", "cursor/two", 7)).resolves.toEqual({ items: [], nextCursor: null });
    await api.createProject({ name: "Project A", rootPath: "/workspaces/project-a" }, "fixed-idempotency-key");

    expect(calls[0]?.input).toBe("https://pi.example.test/remote/v1/projects?cursor=cursor%2Fone&limit=25");
    expect(calls[1]?.input).toBe("https://pi.example.test/remote/v1/projects/project%2Fone/sessions?archived=all&cursor=cursor%2Ftwo&limit=7");
    expect(calls[2]?.init?.headers).toEqual({
      Accept: "application/json",
      Authorization: "Bearer device-secret",
      "Content-Type": "application/json",
      "Idempotency-Key": "fixed-idempotency-key"
    });
  });

  it("maps server, schema, and network failures without hiding retryability", async () => {
    const errorResponse = jsonResponse({
      error: {
        code: "VERSION_CONFLICT",
        message: "版本已变化",
        requestId: "request-a",
        details: { currentVersion: 2 }
      }
    }, 409);
    const conflictApi = new PiRemoteApi(credentials, {
      fetchImpl: async () => errorResponse
    });
    await expect(conflictApi.getMe()).rejects.toMatchObject({
      code: "VERSION_CONFLICT",
      status: 409,
      details: { currentVersion: 2 },
      retryable: false
    });

    const revokedApi = new PiRemoteApi(credentials, {
      fetchImpl: async () => jsonResponse({ error: { code: "DEVICE_REVOKED", message: "设备已吊销", requestId: "request-b" } }, 401)
    });
    await expect(revokedApi.getMe()).rejects.toMatchObject({ code: "DEVICE_REVOKED", status: 401 });

    const invalidApi = new PiRemoteApi(credentials, {
      fetchImpl: async () => new Response("not-json", { status: 200 })
    });
    await expect(invalidApi.getMe()).rejects.toMatchObject({ code: "INVALID_RESPONSE", status: 200 });

    const offlineApi = new PiRemoteApi(credentials, {
      fetchImpl: async () => { throw new Error("offline"); }
    });
    await expect(offlineApi.getMe()).rejects.toMatchObject({ code: "NETWORK_UNAVAILABLE", retryable: true });
  });

  it("retries a lost command response with the original idempotency key", async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    let attempt = 0;
    const api = new PiRemoteApi(credentials, {
      fetchImpl: async (input, init) => {
        calls.push({ input, init });
        attempt += 1;
        if (attempt === 1) throw new Error("response lost after server accepted the command");
        return jsonResponse({ commandId: "command-a", state: "queued", runId: "run-a" }, 202);
      }
    });

    await expect(api.submitCommandWithRetry(
      "session-a",
      { kind: "prompt", payload: { text: "继续" } },
      "fixed-command-key"
    )).resolves.toEqual({ commandId: "command-a", state: "queued", runId: "run-a" });
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.init?.headers)).toEqual([
      {
        Accept: "application/json",
        Authorization: "Bearer device-secret",
        "Content-Type": "application/json",
        "Idempotency-Key": "fixed-command-key"
      },
      {
        Accept: "application/json",
        Authorization: "Bearer device-secret",
        "Content-Type": "application/json",
        "Idempotency-Key": "fixed-command-key"
      }
    ]);
  });

  it("uploads a binary artifact with bearer auth and validates the response DTO", async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    const api = new PiRemoteApi(credentials, {
      fetchImpl: async (input, init) => {
        calls.push({ input, init });
        return jsonResponse({
          id: "artifact-a",
          sessionId: "session-a",
          mimeType: "image/png",
          byteLength: 5,
          sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          createdAt: "2026-09-17T00:00:00.000Z"
        }, 201);
      }
    });
    const body = new Blob(["hello"], { type: "image/png" });
    await expect(api.uploadArtifact("session-a", { body, mimeType: "image/png" }, "artifact-key"))
      .resolves.toMatchObject({ id: "artifact-a", sessionId: "session-a", byteLength: 5 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe("https://pi.example.test/remote/v1/sessions/session-a/artifacts");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.headers).toEqual({
      Accept: "application/json",
      Authorization: "Bearer device-secret",
      "Content-Type": "image/png",
      "Idempotency-Key": "artifact-key"
    });
    expect(calls[0]?.init?.body).toBe(body);
  });
});
