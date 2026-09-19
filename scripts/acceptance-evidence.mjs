import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const liveCases = {
  sdk: ["AT02-prompt-tools", "AT03-thinking", "AT26-retry-settle", "SDK-long-development"],
  commands: ["CMD-model-thinking", "CMD-steer-stop-drafts", "CMD-compact-queue", "CMD-all-phase-forms", "CMD-native-session-title", "CMD-autonomous-multiple-runs"],
  realtime: ["RT-stream-tool", "RT-reconnect-replay", "RT-snapshot-handoff", "RT-slow-consumer-artifact", "RT-device-revocation"]
};
export const parityTargets = ["sdk", "runtime", "commands", "realtime", "docker"];
export const caseInstructions = {
  "AT02-prompt-tools": "两个实际模型之一完成 prompt、read/write 工具并核对临时文件、成功终态；不能仅断言 agent_end。",
  "AT03-thinking": "第二个不同的真实模型返回可观察的 thinking 块，并成功完成。",
  "AT26-retry-settle": "真实 provider 失败/重试后核对最终结果、settle 时序和失败投影；记录故障触发方式。",
  "SDK-long-development": "临时项目完成持续开发、工具失败修复、后续对话和历史恢复，记录时长与结果。",
  "CMD-model-thinking": "真实 server/worker 经 HTTP 切模型/等级，核对实际配置、CAS 和 streaming 中的行为。",
  "CMD-steer-stop-drafts": "活动 Run 加 steer/follow-up，stop 取回完整未消费输入；旧 target 不停止新 Run，草稿不重放。",
  "CMD-compact-queue": "真实 compact 对照原生队列，先停止并保留上下文；不得套用 stop 的 clearQueue。",
  "CMD-all-phase-forms": "initialize/configure/run/bash/extension 四类表单、异步 hook、取消/到期/重连、重复回答和配置生效后 hook 失败。",
  "CMD-native-session-title": "new/switch/fork/import、跨 Session 后续执行、标题回声和并发改名不串归属。",
  "CMD-autonomous-multiple-runs": "自主无 Command、一命令多 Run、无 Run 内容、待答归档、新操作与旧暂停队列分别核对。",
  "RT-stream-tool": "实际 HTTPS/WSS + server/worker + 真实模型完成文本流和工具往返。",
  "RT-reconnect-replay": "生成中断线，服务继续；从持久 cursor 重连，无漏项/重复，与数据库核对。",
  "RT-snapshot-handoff": "snapshot 与订阅交接期间产生新事件、cursor 缺口及缓存丢失，最终投影一致。",
  "RT-slow-consumer-artifact": "慢连接/大输出/Range 与越权下载；展示限额不裁剪模型结果、不结束工具，原始文件可读。",
  "RT-device-revocation": "吊销设备同时拒绝 HTTP 并关闭已有 WSS，其他设备继续执行。",
  B01: "命令与环境：管道/重定向/脚本/cwd 外测试文件，PATH/HOME/shell，无额外过滤。",
  B02: "开发工具与网络：临时 Git 项目、依赖安装、构建测试、受控 HTTP 服务。",
  B03: "无 timeout 的 Bash 超过 300 秒及无输出/断网/可选回收；另测显式 timeout。",
  B04: "后台服务返回后跨 Run、断网、切会话、归档和可选回收仍存活，后续停止。",
  B05: "定向停止前台调用，不误杀已正常返回的后台服务。",
  B06: "非零工具退出交给模型修复并再测试成功，Run 不提前失败。",
  B07: "stdout/stderr、大输出和 artifact 配额；比较模型结果和原始文件。",
  B08: "未完成 Bash SIGKILL，unknown 不重放，旧队列暂停，新操作可用；清理测试进程。",
  T01: "原生工具/扩展/skills/templates/上下文以相同资源与配置加载。",
  T02: "steer/follow-up、stop 完整草稿、即时扩展命令、自主和多 Run。",
  T03: "模型/thinking/compact 原生前置条件、异步 hook、实际配置和队列。",
  T04: "五阶段四种表单、初始化未 ready 与异步 hook、无 Run 等待不自动取消。",
  T05: "同目录多 Session 并行、归档、标题回声/并发、旧队列不锁新操作。",
  T06: "断网继续、保留扩展状态、无 Run 中断/回放、旧 target 不变新任务。",
  T07: "附件、用户 Bash、custom、树/fork/导入导出、合法空历史与原生替换。",
  T08: "新增限制均有真实复现或用户配置；普通启动无需清理证明。"
};

