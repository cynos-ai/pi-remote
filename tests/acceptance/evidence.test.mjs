import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { aggregate, importEvidence, plan, requiredCases, root, validateReport } from "../../scripts/acceptance-evidence.mjs";

const identity = { commit: "a".repeat(40), sourceSha256: "b".repeat(64) };
const hash = text => createHash("sha256").update(text).digest("hex");
async function fixture(t, scope = "parity-tui-runtime") {
  const directory = await mkdtemp(join(tmpdir(), "pi-evidence-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manifest = plan(scope, identity);
  manifest.environment = { os: "linux", node: "v24.19.0", sdk: "0.85.1", modelIds: ["synthetic/a", "synthetic/b"], resourceSha256: hash("resources"), configSha256: hash("config") };
  for (const role of ["native", "application"]) await writeFile(join(directory, `${role}.txt`), `synthetic schema test ${role}`);
  manifest.checks = manifest.checks.map(c => ({ ...c, status: "passed", command: "synthetic validation fixture", observation: "schema tests only, not real acceptance",
    artifacts: (scope.startsWith("parity-") ? ["native", "application"] : ["application"]).map(role => ({ role, path: `${role}.txt`, sha256: hash(`synthetic schema test ${role}`) })) }));
  const path = join(directory, "evidence.json");
  const save = () => writeFile(path, JSON.stringify(manifest));
  await save();
  return { directory, path, manifest, save, scope };
}

test("missing conditions and partial coverage stay blocked; empty/unknown statuses cannot pass", async () => {
  assert.equal(aggregate(await importEvidence(undefined, "live-sdk", identity)), "blocked");
  assert.equal(aggregate([]), "failed");
  assert.equal(aggregate([{ status: "skip" }]), "failed");
  assert.equal(aggregate([{ status: "failed" }, { status: "not_run" }]), "failed");
});

test("automated controls evidence does not imply the full commands suite passed", async () => {
  const checks = await importEvidence(undefined, "live-commands", identity);
  Object.assign(checks.find(c => c.id === "CMD-steer-stop-drafts"), {
    status: "passed", provenance: "automated", evidence: ["synthetic report-validation fixture"]
  });
  const report = { schemaVersion: 1, scope: "live-commands", ...identity, status: "blocked", checks };
  assert.equal(validateReport(report, "live-commands", identity), "blocked");
  assert.equal(validateReport({ ...report, status: "passed" }, "live-commands", identity), "failed");
});

test("captured comparisons validate hashes and preserve manual provenance", async t => {
  const f = await fixture(t);
  const result = await importEvidence(f.path, f.scope, identity);
  assert.equal(aggregate(result), "passed");
  assert.equal(result.length, 8);
  assert.ok(result.every(c => c.provenance === "operator-recorded"));
  assert.ok(!JSON.stringify(result).includes(f.directory));
  assert.ok(!JSON.stringify(result).includes("schema tests only"));
  f.manifest.checks.pop(); await f.save();
  assert.equal(aggregate(await importEvidence(f.path, f.scope, identity)), "blocked");
});

for (const [name, mutate] of [
  ["wrong scope", m => { m.scope = "parity-tui-sdk"; }],
  ["stale source", m => { m.sourceSha256 = "c".repeat(64); }],
  ["wrong SDK", m => { m.environment.sdk = "0.85.2"; }],
  ["duplicate case", m => { m.checks.push(m.checks[0]); }],
  ["invented case", m => { m.checks[0].id = "T99"; }],
  ["skipped case", m => { m.checks[0].status = "skip"; }],
  ["missing observation", m => { m.checks[0].observation = ""; }],
  ["missing native capture", m => { m.checks[0].artifacts.shift(); }],
  ["wrong digest", m => { m.checks[0].artifacts[0].sha256 = "d".repeat(64); }],
  ["same captures", m => { m.checks[0].artifacts[1] = { ...m.checks[0].artifacts[0], role: "application" }; }],
  ["absolute path", m => { m.checks[0].artifacts[0].path = root; }],
  ["future timestamp", m => { m.recordedAt = "2999-01-01T00:00:00Z"; }]
]) test(`reject ${name}`, async t => {
  const f = await fixture(t); mutate(f.manifest); await f.save();
  await assert.rejects(importEvidence(f.path, f.scope, identity));
});

test("reject replaced, empty, missing and escaping artifacts", async t => {
  const f = await fixture(t);
  await writeFile(join(f.directory, "native.txt"), "");
  await assert.rejects(importEvidence(f.path, f.scope, identity));
  f.manifest.checks[0].artifacts[0].path = "missing.txt"; await f.save();
  await assert.rejects(importEvidence(f.path, f.scope, identity));
  // An existing sibling with a matching hash must still be rejected.
  const outside = `${f.directory}-outside.txt`;
  t.after(() => rm(outside, { force: true })); await writeFile(outside, "outside");
  f.manifest.checks[0].artifacts[0] = { role: "native", path: `../${outside.split(/[\\/]/).at(-1)}`, sha256: hash("outside") };
  await f.save(); await assert.rejects(importEvidence(f.path, f.scope, identity));
});

test("release consumer rejects empty, duplicate, incomplete, stale and inconsistent reports", () => {
  const report = { schemaVersion: 1, scope: "live-realtime", ...identity, status: "passed",
    checks: requiredCases("live-realtime").map(id => ({ id, status: "passed", provenance: "operator-recorded", evidence: [{ role: "application", sha256: hash("synthetic contract") }] })) };
  assert.equal(validateReport(report, report.scope, identity), "passed");
  for (const changed of [
    { ...report, checks: [] }, { ...report, checks: report.checks.slice(1) },
    { ...report, checks: [...report.checks, report.checks[0]] },
    { ...report, sourceSha256: "stale" }, { ...report, status: "blocked" },
    { ...report, checks: report.checks.map(c => ({ ...c, evidence: [] })) },
    { ...report, checks: report.checks.map(c => ({ ...c, provenance: "automated" })) }
  ]) assert.equal(validateReport(changed, report.scope, identity), "failed");
});

test("all CLI scopes emit complete blocked reports without credentials or SDK imports", { timeout: 120000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "pi-cli-evidence-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = { ...process.env, PI_REMOTE_LIVE_TESTS: "0", PI_REMOTE_ACCEPTANCE_EVIDENCE_DIR: "", PI_REMOTE_ACCEPTANCE_REPORT_DIR: directory };
  const entries = [
    ...["sdk", "commands", "realtime"].map(s => ["scripts/test-live.mjs", ["--suite", s], `live-${s}`]),
    ...["bash", "tui"].flatMap(k => ["sdk", "runtime", "commands", "realtime", "docker"].map(s => ["scripts/test-parity.mjs", [k, "--target", s], `parity-${k}-${s}`]))
  ];
  for (const [script, args, scope] of entries) {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: root, env, encoding: "utf8", timeout: 15000 });
    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(await readFile(join(directory, scope, "report.json"), "utf8"));
    assert.equal(report.status, "blocked");
    assert.deepEqual(report.checks.map(c => c.id), requiredCases(scope));
    assert.equal(validateReport(report, scope, report), "blocked");
  }
  for (const args of [["scripts/test-live.mjs", "--suite", "../bad"], ["scripts/test-parity.mjs", "tui", "--target", "../bad"]]) {
    const result = spawnSync(process.execPath, args, { cwd: root, env });
    assert.equal(result.status, 2);
  }
});

