import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { stageRealProcessRuntime } from './stage-real-process-runtime.mjs';

const cwd = fileURLToPath(new URL('../', import.meta.url));
function run(program, args, directory = cwd) {
  const result = spawnSync(program, args, { cwd: directory, stdio: 'inherit', env: {
    ...process.env, R16_EVIDENCE_DIR: join(cwd, 'test-results/code-review/r16-details')
  } });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${program} exited ${result.status ?? result.signal}`);
}

let stage;
try {
  if (!process.argv.includes('--no-build')) run('pnpm', ['run', 'build:server']);
  let directory = cwd;
  const onWindowsMount = process.platform === 'linux' && /^\/mnt\/[a-z]\//.test(cwd);
  if (process.argv.includes('--stage-linux') || (onWindowsMount && !process.argv.includes('--no-stage'))) {
    // Optional offline native-filesystem copy for WSL /mnt/c import latency.
    stage = await mkdtemp(join(tmpdir(), 'pi-r16-runtime-'));
    await stageRealProcessRuntime(cwd.replace(/\/$/, ''), stage);
    await mkdir(join(cwd, 'test-results/code-review'), { recursive: true });
    await cp(join(stage, 'r16-runtime-manifest.json'), join(cwd, 'test-results/code-review/r16-runtime-manifest.json'));
    directory = stage;
  }
  run(process.execPath, ['--test', '--test-concurrency=1', 'tests/e2e/real-process.test.mjs'], directory);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  if (stage) await rm(stage, { recursive: true, force: true });
}