export function requiredCases(scope) {
  if (scope.startsWith("live-")) {
    const cases = liveCases[scope.slice(5)];
    if (cases) return cases;
  }
  const match = /^parity-(bash|tui)-(sdk|runtime|commands|realtime|docker)$/.exec(scope);
  if (match) return Array.from({ length: 8 }, (_, i) => `${match[1] === "bash" ? "B" : "T"}0${i + 1}`);
  throw new Error("unsupported acceptance scope");
}

export function aggregate(checks) {
  if (!checks.length || checks.some(c => !["passed", "failed", "not_run"].includes(c.status))) return "failed";
  return checks.some(c => c.status === "failed") ? "failed" : checks.some(c => c.status === "not_run") ? "blocked" : "passed";
}

// Bind evidence to actual source bytes, including uncommitted work. Generated
// reports, credentials, sessions and builds are excluded by repository ignores.
export async function sourceIdentity(directory = root) {
  const paths = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: directory, stdio: ["ignore", "pipe", "ignore"] }).toString().split("\0").filter(Boolean);
  const hash = createHash("sha256");
  // Updating the evidence log after a run must not invalidate that same run.
  const metadata = new Set(["docs/progress.md", "docs/release-readiness.md"]);
  for (const path of [...new Set(paths)].filter(path => !metadata.has(path)).sort()) {
    hash.update(path).update("\0");
    try { hash.update(await readFile(resolve(directory, path))); }
    catch (error) { if (error.code !== "ENOENT") throw error; hash.update("<deleted>"); }
    hash.update("\0");
  }
  return { commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: directory }).toString().trim(), sourceSha256: hash.digest("hex") };
}

export function plan(scope, identity) {
  return {
    schemaVersion: 1, scope, ...identity, recordedAt: new Date().toISOString(),
    environment: { os: "linux", sdk: "0.85.1", node: "", modelIds: [], resourceSha256: "", configSha256: "", imageDigest: scope.endsWith("-docker") ? "" : undefined },
    checks: requiredCases(scope).map(id => ({ id, status: "not_run", command: "", observation: "", instruction: caseInstructions[id], artifacts: [] }))
  };
}

const nonempty = value => typeof value === "string" && value.trim().length > 0;
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

async function artifactDigest(base, artifact) {
  if (!artifact || !nonempty(artifact.path) || isAbsolute(artifact.path) || !digest(artifact.sha256)) throw new Error("invalid artifact reference");
  const baseReal = await realpath(base);
  const file = await realpath(resolve(baseReal, artifact.path));
  const rel = relative(baseReal, file);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("artifact escapes evidence directory");
  const info = await stat(file);
  if (!info.isFile() || info.size === 0 || info.size > 32 * 1024 * 1024) throw new Error("artifact must be a nonempty file up to 32 MiB");
  const actual = createHash("sha256").update(await readFile(file)).digest("hex");
  if (actual !== artifact.sha256) throw new Error("artifact digest mismatch");
  return { role: artifact.role, sha256: actual };
}

