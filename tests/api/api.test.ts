import { mkdtemp, mkdir, rm, symlink, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../../apps/server/src/index.js";
import { AuthService } from "../../apps/server/src/auth.js";
import { parseEnv } from "../../apps/server/src/config.js";
import { DeviceRepository, OwnerRepository, ProjectRepository, SessionRepository, openServerDatabase } from "../../apps/server/src/storage/index.js";
import { WorkerManager } from "../../apps/server/src/runtime/manager.js";
import type { DatabaseSync } from "node:sqlite";

interface Fixture {
  root: string;
  workspace: string;
  database: DatabaseSync;
  app: ReturnType<typeof buildServer>;
  deviceToken: string;
  deviceId: string;
}

const fixtures: Fixture[] = [];

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "pi-remote-s05-"));
  const workspace = join(root, "workspaces");
  await mkdir(workspace, { recursive: true });
  const database = await openServerDatabase({ filename: join(root, "state", "state.sqlite") });
  const env = parseEnv({
    PI_REMOTE_HOST: "127.0.0.1",
    PI_REMOTE_PORT: "0",
    PI_REMOTE_STATE_DIR: join(root, "state"),
    PI_REMOTE_PI_DIR: join(root, "pi"),
    PI_REMOTE_WORKSPACE_ROOT: workspace,
    PI_REMOTE_OWNER_ID: "owner-a",
    PI_REMOTE_OWNER_NAME: "Owner A",
    PI_REMOTE_PAIRING_TTL_SECONDS: "600",
    PI_REMOTE_CURSOR_SECRET: "s05-test-cursor-secret",
    PI_REMOTE_LIVE_TESTS: "0"
  });
  const app = buildServer({ env, database });
  const auth = new AuthService(database);
  const pairing = auth.createPairingToken("owner-a", 600);
  const pair = await app.inject({
    method: "POST",
    url: "/v1/pair",
    payload: { pairingToken: pairing.token, deviceName: "Test phone" }
  });
  expect(pair.statusCode).toBe(201);
  const pairBody = JSON.parse(pair.body) as { deviceId: string; deviceToken: string };
  const fixture = {
    root,
    workspace,
    database,
    app,
    deviceToken: pairBody.deviceToken,
    deviceId: pairBody.deviceId
  };
  fixtures.push(fixture);
  return fixture;
}

function authHeader(token: string): { authorization: string } {
  return { authorization: "Bearer " + token };
}

function idempotencyHeader(key: string): { "idempotency-key": string } {
  return { "idempotency-key": key };
}

function json(response: { body: string }): Record<string, unknown> {
  return JSON.parse(response.body) as Record<string, unknown>;
}

