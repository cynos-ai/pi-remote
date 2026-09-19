import { cp, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve, sep } from 'node:path';

/** Copy the installed production dependency graph, offline, preserving package
 * bytes. Useful on WSL where /mnt/c module loading exceeds worker handshake
 * deadlines. No package installation, generated worker, or product rewriting.
 */
export async function stageRealProcessRuntime(repository, destination) {
  const packages = new Map();
  const queue = [join(repository, 'apps/server')];
  async function dependencyPath(from, name) {
    for (let directory = from; ; directory = dirname(directory)) {
      try { return await realpath(join(directory, 'node_modules', name)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (directory === dirname(directory)) return null;
    }
  }
  while (queue.length) {
    const source = queue.shift();
    if (packages.has(source)) continue;
    if (!source.startsWith(repository + sep)) throw new Error(`Dependency outside repository: ${source}`);
    const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
    const dependencies = new Map();
    packages.set(source, dependencies);
    const names = new Set(Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies, ...manifest.optionalDependencies }));
    for (const name of names) {
      const path = await dependencyPath(source, name);
      if (path) { dependencies.set(name, path); queue.push(path); }
      else if (manifest.dependencies?.[name] && !manifest.optionalDependencies?.[name]) {
        throw new Error(`Installed dependency missing: ${manifest.name} -> ${name}`);
      }
    }
  }
  console.log(`Staging ${packages.size} installed production packages on Linux storage`);
  const pending = [...packages];
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (pending.length) {
      const [source, dependencies] = pending.shift();
      const target = join(destination, relative(repository, source));
      await cp(source, target, { recursive: true, filter: path => !relative(source, path).split(sep).includes('node_modules') });
      for (const [name, path] of dependencies) {
        const link = join(target, 'node_modules', name);
        await mkdir(dirname(link), { recursive: true });
        await symlink(relative(dirname(link), join(destination, relative(repository, path))), link);
      }
    }
  }));
  for (const file of ['e2e/real-process.test.mjs', 'e2e/forms-process.test.mjs', 'e2e/sessions-process.test.mjs', 'sdk/forms-extension.mjs', 'e2e/real-process-harness.mjs',
    'sdk/real-server-entry.mjs', 'sdk/fault-checkpoints.mjs', 'sdk/local-http-provider.mjs', 'sdk/r16-native-extension.mjs',
    'sdk/live-server-entry.mjs', 'sdk/live-backend.mjs', 'sdk/live-controls.mjs', 'sdk/live-configuration.mjs', 'sdk/live-defaults.mjs', 'sdk/live-compact.mjs', 'sdk/summary-stream-probe.mjs', 'sdk/live-backend.test.mjs']) {
    const target = resolve(destination, 'tests', file);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(repository, 'tests', file), target);
  }
  await mkdir(join(destination, 'scripts'), { recursive: true });
  await cp(join(repository, 'scripts/acceptance-evidence.mjs'), join(destination, 'scripts/acceptance-evidence.mjs'));
  await cp(join(repository, 'scripts/live-model-selection.mjs'), join(destination, 'scripts/live-model-selection.mjs'));
  const hashes = {};
  for (const file of ['apps/server/dist/index.js', 'apps/server/dist/runtime/manager.js',
    'apps/server/dist/runtime/recovery.js', 'apps/server/dist/services/commands.js',
    'packages/agent-pi/dist/worker.js', 'packages/agent-pi/dist/runtime.js',
    'packages/agent-pi/dist/session-file.js', 'packages/protocol/dist/reducer.js']) {
    const source = createHash('sha256').update(await readFile(join(repository, file))).digest('hex');
    const copied = createHash('sha256').update(await readFile(join(destination, file))).digest('hex');
    if (source !== copied) throw new Error(`Build changed during staging: ${file}; retry after builds settle`);
    hashes[file] = source;
  }
  await writeFile(join(destination, 'r16-runtime-manifest.json'), JSON.stringify({ node: process.version, packages: packages.size, hashes }, null, 2));
}
