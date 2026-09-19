import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { buildServer } from "../../apps/server/dist/index.js";
import { parseEnv } from "../../apps/server/dist/config.js";
import { openServerDatabaseSync } from "../../apps/server/dist/storage/database.js";
import { WorkerManager } from "../../apps/server/dist/runtime/manager.js";

const env = parseEnv();
const database = openServerDatabaseSync({ filename: join(env.PI_REMOTE_STATE_DIR, "state.sqlite") });
const manager = new WorkerManager(database, {
  stateDir: env.PI_REMOTE_STATE_DIR, piDir: env.PI_REMOTE_PI_DIR,
  agentDir: env.PI_REMOTE_PI_DIR,
  // Keep all generated sessions out of the operator's credential/resource dir.
  sessionDir: join(env.PI_REMOTE_STATE_DIR, "sessions"), mappingTimeoutMs: 60000,
  workerIdleMs: process.env.R16_CONFIG_REAP === "1" ? 500 : 0
});
manager.start();
// Test-only opt-in: exercise the real graceful idle reaper after the fixture
// has finished checking already-loaded sessions. No production HTTP endpoint.
const reapTimer = process.env.R16_CONFIG_REAP === "1" ? setInterval(() => {
  if (existsSync(join(env.PI_REMOTE_STATE_DIR, "reap-enabled"))) void manager.reapIdleWorkers();
}, 100) : undefined;
const app = buildServer({ env, database, workerManager: manager, logger: false,
  https: { key: await readFile(process.env.R16_TLS_KEY), cert: await readFile(process.env.R16_TLS_CERT) } });
app.addHook("onClose", async () => { clearInterval(reapTimer); await manager.stop(); database.close(); });
await app.listen({ host: "127.0.0.1", port: 0 });
process.stdout.write(JSON.stringify({ port: app.server.address().port, pid: process.pid }) + "\n");
process.on("SIGTERM", () => { void app.close().then(() => process.exit(0)); });