afterEach(async () => {
  while (fixtures.length > 0) {
    const fixture = fixtures.pop();
    if (!fixture) continue;
    await fixture.app.close();
    fixture.database.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

describe("S05 device, project, and Session API", () => {
  it("discovers only valid unmapped project histories and imports idempotently without opening the SDK", async () => {
    const f = await createFixture();
    const project = new ProjectRepository(f.database).create({ userId: "owner-a", name: "Recovery", rootPath: f.workspace, workspaceKey: "recovery", rootIdentity: "recovery" });
    const root = join(f.root, "pi/sessions");
    await mkdir(root, { recursive: true });
    const header = (id: string, cwd = f.workspace) => JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd }) + "\n";
    const original = header("orphan-native");
    await writeFile(join(root, "orphan.jsonl"), original);
    await writeFile(join(root, "broken.jsonl"), "broken");
    await writeFile(join(root, "empty.jsonl"), "");
    await writeFile(join(root, "foreign.jsonl"), header("foreign", f.root));
    await writeFile(join(root, "duplicate-a.jsonl"), header("duplicate"));
    await writeFile(join(root, "duplicate-b.jsonl"), header("duplicate"));
    await writeFile(join(root, "mapped.jsonl"), header("mapped"));
    new SessionRepository(f.database).create({ projectId: project.id, title: "Mapped", piSessionId: "mapped", piSessionFile: join(root, "mapped.jsonl"), piPersistenceState: "persisted" });
    await writeFile(join(f.root, "outside.jsonl"), header("outside"));
    await symlink(join(f.root, "outside.jsonl"), join(root, "linked.jsonl"));
    const url = `/v1/projects/${project.id}/recoverable-history`;
    expect((await f.app.inject({ method: "GET", url })).statusCode).toBe(401);
    const listed = await f.app.inject({ method: "GET", url, headers: authHeader(f.deviceToken) });
    expect(listed.statusCode).toBe(200);
    const items = listed.json().items as Array<{ candidateId: string; filename: string; entryCount: number }>;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ filename: "orphan.jsonl", entryCount: 0 });
    const importUrl = `/v1/projects/${project.id}/history-imports`;
    const request = { method: "POST" as const, url: importUrl, headers: { ...authHeader(f.deviceToken), ...idempotencyHeader("11000000-0000-4000-8000-000000000001") }, payload: { candidateId: items[0]!.candidateId } };
    const replacing = vi.spyOn(WorkerManager.prototype, "hasPendingNativeReplacement").mockReturnValue(true);
    try {
      expect((await f.app.inject(request)).statusCode).toBe(409);
      expect(f.database.prepare("SELECT COUNT(*) AS count FROM sessions").get()?.count).toBe(1);
    } finally { replacing.mockRestore(); }
    const first = await f.app.inject(request);
    expect(first.statusCode).toBe(201);
    expect(first.json().session.piPersistenceState).toBe("persisted");
    expect((await f.app.inject(request)).json()).toEqual(first.json());
    const duplicate = await f.app.inject({ ...request, headers: { ...authHeader(f.deviceToken), ...idempotencyHeader("11000000-0000-4000-8000-000000000002") } });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json().session.id).toBe(first.json().session.id);
    expect((await f.app.inject({ method: "GET", url, headers: authHeader(f.deviceToken) })).json().items).toEqual([]);
    expect(await readFile(join(root, "orphan.jsonl"), "utf8")).toBe(original);
    expect(f.database.prepare("SELECT COUNT(*) AS count FROM runs").get()?.count).toBe(0);
    expect((await f.app.inject({ ...request, payload: { candidateId: "../../outside.jsonl" } })).statusCode).toBe(400);
  });

  it("revalidates deleted/corrupt candidates and rejects histories belonging to another owner", async () => {
    const f = await createFixture();
    const projects = new ProjectRepository(f.database);
    const project = projects.create({ userId: "owner-a", name: "Recovery", rootPath: f.workspace, workspaceKey: "recover2", rootIdentity: "recover2" });
    const root = join(f.root, "pi/sessions");
    await mkdir(root, { recursive: true });
    const path = join(root, "changed.jsonl");
    await writeFile(path, JSON.stringify({ type: "session", version: 3, id: "changed", timestamp: new Date().toISOString(), cwd: f.workspace }) + "\n");
    const list = await f.app.inject({ method: "GET", url: `/v1/projects/${project.id}/recoverable-history`, headers: authHeader(f.deviceToken) });
    const candidateId = list.json().items[0].candidateId as string;
    await writeFile(path, "corrupted after listing");
    const imported = await f.app.inject({ method: "POST", url: `/v1/projects/${project.id}/history-imports`, headers: { ...authHeader(f.deviceToken), ...idempotencyHeader("11000000-0000-4000-8000-000000000003") }, payload: { candidateId } });
    expect(imported.statusCode).toBe(404);
    expect(await readFile(path, "utf8")).toBe("corrupted after listing");
    await rm(path);
    expect((await f.app.inject({ method: "POST", url: `/v1/projects/${project.id}/history-imports`, headers: { ...authHeader(f.deviceToken), ...idempotencyHeader("11000000-0000-4000-8000-000000000003") }, payload: { candidateId } })).statusCode).toBe(404);
    new OwnerRepository(f.database).ensure({ id: "owner-b", displayName: "Other" });
    const other = projects.create({ userId: "owner-b", name: "Other", rootPath: f.root, workspaceKey: "other", rootIdentity: "other" });
    expect((await f.app.inject({ method: "GET", url: `/v1/projects/${other.id}/recoverable-history`, headers: authHeader(f.deviceToken) })).statusCode).toBe(404);
    expect(f.database.prepare("SELECT COUNT(*) AS count FROM sessions").get()?.count).toBe(0);
  });
  it("authenticates editor handoff and returns 204 only after the worker ACK", async () => {
    const fixture = await createFixture();
    const project = new ProjectRepository(fixture.database).create({ userId: "owner-a", name: "Editor", rootPath: fixture.workspace, workspaceKey: "editor-workspace", rootIdentity: "editor-root" });
    const session = new SessionRepository(fixture.database).create({ projectId: project.id, title: "Editor" });
    let acknowledge: (() => void) | undefined;
    const ack = new Promise<void>((resolve) => { acknowledge = resolve; });
    const setter = vi.spyOn(WorkerManager.prototype, "setEditorState").mockImplementation(() => ack);
    try {
      const unauthenticated = await fixture.app.inject({ method: "POST", url: `/v1/sessions/${session.id}/editor-state`, payload: { text: "draft" } });
      expect(unauthenticated.statusCode).toBe(401);
      expect(setter).not.toHaveBeenCalled();
      let completed = false;
      const request = fixture.app.inject({ method: "POST", url: `/v1/sessions/${session.id}/editor-state`, headers: authHeader(fixture.deviceToken), payload: { text: "draft" } }).then((response) => { completed = true; return response; });
      await vi.waitFor(() => expect(setter).toHaveBeenCalledWith(session.id, "draft"));
      expect(completed).toBe(false);
      acknowledge!();
      expect((await request).statusCode).toBe(204);
      const missing = await fixture.app.inject({ method: "POST", url: "/v1/sessions/missing/editor-state", headers: authHeader(fixture.deviceToken), payload: { text: "draft" } });
      expect(missing.statusCode).toBe(404);
      expect(setter).toHaveBeenCalledTimes(1);
    } finally { setter.mockRestore(); }
  });

  it("lists configured SDK models before any Session exists and refreshes custom definitions", async () => {
    const fixture = await createFixture();
    const agentDir = join(fixture.root, "pi");
    await mkdir(agentDir, { recursive: true });
    const config = (reasoning: boolean) => ({ providers: { "synthetic-review": { baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", apiKey: "synthetic-test-key", models: [{ id: "custom-review", name: "Review custom model", reasoning, input: ["text"], contextWindow: 32768, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } });
    await writeFile(join(agentDir, "models.json"), JSON.stringify(config(false)));
    const first = await fixture.app.inject({ method: "GET", url: "/v1/models", headers: authHeader(fixture.deviceToken) });
    expect(first.statusCode).toBe(200);
    const item = (json(first).items as Array<{ model: { provider: string }; thinkingLevels: string[]; contextWindow: number }>).find((model) => model.model.provider === "synthetic-review");
    expect(item).toMatchObject({ thinkingLevels: ["off"], contextWindow: 32768 });
    await writeFile(join(agentDir, "models.json"), JSON.stringify(config(true)));
    const refreshed = await fixture.app.inject({ method: "GET", url: "/v1/models?refresh=true", headers: authHeader(fixture.deviceToken) });
    expect(refreshed.statusCode).toBe(200);
    const reasoning = (json(refreshed).items as Array<{ model: { provider: string }; thinkingLevels: string[] }>).find((model) => model.model.provider === "synthetic-review");
    expect(reasoning?.thinkingLevels).toContain("high");
    expect(fixture.database.prepare("SELECT COUNT(*) AS n FROM sessions").get()?.n).toBe(0);
  });

  it("atomically consumes pairing tokens and rejects revoked credentials", async () => {
    const fixture = await createFixture();
    const pairing = new AuthService(fixture.database).createPairingToken("owner-a", 600);
    const pairResponses = await Promise.all([
      fixture.app.inject({
        method: "POST",
        url: "/v1/pair",
        payload: { pairingToken: pairing.token, deviceName: "Phone one" }
      }),
      fixture.app.inject({
        method: "POST",
        url: "/v1/pair",
        payload: { pairingToken: pairing.token, deviceName: "Phone two" }
      })
    ]);
    expect(pairResponses.map((response) => response.statusCode).sort()).toEqual([201, 401]);

    const me = await fixture.app.inject({ method: "GET", url: "/v1/me", headers: authHeader(fixture.deviceToken) });
    expect(me.statusCode).toBe(200);
    expect(json(me).user).toEqual({ id: "owner-a", displayName: "Owner A" });
    const devices = await fixture.app.inject({ method: "GET", url: "/v1/devices", headers: authHeader(fixture.deviceToken) });
    expect(devices.statusCode).toBe(200);
    expect((json(devices).items as unknown[]).length).toBe(2);

    const second = pairResponses.find((response) => response.statusCode === 201);
    if (!second) throw new Error("successful concurrent pairing response is missing");
    const secondBody = json(second) as { deviceId: string; deviceToken: string };
    const revokeKey = "8f7d9e7c-99a8-47e1-9c57-d0a99c6dbf77";
    const revoked = await fixture.app.inject({
      method: "DELETE",
      url: "/v1/devices/" + secondBody.deviceId,
      headers: { ...authHeader(fixture.deviceToken), ...idempotencyHeader(revokeKey) }
    });
    expect(revoked.statusCode).toBe(200);
    expect(json(revoked).id).toBe(secondBody.deviceId);
    const revokedMe = await fixture.app.inject({
      method: "GET",
      url: "/v1/me",
      headers: authHeader(secondBody.deviceToken)
    });
    expect(revokedMe.statusCode).toBe(401);
    expect(json(revokedMe).error).toMatchObject({ code: "DEVICE_REVOKED" });
  });

  it("registers real paths, paginates resources, applies CAS metadata, and survives reopen", async () => {
    const fixture = await createFixture();
    const outside = join(fixture.root, "outside");
    const escape = join(fixture.workspace, "escape");
    await mkdir(outside);
    // Windows requires the junction form unless developer mode is enabled;
    // it is still a realpath escape and exercises the same boundary check.
    await symlink(outside, escape, process.platform === "win32" ? "junction" : "dir");

    const invalid = await fixture.app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { ...authHeader(fixture.deviceToken), ...idempotencyHeader("6f9258ad-5719-40cc-93e2-0a31cecc1c15") },
      payload: { name: "escape", rootPath: escape }
    });
    expect(invalid.statusCode).toBe(422);
    expect(json(invalid).error).toMatchObject({ code: "INVALID_PROJECT_PATH" });

    const parentKey = "12eac7ee-51aa-4a67-a85e-c9fd1b6a1b5e";
    const parentResponses = await Promise.all([
      fixture.app.inject({
        method: "POST",
        url: "/v1/projects",
        headers: { ...authHeader(fixture.deviceToken), ...idempotencyHeader(parentKey) },
        payload: { name: "workspace", rootPath: fixture.workspace }
      }),
      fixture.app.inject({
        method: "POST",
        url: "/v1/projects",
        headers: { ...authHeader(fixture.deviceToken), ...idempotencyHeader(parentKey) },
        payload: { name: "workspace", rootPath: fixture.workspace }
      })
    ]);
    expect(parentResponses.map((response) => response.statusCode)).toEqual([201, 201]);
    expect(parentResponses[0]?.body).toBe(parentResponses[1]?.body);
    const parent = json(parentResponses[0]!) as { project: { id: string; version: number }; commandId: string };

    const duplicate = await fixture.app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { ...authHeader(fixture.deviceToken), ...idempotencyHeader("e4b7f802-43d9-4749-b3d7-c52f7ce79f5d") },
      payload: { name: "different label", rootPath: fixture.workspace }
    });
    expect(duplicate.statusCode).toBe(200);
    expect((json(duplicate).project as { name: string }).name).toBe("workspace");

    const child = join(fixture.workspace, "child");
    const secondRoot = join(fixture.workspace, "second");
    await mkdir(child);
    await mkdir(secondRoot);
    const childResponse = await fixture.app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { ...authHeader(fixture.deviceToken), ...idempotencyHeader("1dbfc9ff-7a67-46e9-9b93-fb06bd6dc44f") },
      payload: { name: "child", rootPath: child }
    });
    expect(childResponse.statusCode).toBe(201);
    const secondResponse = await fixture.app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { ...authHeader(fixture.deviceToken), ...idempotencyHeader("9e3e1aa5-c16b-4402-bab3-8842e5d56b0f") },
      payload: { name: "second", rootPath: secondRoot }
    });
    expect(secondResponse.statusCode).toBe(201);

    const page = await fixture.app.inject({
      method: "GET",
      url: "/v1/projects?limit=1",
      headers: authHeader(fixture.deviceToken)
    });
    expect(page.statusCode).toBe(200);
    const pageBody = json(page) as { items: unknown[]; nextCursor: string | null };
    expect(pageBody.items).toHaveLength(1);
    expect(pageBody.nextCursor).toBeTypeOf("string");
    const nextPage = await fixture.app.inject({
      method: "GET",
      url: "/v1/projects?limit=5&cursor=" + encodeURIComponent(pageBody.nextCursor!),
      headers: authHeader(fixture.deviceToken)
    });
    expect(nextPage.statusCode).toBe(200);
    expect((json(nextPage).items as unknown[]).length).toBe(2);

    const patchKey = "d5e991bb-42f2-43de-b9f2-41e2cfe5d4f0";
    const patched = await fixture.app.inject({
      method: "PATCH",
      url: "/v1/projects/" + parent.project.id,
      headers: { ...authHeader(fixture.deviceToken), ...idempotencyHeader(patchKey) },
      payload: { expectedVersion: 1, name: "renamed workspace" }
    });
    expect(patched.statusCode).toBe(200);
    expect((json(patched).project as { version: number; name: string })).toMatchObject({ version: 2, name: "renamed workspace" });
    const conflict = await fixture.app.inject({
      method: "PATCH",
      url: "/v1/projects/" + parent.project.id,
      headers: { ...authHeader(fixture.deviceToken), ...idempotencyHeader("991bc89d-70ef-4ed2-8963-9c7a597f6d5f") },
      payload: { expectedVersion: 1, name: "stale" }
    });
    expect(conflict.statusCode).toBe(409);
    expect(json(conflict).error).toMatchObject({ code: "VERSION_CONFLICT", details: { currentVersion: 2 } });

    const sessionResponse = await fixture.app.inject({
      method: "POST",
      url: "/v1/projects/" + parent.project.id + "/sessions",
      headers: { ...authHeader(fixture.deviceToken), ...idempotencyHeader("8a61717b-ddd5-4ce0-99e0-b28c48f0cbdd") },
      payload: {}
    });
    expect(sessionResponse.statusCode).toBe(201);
    const session = json(sessionResponse).session as { id: string; version: number; title: string };
    expect(session).toMatchObject({ version: 1, title: "新会话" });
    const sessionList = await fixture.app.inject({
      method: "GET",
      url: "/v1/projects/" + parent.project.id + "/sessions",
      headers: authHeader(fixture.deviceToken)
    });
    expect((json(sessionList).items as unknown[])).toHaveLength(1);

    const archiveKey = "e0f9ac15-5be9-4f6f-8535-8a840b0e5b61";
    const archived = await fixture.app.inject({
      method: "PATCH",
      url: "/v1/sessions/" + session.id,
      headers: { ...authHeader(fixture.deviceToken), ...idempotencyHeader(archiveKey) },
      payload: { expectedVersion: 1, archived: true }
    });
    expect(archived.statusCode).toBe(200);
    expect((json(archived).session as { version: number; archivedAt: string | null }).version).toBe(2);
    const excluded = await fixture.app.inject({
      method: "GET",
      url: "/v1/projects/" + parent.project.id + "/sessions",
      headers: authHeader(fixture.deviceToken)
    });
    expect((json(excluded).items as unknown[])).toHaveLength(0);
    const included = await fixture.app.inject({
      method: "GET",
      url: "/v1/projects/" + parent.project.id + "/sessions?archived=only",
      headers: authHeader(fixture.deviceToken)
    });
    expect((json(included).items as unknown[])).toHaveLength(1);

    const snapshot = await fixture.app.inject({
      method: "GET",
      url: "/v1/sessions/" + session.id + "/snapshot",
      headers: authHeader(fixture.deviceToken)
    });
    expect(snapshot.statusCode).toBe(200);
    expect(json(snapshot)).toMatchObject({ snapshotSeq: 1, session: { version: 2, archivedAt: expect.any(String) } });
    const events = await fixture.app.inject({
      method: "GET",
      url: "/v1/sessions/" + session.id + "/events?afterSeq=0",
      headers: authHeader(fixture.deviceToken)
    });
    expect(events.statusCode).toBe(200);
    expect((json(events).events as unknown[])).toHaveLength(1);
    const command = await fixture.app.inject({
      method: "GET",
      url: "/v1/commands/" + (json(archived).commandId as string),
      headers: authHeader(fixture.deviceToken)
    });
    expect(command.statusCode).toBe(200);
    expect(json(command)).toMatchObject({ kind: "session_patch", state: "completed", runs: [] });

    await fixture.app.close();
    fixture.database.close();
    const reopened = await openServerDatabase({ filename: join(fixture.root, "state", "state.sqlite") });
    fixture.database = reopened;
    fixture.app = buildServer({
      env: parseEnv({
        PI_REMOTE_HOST: "127.0.0.1",
        PI_REMOTE_PORT: "0",
        PI_REMOTE_STATE_DIR: join(fixture.root, "state"),
        PI_REMOTE_PI_DIR: join(fixture.root, "pi"),
        PI_REMOTE_WORKSPACE_ROOT: fixture.workspace,
        PI_REMOTE_OWNER_ID: "owner-a",
        PI_REMOTE_OWNER_NAME: "Owner A",
        PI_REMOTE_PAIRING_TTL_SECONDS: "600",
        PI_REMOTE_CURSOR_SECRET: "s05-test-cursor-secret",
        PI_REMOTE_LIVE_TESTS: "0"
      }),
      database: reopened
    });
    const afterRestart = await fixture.app.inject({
      method: "GET",
      url: "/v1/projects/" + parent.project.id + "/sessions?archived=all",
      headers: authHeader(fixture.deviceToken)
    });
    expect(afterRestart.statusCode).toBe(200);
    expect((json(afterRestart).items as unknown[])).toHaveLength(1);
  });

  it("does not expose another owner's project or path identity", async () => {
    const fixture = await createFixture();
    const otherToken = "owner-b-device-token";
    new OwnerRepository(fixture.database).ensure({ id: "owner-b", displayName: "Owner B" });
    const otherDevice = new DeviceRepository(fixture.database).create({
      id: "device-b",
      userId: "owner-b",
      name: "Other phone",
      token: otherToken
    });
    const projectResponse = await fixture.app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { ...authHeader(fixture.deviceToken), ...idempotencyHeader("2d2ae5a4-a690-48e5-825a-f1b2de2a4f4b") },
      payload: { name: "private", rootPath: fixture.workspace }
    });
    const projectId = (json(projectResponse).project as { id: string }).id;

    const hidden = await fixture.app.inject({
      method: "GET",
      url: "/v1/projects/" + projectId,
      headers: authHeader(otherToken)
    });
    expect(hidden.statusCode).toBe(404);
    const hiddenSessions = await fixture.app.inject({
      method: "GET",
      url: "/v1/projects/" + projectId + "/sessions",
      headers: authHeader(otherToken)
    });
    expect(hiddenSessions.statusCode).toBe(404);
    const duplicate = await fixture.app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { ...authHeader(otherToken), ...idempotencyHeader("d21567b2-496e-4555-aecb-7984887960c8") },
      payload: { name: "guess", rootPath: fixture.workspace }
    });
    expect(duplicate.statusCode).toBe(404);
    expect(otherDevice.id).toBe("device-b");
  });

  it("uploads binary attachments, serves them privately, and rejects cross-Session references", async () => {
    const fixture = await createFixture();
    const project = new ProjectRepository(fixture.database).create({
      userId: "owner-a",
      name: "Attachments",
      rootPath: fixture.workspace,
      workspaceKey: "attachments-workspace",
      rootIdentity: "attachments-root"
    });
    const firstSession = new SessionRepository(fixture.database).create({ projectId: project.id, title: "First" });
    const secondSession = new SessionRepository(fixture.database).create({ projectId: project.id, title: "Second" });
    const upload = await fixture.app.inject({
      method: "POST",
      url: `/v1/sessions/${firstSession.id}/artifacts`,
      headers: {
        ...authHeader(fixture.deviceToken),
        "content-type": "image/png",
        ...idempotencyHeader("b4d6e57b-509f-4d87-a9b5-c496aa2b90de")
      },
      payload: Buffer.from("binary-attachment")
    });
    expect(upload.statusCode).toBe(201);
    const artifact = json(upload) as { id: string; sessionId: string; mimeType: string; byteLength: number; sha256: string };
    expect(artifact).toMatchObject({ sessionId: firstSession.id, mimeType: "image/png", byteLength: 17 });
    expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/);

    const download = await fixture.app.inject({
      method: "GET",
      url: `/v1/artifacts/${artifact.id}`,
      headers: authHeader(fixture.deviceToken)
    });
    expect(download.statusCode).toBe(200);
    expect(download.body).toBe("binary-attachment");

    const wrongSession = await fixture.app.inject({
      method: "POST",
      url: `/v1/sessions/${secondSession.id}/commands`,
      headers: {
        ...authHeader(fixture.deviceToken),
        ...idempotencyHeader("d7f68e37-4fb1-4852-83b7-4a3e201ec0a9")
      },
      payload: { kind: "follow_up", payload: { text: "use it", attachments: [{ artifactId: artifact.id, mimeType: "image/png" }] } }
    });
    expect(wrongSession.statusCode).toBe(404);
    expect(json(wrongSession).error).toMatchObject({ code: "NOT_FOUND" });
  });
});
