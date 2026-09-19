import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { root } from "./acceptance-evidence.mjs";
import { stageRealProcessRuntime } from "./stage-real-process-runtime.mjs";

let stage;
try {
  let directory = root;
  if (process.platform === "linux" && /^\/mnt\/[a-z]\//.test(root)) {
    stage = await mkdtemp(join(tmpdir(), "pi-acceptance-runtime-"));
    await stageRealProcessRuntime(root, stage);
    directory = stage;
  }
  const result = spawnSync(process.execPath, ["--test", "tests/sdk/live-backend.test.mjs"], {
    cwd: directory, stdio: "inherit", timeout: 540000
  });
  process.exitCode = result.status ?? 1;
} finally {
  if (stage) await rm(stage, { recursive: true, force: true });
}