// This validates operator-recorded evidence, not its truth. The original
// observation/command/captures stay private; reports retain provenance/digests.
export async function importEvidence(path, scope, identity) {
  const required = requiredCases(scope);
  const missing = reason => required.map(id => ({ id, status: "not_run", reason, evidence: [] }));
  if (!path) return missing("environment: provide --evidence or PI_REMOTE_ACCEPTANCE_EVIDENCE_DIR; see --plan");
  let manifest;
  try { manifest = JSON.parse(await readFile(path, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return missing("environment: evidence manifest is missing");
    throw new Error("invalid evidence JSON", { cause: error });
  }
  const env = manifest.environment;
  if (manifest.schemaVersion !== 1 || manifest.scope !== scope || manifest.commit !== identity.commit || manifest.sourceSha256 !== identity.sourceSha256) throw new Error("evidence scope or source identity mismatch; rerun against current source");
  const date = Date.parse(manifest.recordedAt);
  if (!Number.isFinite(date) || date > Date.now() + 300000) throw new Error("invalid evidence timestamp");
  if (!env || env.os !== "linux" || env.sdk !== "0.85.1" || !/^v?24\./.test(env.node ?? "") || !Array.isArray(env.modelIds) || !env.modelIds.length || !env.modelIds.every(nonempty) || !digest(env.resourceSha256) || !digest(env.configSha256)) throw new Error("evidence requires Linux, Node 24, SDK 0.85.1, real model IDs and resource/config digests");
  if (scope === "live-sdk" && new Set(env.modelIds).size < 2) throw new Error("SDK evidence requires two distinct models");
  if (scope.endsWith("-docker") && !/^sha256:[a-f0-9]{64}$/.test(env.imageDigest ?? "")) throw new Error("Docker parity requires an image digest");
  if (!Array.isArray(manifest.checks)) throw new Error("evidence checks must be an array");
  const seen = new Set();
  for (const check of manifest.checks) {
    if (!required.includes(check.id) || seen.has(check.id) || !["passed", "failed", "not_run"].includes(check.status)) throw new Error("unknown/duplicate case or invalid status");
    seen.add(check.id);
  }
  const checks = [];
  for (const id of required) {
    const check = manifest.checks.find(c => c.id === id);
    if (!check || check.status === "not_run") {
      checks.push({ id, status: "not_run", reason: "coverage: scenario has not been executed", evidence: [] });
      continue;
    }
    if (!nonempty(check.command) || !nonempty(check.observation) || !Array.isArray(check.artifacts)) throw new Error("executed case requires command, observation and artifacts");
    const roles = scope.startsWith("parity-") ? ["native", "application"] : ["application"];
    if (!roles.every(role => check.artifacts.some(a => a.role === role))) throw new Error("missing required capture roles");
    const evidence = [];
    for (const artifact of check.artifacts) {
      if (!roles.includes(artifact.role)) throw new Error("invalid capture role");
      evidence.push(await artifactDigest(dirname(path), artifact));
    }
    if (scope.startsWith("parity-") && new Set(evidence.map(e => e.sha256)).size < 2) throw new Error("native and application captures must be separate");
    checks.push({ id, status: check.status, provenance: "operator-recorded", evidenceRecordedAt: manifest.recordedAt, evidence,
      reason: check.status === "failed" ? "execution: operator recorded a failed comparison" : undefined });
  }
  return checks;
}

export function validateReport(report, scope, identity) {
  if (!report || report.schemaVersion !== 1 || report.scope !== scope || report.commit !== identity.commit || report.sourceSha256 !== identity.sourceSha256) return "failed";
  if (!Array.isArray(report.checks)) return "failed";
  const ids = report.checks.map(c => c.id);
  if (new Set(ids).size !== ids.length || !requiredCases(scope).every(id => ids.includes(id))) return "failed";
  for (const check of report.checks) {
    if (check.status === "passed" && (!Array.isArray(check.evidence) || !check.evidence.length)) return "failed";
    if (check.status === "passed") {
      if (check.provenance === "operator-recorded") {
        const roles = scope.startsWith("parity-") ? ["native", "application"] : ["application"];
        if (!roles.every(role => check.evidence.some(e => e.role === role && digest(e.sha256)))) return "failed";
      } else if (check.provenance === "automated") {
        const automated = { "live-sdk": ["AT02-prompt-tools", "AT03-thinking", "AUTO-SDK-thinking-single", "S02-live-results"],
          "live-commands": ["AUTO-CMD-prompt-idempotency", "AUTO-CMD-idle-config", "AUTO-CMD-stop-drafts", "CMD-steer-stop-drafts", "AUTO-CMD-compact-native-queue", "AUTO-CMD-compact-cancel-before-summary", "AUTO-CMD-compact-cancel-stream", "AUTO-CMD-active-config-recovery", "AUTO-CMD-persist-empty-recovery", "AUTO-CMD-model-select-error"],
          "live-realtime": ["RT-stream-tool", "RT-reconnect-replay"] };
        if (!automated[scope]?.includes(check.id)) return "failed";
      } else return "failed";
    }
  }
  const status = aggregate(report.checks);
  return status === report.status ? status : "failed";
}

export async function consumeReport(scope, identity) {
  identity ??= await sourceIdentity();
  let report;
  try { report = JSON.parse(await readFile(resolve(root, "test-results", scope, "report.json"), "utf8")); }
  catch (error) { return { status: error.code === "ENOENT" ? "not_run" : "failed", evidence: [], reason: "missing or unreadable acceptance report" }; }
  const status = validateReport(report, scope, identity);
  return { status: status === "blocked" ? "not_run" : status,
    evidence: status === "passed" ? [`${scope}: ${report.checks.length} checks; source ${identity.sourceSha256}`] : [],
    reason: status === "passed" ? undefined : status === "blocked"
      ? `${scope}: ${report.checks.filter(check => check.status === "not_run").length} checks not_run; see the scenario report`
      : "acceptance report failed validation/execution or has stale source identity; rerun its entrypoint" };
}