for (const scenario of ["compact", "compact-cancel", "compact-cancel-stream"]) test(`${scenario} refuses insufficient operation budget before loading a runtime`, async t => {
  const directory = await mkdtemp(join(tmpdir(), "pi-compact-budget-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = { ...process.env, PI_REMOTE_LIVE_TESTS: "1", PI_REMOTE_ACCEPTANCE_EVIDENCE_DIR: "",
    PI_REMOTE_ACCEPTANCE_REPORT_DIR: directory, PI_REMOTE_LIVE_AGENT_DIR: join(directory, "not-created"),
    PI_REMOTE_LIVE_PROVIDER: "synthetic", PI_REMOTE_LIVE_MODEL: "one", PI_REMOTE_LIVE_THINKING_PROVIDER: "synthetic",
    PI_REMOTE_LIVE_THINKING_MODEL: "two", PI_REMOTE_LIVE_MAX_OPERATIONS: "7", PI_REMOTE_LIVE_TIMEOUT_MS: "120000" };
  const result = spawnSync(process.execPath, ["scripts/test-live.mjs", "--suite", "commands", "--scenario", scenario], { cwd: root, env, encoding: "utf8", timeout: 15000 });
  assert.equal(result.status, 1);
  const report = JSON.parse(await readFile(join(directory, "live-commands", "report.json"), "utf8"));
  assert.equal(report.status, "blocked");
  assert.ok(report.checks.some(c => c.id === "live-environment" && c.status === "not_run"));
  report.checks.push({ id: scenario === "compact" ? "AUTO-CMD-compact-native-queue" : scenario === "compact-cancel" ? "AUTO-CMD-compact-cancel-before-summary" : "AUTO-CMD-compact-cancel-stream", status: "passed", provenance: "automated", evidence: ["synthetic report fixture"] });
  assert.equal(validateReport(report, "live-commands", report), "blocked");
  assert.equal(report.checks.find(c => c.id === "CMD-compact-queue").status, "not_run");
});
