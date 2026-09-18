import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const platform = argument("--platform");
const flowByPlatform = {
  android: ".maestro/s11-recovery-android.yaml",
  ios: ".maestro/s11-recovery-ios.yaml"
};
const flow = platform ? flowByPlatform[platform] : undefined;
const environment = {
  ...process.env,
  PI_REMOTE_TEST_DEVICE_NAME: process.env.PI_REMOTE_TEST_DEVICE_NAME ?? `S11 Maestro ${platform ?? "device"}`
};
const timeoutMs = boundedInteger(process.env.PI_REMOTE_DEVICE_TIMEOUT_MS, 120_000, 5_000, 900_000);

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function boundedInteger(value, fallback, minimum, maximum) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function redact(value) {
  let result = String(value ?? "");
  for (const key of [
    "PI_REMOTE_TEST_SERVER",
    "PI_REMOTE_TEST_PAIRING_TOKEN",
    "PI_REMOTE_TEST_PROJECT_NAME",
    "PI_REMOTE_TEST_PROJECT_ROOT",
    "PI_REMOTE_TEST_PROMPT",
    "PI_REMOTE_TEST_STEER"
  ]) {
    const secret = environment[key];
    if (typeof secret === "string" && secret.length > 0) result = result.split(secret).join("[redacted]");
  }
  return result.replace(/(authorization|bearer|token)\s*[:=]?\s*[^\s,;]+/gi, "$1=[redacted]");
}

function tail(value, maximum = 3_000) {
  const clean = redact(value).trim();
  return clean.length <= maximum ? clean : clean.slice(-maximum);
}

function run(command, args, options = {}) {
  const limit = options.timeoutMs ?? 15_000;
  return new Promise((resolvePromise) => {
    const executable = process.platform === "win32" && command === "pnpm" ? "pnpm.cmd" : command;
    const child = spawn(executable, args, {
      cwd: root,
      env: environment,
      shell: process.platform === "win32" && command === "pnpm",
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolvePromise(result);
    };
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => finish({ code: 1, signal: null, stdout, stderr: String(error) }));
    child.once("close", (code, signal) => finish({ code: code ?? 1, signal, stdout, stderr }));
    timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 2_000).unref?.();
      finish({ code: 124, signal: "SIGTERM", stdout, stderr: `${stderr}\ncommand timed out after ${limit}ms` });
    }, limit);
  });
}

function requiredInputs() {
  return [
    "PI_REMOTE_TEST_SERVER",
    "PI_REMOTE_TEST_PAIRING_TOKEN",
    "PI_REMOTE_TEST_PROJECT_NAME",
    "PI_REMOTE_TEST_PROJECT_ROOT",
    "PI_REMOTE_TEST_PROMPT",
    "PI_REMOTE_TEST_STEER"
  ].filter((key) => typeof environment[key] !== "string" || environment[key].trim().length === 0);
}

function validServerUrl() {
  try {
    const url = new globalThis.URL(environment.PI_REMOTE_TEST_SERVER);
    return url.protocol === "https:";
  } catch {
    return false;
  }
}

function androidDevices(output) {
  return output
    .split(/\r?\n/)
    .map((line) => /^(\S+)\s+(device|offline|unauthorized)\s*$/.exec(line.trim()))
    .filter(Boolean)
    .map((match) => ({ status: match[2] }));
}

function bootedIosSimulators(output) {
  return output
    .split(/\r?\n/)
    .filter((line) => /\(Booted\)\s*$/.test(line));
}

function finish(status, reason, evidence = [], details = {}) {
  const result = {
    stage: "S11",
    platform,
    status,
    command: flow ? `maestro test ${flow}` : "pnpm test:device -- --platform android|ios",
    evidence,
    ...(reason ? { reason: redact(reason) } : {}),
    details
  };
  console.log(`S11_DEVICE_RESULT ${JSON.stringify(result)}`);
  if (status !== "passed") process.exitCode = 1;
}

async function main() {
  if (platform !== "android" && platform !== "ios") {
    finish("not_run", "请用 --platform android 或 --platform ios", ["device platform argument"]);
    return;
  }

  const missing = requiredInputs();
  if (missing.length > 0) {
    finish("not_run", `缺少真实设备流程配置：${missing.join(", ")}`, [], { missingInputs: missing });
    return;
  }
  if (!validServerUrl()) {
    finish("not_run", "PI_REMOTE_TEST_SERVER 必须是设备可访问且使用 HTTPS 的服务器地址");
    return;
  }

  const maestro = await run("maestro", ["--version"]);
  if (maestro.code !== 0) {
    finish("not_run", `Maestro 不可用：${tail(maestro.stderr || maestro.stdout, 1_000)}`);
    return;
  }

  let deviceDetails;
  if (platform === "android") {
    const adbVersion = await run("adb", ["version"]);
    if (adbVersion.code !== 0) {
      finish("not_run", `adb 不可用：${tail(adbVersion.stderr || adbVersion.stdout, 1_000)}`);
      return;
    }
    const adbDevices = await run("adb", ["devices"]);
    if (adbDevices.code !== 0) {
      finish("not_run", `adb 无法读取设备列表：${tail(adbDevices.stderr || adbDevices.stdout, 1_000)}`);
      return;
    }
    const devices = androidDevices(adbDevices.stdout);
    const ready = devices.filter((device) => device.status === "device").length;
    deviceDetails = { readyDevices: ready, listedDevices: devices.length };
    if (ready === 0) {
      finish("not_run", "没有已授权且在线的 Android 设备或模拟器", [], deviceDetails);
      return;
    }
  } else {
    const simulators = await run("xcrun", ["simctl", "list", "devices", "available"]);
    if (simulators.code !== 0) {
      finish("not_run", `xcrun / iOS Simulator 不可用：${tail(simulators.stderr || simulators.stdout, 1_000)}`);
      return;
    }
    const booted = bootedIosSimulators(simulators.stdout).length;
    deviceDetails = { bootedSimulators: booted };
    if (booted === 0) {
      finish("not_run", "没有已启动的 iOS Simulator；请先启动一个可用设备", [], deviceDetails);
      return;
    }
  }

  const result = await run("maestro", ["test", flow], { timeoutMs });
  if (result.code === 0) {
    finish("passed", undefined, [
      flow,
      "真实 HTTPS 配对与资源入口",
      "Session 实时连接 / 前后台恢复流程",
      "设备端断线后的人工网络 / 进程故障观察点"
    ], deviceDetails);
    return;
  }
  finish("failed", `Maestro 流程失败：${tail(result.stdout)}\n${tail(result.stderr)}`, [flow], deviceDetails);
}

try {
  await main();
} catch (error) {
  finish("failed", error instanceof Error ? error.message : String(error));
}
