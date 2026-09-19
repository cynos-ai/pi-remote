// Real production components, with a longer mapping deadline for WSL imports.
// No worker factory, SDK stream function, IPC transport or recovery substitute.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildServer } from '../../apps/server/dist/index.js';
import { parseEnv } from '../../apps/server/dist/config.js';
import { openServerDatabaseSync } from '../../apps/server/dist/storage/database.js';
import { WorkerManager } from '../../apps/server/dist/runtime/manager.js';
import { installFaultCheckpoints } from './fault-checkpoints.mjs';

const env = parseEnv();
const database = openServerDatabaseSync({ filename: join(env.PI_REMOTE_STATE_DIR, 'state.sqlite') });
const manager = new WorkerManager(database, {
  stateDir: env.PI_REMOTE_STATE_DIR, piDir: env.PI_REMOTE_PI_DIR,
  agentDir: env.PI_REMOTE_PI_DIR, sessionDir: join(env.PI_REMOTE_PI_DIR, 'sessions'),
  mappingTimeoutMs: 60000
});
if (process.env.R16_FAULTS === '1') installFaultCheckpoints(manager, env.PI_REMOTE_STATE_DIR);
manager.start();
const app = buildServer({ env, database, workerManager: manager, logger: true, https: {
  key: await readFile(process.env.R16_TLS_KEY),
  cert: await readFile(process.env.R16_TLS_CERT)
} });
app.addHook('onClose', async () => { await manager.stop(); database.close(); });
await app.listen({ host: env.PI_REMOTE_HOST, port: env.PI_REMOTE_PORT });
process.stdout.write(JSON.stringify({ port: app.server.address().port, pid: process.pid }) + '\n');
process.on('SIGTERM', () => { void app.close().then(() => process.exit(0)); });
