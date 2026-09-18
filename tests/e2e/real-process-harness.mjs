import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { request } from 'node:https';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, URL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { localHttpProvider } from '../sdk/local-http-provider.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(new URL('../../apps/server/package.json', import.meta.url));
const WebSocket = require('ws');

export async function until(predicate, label, timeout = 90000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await delay(25);
  }
  throw new Error(`Timed out: ${typeof label === 'function' ? label() : label}`);
}

export class RealProcessHarness {
  children = [];
  workers = new Set();
  sockets = new Set();
  logs = '';

  static async create(t, options = {}) {
    assert.equal(process.platform, 'linux', 'real process E2E requires Linux /proc and SIGKILL');
    const h = new RealProcessHarness();
    h.label = t.name;
    h.root = await mkdtemp(join(tmpdir(), 'pi-r16-'));
    t.after(() => h.close());
    h.project = join(h.root, 'project');
    h.agent = join(h.root, 'agent');
    for (const name of ['project', 'agent', 'home', 'state']) await mkdir(join(h.root, name));
    if (options.extension || options.startupForm) {
      await mkdir(join(h.agent, 'extensions'));
      await cp(join(repo, 'tests/sdk/r16-native-extension.mjs'), join(h.agent, 'extensions/r16-native.js'));
    }
    h.provider = await localHttpProvider();
    await writeFile(join(h.agent, 'models.json'), JSON.stringify({ providers: { 'r16-local': {
      baseUrl: h.provider.baseUrl, api: 'openai-completions', apiKey: 'local-placeholder-not-a-secret',
      models: [{ id: 'deterministic', contextWindow: 128000, maxTokens: 4096 }]
    } } }));
    await writeFile(join(h.agent, 'settings.json'), JSON.stringify({
      defaultProvider: 'r16-local', defaultModel: 'deterministic',
      retry: { enabled: false }, compaction: { enabled: false }
    }));
    const key = join(h.root, 'key.pem'), cert = join(h.root, 'cert.pem');
    const openssl = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'], { encoding: 'utf8' });
    assert.equal(openssl.status, 0, openssl.stderr);
    h.ca = await readFile(cert);
    // Deliberately allowlist the environment: never inherit paid provider keys,
    // NODE_OPTIONS, proxy credentials, or the owner's real pi/home resources.
    h.env = {
      PATH: process.env.PATH, HOME: join(h.root, 'home'), LANG: 'C.UTF-8',
      PI_REMOTE_HOST: '127.0.0.1', PI_REMOTE_PORT: '0',
      PI_REMOTE_STATE_DIR: join(h.root, 'state'), PI_REMOTE_PI_DIR: h.agent,
      PI_REMOTE_WORKSPACE_ROOT: h.project, PI_REMOTE_CURSOR_SECRET: 'r16-local-cursor-secret',
      R16_TLS_KEY: key, R16_TLS_CERT: cert
    };
    if (options.startupForm) h.env.R16_STARTUP_FORM = '1';
    await h.start();
    const pairing = spawnSync(process.execPath, ['apps/server/dist/cli.js', 'pair'], {
      cwd: repo, env: h.env, encoding: 'utf8'
    });
    assert.equal(pairing.status, 0, pairing.stderr);
    const paired = await h.http('POST', '/v1/pair', {
      pairingToken: JSON.parse(pairing.stdout).token, deviceName: 'R16 local client'
    });
    h.token = paired.deviceToken;
    const created = await h.http('POST', '/v1/projects', { name: 'R16 project', rootPath: h.project });
    const session = await h.http('POST', `/v1/projects/${created.project.id}/sessions`, {
      title: 'R16 real SDK', model: { provider: 'r16-local', id: 'deterministic' }
    });
    h.sessionId = session.session.id;
    return h;
  }

  async start() {
    const child = spawn(process.execPath, ['tests/sdk/real-server-entry.mjs'], {
      cwd: repo, env: this.env, stdio: ['ignore', 'pipe', 'pipe']
    });
    this.children.push(child);
    this.main = child;
    let stdout = '';
    child.stdout.on('data', data => { stdout += data; this.logs += data; });
    child.stderr.on('data', data => { this.logs += data; });
    child.on('error', error => { this.logs += String(error); });
    const marker = await until(() => {
      assert.equal(child.exitCode, null, this.logs);
      return stdout.split('\n').filter(Boolean).map(line => {
        try { return JSON.parse(line); } catch { return null; }
      }).find(value => value?.port);
    }, () => `real TLS server startup\n${this.logs}`, 90000);
    assert.equal(marker.pid, child.pid);
    this.url = `https://127.0.0.1:${marker.port}`;
    assert.equal((await this.http('GET', '/healthz')).status, 'ok');
  }

