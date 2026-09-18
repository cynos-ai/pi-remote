import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { backupDeployment, doctorDeployment, initializeDeployment, restoreDeployment } from "../../apps/server/src/deployment.js";
import { parseEnv } from "../../apps/server/src/config.js";
import { openServerDatabaseSync } from "../../apps/server/src/storage/database.js";
import { OwnerRepository, ProjectRepository, SessionRepository } from "../../apps/server/src/storage/index.js";

interface DeploymentFixture {
  root: string;
  state: string;
  pi: string;
  workspace: string;
  env: ReturnType<typeof parseEnv>;
}

const fixtures: DeploymentFixture[] = [];

async function makeFixture(): Promise<DeploymentFixture> {
  const root = await mkdtemp(join(tmpdir(), "pi-remote-s12-"));
  const state = join(root, "state");
  const pi = join(state, "pi");
  const workspace = join(root, "workspaces");
  const env = parseEnv({
    PI_REMOTE_STATE_DIR: state,
    PI_REMOTE_PI_DIR: pi,
    PI_REMOTE_WORKSPACE_ROOT: workspace,
    PI_REMOTE_OWNER_ID: "s12-owner",
    PI_REMOTE_OWNER_NAME: "S12 owner",
    PI_REMOTE_CURSOR_SECRET: "s12-deployment-cursor-secret",
    PI_REMOTE_LIVE_TESTS: "0"
  });
  const fixture = { root, state, pi, workspace, env };
  fixtures.push(fixture);
  await initializeDeployment(env);
  return fixture;
}

afterEach(async () => {
  while (fixtures.length > 0) {
    const fixture = fixtures.pop();
    if (fixture) await rm(fixture.root, { recursive: true, force: true });
  }
});

describe("S12 deployment lifecycle", () => {
  it("initializes a private state layout and reports operator diagnostics", async () => {
    const fixture = await makeFixture();
    await mkdir(join(fixture.workspace, "project"), { recursive: true });
    const report = await doctorDeployment(fixture.env);
    expect(report.checks.map((check) => check.id)).toEqual(expect.arrayContaining([
      "state-directory",
      "pi-directory",
      "output-directory",
      "workspace-root",
      "sqlite",
      "runtime-user",
      "model-catalog",
      "maintenance",
      "instance-lock"
    ]));
    expect(report.checks.find((check) => check.id === "sqlite")?.status).toBe("passed");
    expect(report.checks.find((check) => check.id === "model-catalog")?.status).toBe("warning");
  });

  it("creates a manifest with relative trees and restores it into a new state volume", async () => {
    const source = await makeFixture();
    await mkdir(join(source.pi, "sessions", "nested"), { recursive: true });
    await mkdir(join(source.state, "outputs", "run-1"), { recursive: true });
    await writeFile(join(source.pi, "models.json"), "{\"models\":[]}");
    await writeFile(join(source.pi, "sessions", "nested", "history.jsonl"), "header\n");
    await writeFile(join(source.state, "outputs", "run-1", "result.txt"), "S12 artifact\n");
    await chmod(join(source.pi, "models.json"), 0o600);

    const backupPath = join(source.root, "backups", "first");
    const backup = await backupDeployment(source.env, backupPath);
    expect(backup.manifest.trees.pi.map((file) => file.path)).toEqual([
      "models.json",
      "sessions/nested/history.jsonl"
    ]);
    expect(backup.manifest.trees.outputs.map((file) => file.path)).toEqual(["run-1/result.txt"]);
    expect(JSON.parse(await readFile(join(backupPath, "manifest.json"), "utf8"))).toMatchObject({
      schemaVersion: 1,
      database: { path: "database.sqlite" }
    });
    const manifestBytes = await readFile(join(backupPath, "manifest.json"));
    expect((await readFile(join(backupPath, "manifest.sha256"), "utf8")).trim()).toBe(
      createHash("sha256").update(manifestBytes).digest("hex")
    );

    const restoredRoot = join(source.root, "restored");
    const restoredEnv = parseEnv({
      PI_REMOTE_STATE_DIR: join(restoredRoot, "state"),
      PI_REMOTE_PI_DIR: join(restoredRoot, "state", "pi"),
      PI_REMOTE_WORKSPACE_ROOT: join(restoredRoot, "workspaces"),
      PI_REMOTE_OWNER_ID: "s12-owner",
      PI_REMOTE_OWNER_NAME: "S12 owner",
      PI_REMOTE_CURSOR_SECRET: "s12-deployment-cursor-secret",
      PI_REMOTE_LIVE_TESTS: "0"
    });
    const restored = await restoreDeployment(restoredEnv, backupPath);
    expect(restored.restoredFiles).toBe(4);
    expect(await readFile(join(restoredEnv.PI_REMOTE_PI_DIR, "sessions", "nested", "history.jsonl"), "utf8")).toBe("header\n");
    expect(await readFile(join(restoredEnv.PI_REMOTE_STATE_DIR, "outputs", "run-1", "result.txt"), "utf8")).toBe("S12 artifact\n");

    const database = openServerDatabaseSync({ filename: restored.databaseFile });
    try {
      expect(database.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 1 });
      expect(database.prepare("PRAGMA quick_check").get()).toMatchObject({ quick_check: "ok" });
      expect(new OwnerRepository(database).get("s12-owner")).toMatchObject({ displayName: "S12 owner" });
    } finally {
      database.close();
    }
  });

  it("refuses backups with active runtime and refuses destinations inside a workspace", async () => {
    const fixture = await makeFixture();
    const database = openServerDatabaseSync({ filename: join(fixture.state, "state.sqlite") });
    try {
      const project = new ProjectRepository(database).create({
        id: "s12-project",
        userId: "s12-owner",
        name: "S12 project",
        rootPath: fixture.workspace,
        workspaceKey: fixture.workspace,
        rootIdentity: "s12-project-identity",
        now: Date.now()
      });
      const session = new SessionRepository(database).create({
        id: "s12-session",
        projectId: project.id,
        title: "S12 session",
        now: Date.now()
      });
      database.prepare(
        "INSERT INTO runs(id, session_id, operation_id, source, kind, status, worker_epoch, execution_scope_key, created_at) VALUES (?, ?, ?, 'runtime', 'prompt', 'running', ?, ?, ?)"
      ).run("s12-active-run", session.id, "s12-operation", "s12-epoch", "s12-scope", Date.now());
    } finally {
      database.close();
    }

    await expect(backupDeployment(fixture.env, join(fixture.root, "outside-backup"))).rejects.toThrow(/active runtime remains/);
    await expect(backupDeployment(fixture.env, join(fixture.workspace, "inside-backup"))).rejects.toThrow(/outside the state and workspace roots/);
  });
});