  http(method, path, body, key = randomUUID()) {
    return new Promise((resolve, reject) => {
      const encoded = body === undefined ? undefined : JSON.stringify(body);
      const req = request(this.url + path, { method, ca: this.ca, headers: {
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        'idempotency-key': key,
        ...(encoded ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(encoded) } : {})
      } }, res => {
        let raw = '';
        res.on('data', data => { raw += data; });
        res.on('end', () => {
          try {
            assert.ok(res.statusCode >= 200 && res.statusCode < 300, `${method} ${path}: ${res.statusCode} ${raw}\n${this.logs}`);
            resolve(JSON.parse(raw));
          } catch (error) { reject(error); }
        });
      });
      req.setTimeout(25000, () => req.destroy(new Error(`HTTP timeout ${path}`)));
      req.on('error', reject);
      req.end(encoded);
    });
  }

  command(kind, payload, key) {
    return this.http('POST', `/v1/sessions/${this.sessionId}/commands`, { kind, payload }, key);
  }

  async terminal(commandId, state = 'completed') {
    // Poll the read-only projection to avoid exhausting the real HTTP limiter;
    // assert the public command result once the durable terminal is visible.
    await until(() => {
      assert.equal(this.main.exitCode, null, this.logs);
      const command = this.query('SELECT state FROM commands WHERE id = ?', commandId)[0];
      return ['completed', 'failed', 'unknown', 'cancelled', 'aborted'].includes(command?.state);
    }, () => `command ${commandId} terminal state; logs: ${this.logs}`);
    const value = await this.http('GET', `/v1/commands/${commandId}`);
    assert.equal(value.state, state, JSON.stringify(value) + '\n' + this.logs);
    return value;
  }

  query(sql, ...args) {
    const db = new DatabaseSync(join(this.root, 'state', 'state.sqlite'), { readOnly: true });
    try { return db.prepare(sql).all(...args); } finally { db.close(); }
  }

  async workerPid() {
    const pid = await until(async () => {
      const ids = (await readFile(`/proc/${this.main.pid}/task/${this.main.pid}/children`, 'utf8')).trim().split(/\s+/).filter(Boolean);
      for (const id of ids) {
        try {
          const cmdline = await readFile(`/proc/${id}/cmdline`, 'utf8');
          if (cmdline.includes('/agent-pi/dist/worker.js')) return Number(id);
        } catch { /* Child may have exited during discovery. */ }
      }
      return null;
    }, 'production worker PID from /proc');
    this.workers.add(pid);
    return pid;
  }

  async killMain() {
    const exited = once(this.main, 'exit');
    this.main.kill('SIGKILL');
    const [code, signal] = await exited;
    assert.equal(code, null);
    assert.equal(signal, 'SIGKILL');
  }

  async connect(afterSeq = 0) {
    const { ticket } = await this.http('POST', '/v1/ws-tickets');
    const socket = new WebSocket(this.url.replace('https:', 'wss:') + '/v1/ws', 'pi-remote.v1', { ca: this.ca });
    this.sockets.add(socket);
    const frames = [];
    socket.on('message', raw => frames.push(JSON.parse(raw.toString())));
    await once(socket, 'open');
    socket.send(JSON.stringify({ type: 'authenticate', ticket }));
    await until(() => frames.some(frame => frame.type === 'authenticated'), 'WSS authentication');
    socket.send(JSON.stringify({ type: 'subscribe', sessionId: this.sessionId, afterSeq }));
    await until(() => frames.some(frame => frame.type === 'subscription.ready'), 'WSS replay ready');
    return { socket, frames, events: () => frames.filter(f => f.type === 'event').map(f => f.event) };
  }

  async lines(name) {
    try { return (await readFile(join(this.project, name), 'utf8')).trim().split('\n').filter(Boolean); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }

  async close() {
    if (process.env.R16_EVIDENCE_DIR) {
      await mkdir(process.env.R16_EVIDENCE_DIR, { recursive: true });
      let durable;
      try {
        durable = {
          sessions: this.query('SELECT id, pi_session_id, pi_persistence_state FROM sessions'),
          commands: this.query('SELECT id, kind, state, target_run_id, error_code FROM commands'),
          runs: this.query('SELECT id, command_id, status FROM runs'),
          events: this.query('SELECT session_id, seq, type, run_id, operation_id, payload_json FROM events ORDER BY session_id, seq')
        };
      } catch (error) { durable = { error: String(error) }; }
      await writeFile(join(process.env.R16_EVIDENCE_DIR, this.label.replace(/[^a-zA-Z0-9-]+/g, '-').slice(0, 150) + '.json'),
        JSON.stringify({ label: this.label, logs: this.logs, modelRequests: this.provider?.requests.length, durable }, null, 2));
    }
    for (const socket of this.sockets) socket.terminate();
    // Kill fixture shell process groups using PIDs captured by the test command,
    // including orphan descendants after main/worker death. Never use pkill.
    for (const line of await this.lines('shell-pids')) {
      try { process.kill(-Number(line), 'SIGKILL'); } catch { /* Already gone. */ }
    }
    for (const pid of this.workers) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* Already gone. */ }
    }
    for (const child of this.children) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
      }
    }
    await this.provider?.close();
    await rm(this.root, { recursive: true, force: true });
  }
}
