import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RealProcessHarness, until } from './real-process-harness.mjs';

const history = async path => (await readFile(path, 'utf8')).trim().split('\n').map(JSON.parse);
const mapping = h => h.query('SELECT id, pi_session_id, pi_session_file FROM sessions WHERE id = ?', h.sessionId)[0];

test('history recovery API discovers an orphan, imports once and resumes its original context', { timeout: 120000 }, async t => {
  const h = await RealProcessHarness.create(t);
  const initial = await h.command('prompt', { text: 'RECOVER_ORIGINAL_CONTEXT' });
  await h.workerPid();
  await h.terminal(initial.commandId);
  const source = mapping(h);
  const projectId = h.query('SELECT project_id FROM sessions WHERE id = ?', h.sessionId)[0].project_id;
  const rows = await history(source.pi_session_file);
  rows[0].id = randomUUID();
  const orphan = join(h.agent, 'sessions/recovery-orphan.jsonl');
  const original = rows.map(row => JSON.stringify(row)).join('\n') + '\n';
  await writeFile(orphan, original);
  const listed = await h.http('GET', `/v1/projects/${projectId}/recoverable-history`);
  assert.equal(listed.items.length, 1);
  const payload = { candidateId: listed.items[0].candidateId };
  const key = randomUUID();
  const [first, replay] = await Promise.all([
    h.http('POST', `/v1/projects/${projectId}/history-imports`, payload, key),
    h.http('POST', `/v1/projects/${projectId}/history-imports`, payload, key)
  ]);
  assert.deepEqual(first, replay);
  assert.equal(h.provider.requests.length, 1, 'import never dispatches a model task');
  assert.equal(await readFile(orphan, 'utf8'), original);
  assert.equal((await h.http('GET', `/v1/projects/${projectId}/recoverable-history`)).items.length, 0);
  h.sessionId = first.session.id;
  const resumed = await h.command('prompt', { text: 'RECOVER_CONTINUE' });
  await h.workerPid();
  await h.terminal(resumed.commandId);
  assert.equal(mapping(h).pi_session_id, rows[0].id);
  assert.equal(h.provider.requests.length, 2);
  assert.ok(JSON.stringify(h.provider.requests.at(-1).messages).includes('RECOVER_ORIGINAL_CONTEXT'));
  assert.equal(h.query('SELECT COUNT(*) AS count FROM sessions')[0].count, 2);
});

async function armFault(h, point) {
  await writeFile(join(h.root, 'state/fault-arm'), point);
}
async function reachedFault(h, point) {
  return until(async () => {
    try {
      const value = JSON.parse(await readFile(join(h.root, 'state/fault-reached'), 'utf8'));
      return value.point === point ? value.payload : null;
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }, point);
}

test('two phone renames at one version have one winner and native echo does not increment twice', { timeout: 120000 }, async t => {
  const h = await RealProcessHarness.create(t, { extension: true });
  const initial = await h.command('prompt', { text: 'TITLE_SOURCE' });
  await h.workerPid();
  await h.terminal(initial.commandId);
  const source = mapping(h);
  const snapshot = await h.http('GET', `/v1/sessions/${h.sessionId}/snapshot`);
  const replies = await Promise.allSettled(['Phone A', 'Phone B'].map(title => h.http('PATCH', `/v1/sessions/${h.sessionId}`, { expectedVersion: snapshot.session.version, title })));
  assert.equal(replies.filter(reply => reply.status === 'fulfilled').length, 1);
  const rejected = replies.find(reply => reply.status === 'rejected');
  assert.match(rejected.reason.message.split('\n')[0], /409.*VERSION_CONFLICT/);
  const winner = h.query('SELECT title, version FROM sessions WHERE id = ?', h.sessionId)[0];
  assert.equal(winner.version, snapshot.session.version + 1);
  await until(async () => (await history(source.pi_session_file)).filter(item => item.type === 'session_info').at(-1)?.name === winner.title, 'native rename echo');
  // A subsequent command is a barrier after the synchronous SDK rename hook.
  const barrier = await h.command('extension_command', { text: '/r16-title Native Final' });
  await h.terminal(barrier.commandId);
  const final = await until(() => {
    const row = h.query('SELECT title, version FROM sessions WHERE id = ?', h.sessionId)[0];
    return row.title === 'Native Final' ? row : null;
  }, 'later native title');
  assert.equal(final.version, winner.version + 1);
  assert.equal((await history(source.pi_session_file)).filter(item => item.type === 'session_info').at(-1).name, final.title);
  assert.equal(h.provider.requests.length, 1);
});

test('native title written before event commit is recovered after real main SIGKILL', { timeout: 120000 }, async t => {
  const h = await RealProcessHarness.create(t, { extension: true, faults: true });
  const initial = await h.command('prompt', { text: 'TITLE_RECOVERY' });
  await h.workerPid();
  await h.terminal(initial.commandId);
  const source = mapping(h);
  await armFault(h, 'before-title-commit');
  const change = await h.command('extension_command', { text: '/r16-title TITLE_AFTER_CRASH' });
  await reachedFault(h, 'before-title-commit');
  assert.equal((await history(source.pi_session_file)).filter(item => item.type === 'session_info').at(-1).name, 'TITLE_AFTER_CRASH');
  assert.equal(h.query('SELECT title FROM sessions WHERE id = ?', h.sessionId)[0].title, 'R16 real SDK');
  await h.killMain();
  await h.start();
  await h.terminal(change.commandId, 'unknown');
  const resumed = await h.command('prompt', { text: 'AFTER_TITLE_CRASH' });
  await h.workerPid();
  await h.terminal(resumed.commandId);
  assert.equal(h.query('SELECT title FROM sessions WHERE id = ?', h.sessionId)[0].title, 'TITLE_AFTER_CRASH');
  assert.equal(mapping(h).pi_session_id, source.pi_session_id);
  assert.equal(h.provider.requests.length, 2);
});

for (const point of ['before-bound', 'before-bound-ack']) {
  test(`fork SIGKILL at ${point} preserves written history without replaying continuation`, { timeout: 120000 }, async t => {
    const h = await RealProcessHarness.create(t, { extension: true, faults: true });
    const initial = await h.command('prompt', { text: 'FORK_CRASH_SOURCE' });
    await h.workerPid();
    await h.terminal(initial.commandId);
    const source = mapping(h);
    const sourceBytes = await readFile(source.pi_session_file, 'utf8');
    const entry = (await history(source.pi_session_file)).find(item => item.type === 'message' && item.message.role === 'assistant');
    await armFault(h, point);
    const fork = await h.command('extension_command', { text: `/r16-fork ${entry.id}` });
    const checkpoint = await reachedFault(h, point);
    const target = point === 'before-bound' ? { pi_session_file: checkpoint.piSessionFile, pi_session_id: checkpoint.piSessionId }
      : h.query('SELECT id, pi_session_file, pi_session_id FROM sessions WHERE id = ?', checkpoint.appSessionId)[0];
    const targetBytes = await readFile(target.pi_session_file, 'utf8');
    assert.equal(JSON.parse(targetBytes.split('\n')[0]).id, target.pi_session_id);
    assert.ok(!targetBytes.includes('FORK_FIRST'));
    assert.equal(h.query('SELECT COUNT(*) AS count FROM sessions')[0].count, point === 'before-bound' ? 1 : 2);
    assert.equal(h.provider.requests.length, 1);
    await h.killMain();
    await h.start();
    await h.terminal(fork.commandId, 'unknown');
    assert.equal(await readFile(target.pi_session_file, 'utf8'), targetBytes);
    assert.equal(await readFile(source.pi_session_file, 'utf8'), sourceBytes);
    assert.equal(h.query('SELECT COUNT(*) AS count FROM runs')[0].count, 1);
    const filesBefore = (await readdir(join(h.agent, 'sessions'), { recursive: true })).filter(file => file.endsWith('.jsonl')).sort();
    if (point === 'before-bound') {
      // Explicitly reclaim the file; never retry the unknown fork command.
      const imported = await h.command('extension_command', { text: `/r16-switch ${target.pi_session_file}` });
      await h.workerPid();
      await h.terminal(imported.commandId);
      h.sessionId = h.query('SELECT id FROM sessions WHERE pi_session_id = ?', target.pi_session_id)[0].id;
      await until(() => h.query("SELECT id FROM runs WHERE session_id = ? AND status = 'completed'", h.sessionId).length === 1, 'explicit recovery continuation');
    } else {
      h.sessionId = target.id;
      const continued = await h.command('prompt', { text: 'EXPLICIT_FORK_RECOVERY' });
      await h.workerPid();
      await h.terminal(continued.commandId);
    }
    assert.deepEqual((await readdir(join(h.agent, 'sessions'), { recursive: true })).filter(file => file.endsWith('.jsonl')).sort(), filesBefore);
    assert.equal(mapping(h).pi_session_id, target.pi_session_id);
    assert.equal(h.provider.requests.length, 2);
    assert.ok(!JSON.stringify(h.provider.requests).includes('FORK_FIRST'));
    assert.ok(!JSON.stringify(h.provider.requests).includes('FORK_SECOND'));
    assert.equal(h.query('SELECT state FROM commands WHERE id = ?', fork.commandId)[0].state, 'unknown');
  });
}

test('native fork preserves source and assigns two continuation Runs to one cross-session Command', { timeout: 120000 }, async t => {
  const h = await RealProcessHarness.create(t, { extension: true });
  const initial = await h.command('prompt', { text: 'FORK_SOURCE' });
  await h.workerPid();
  await h.terminal(initial.commandId);
  const source = mapping(h);
  const original = await readFile(source.pi_session_file, 'utf8');
  const entry = (await history(source.pi_session_file)).find(item => item.type === 'message' && item.message.role === 'assistant');
  assert.ok(entry?.id);
  const fork = await h.command('extension_command', { text: `/r16-fork ${entry.id}` });
  await h.terminal(fork.commandId);
  const target = await until(() => h.query('SELECT id, pi_session_id, pi_session_file FROM sessions WHERE id <> ?', source.id)[0], 'fork Session mapping');
  h.sessionId = target.id;
  const runs = await until(() => {
    const rows = h.query('SELECT id, command_id, status FROM runs WHERE session_id = ?', target.id);
    return rows.length === 2 && rows.every(row => row.status === 'completed') ? rows : null;
  }, 'two fork continuation Runs');
  assert.deepEqual(runs.map(row => row.command_id), [fork.commandId, fork.commandId]);
  assert.notEqual(runs[0].id, runs[1].id);
  assert.equal(h.query('SELECT session_id FROM commands WHERE id = ?', fork.commandId)[0].session_id, source.id);
  assert.equal(await readFile(source.pi_session_file, 'utf8'), original, 'fork must not write continuation into the source history');
  const destinationHistory = await history(target.pi_session_file);
  assert.equal(destinationHistory[0].id, target.pi_session_id);
  assert.notEqual(target.pi_session_id, source.pi_session_id);
  for (const marker of ['FORK_SOURCE', 'FORK_FIRST', 'FORK_SECOND']) assert.ok(JSON.stringify(destinationHistory).includes(marker));
  const replay = await h.connect();
  for (const marker of ['FORK_FIRST', 'FORK_SECOND']) assert.ok(replay.events().some(event => event.type === 'message.completed' && JSON.stringify(event.payload).includes(marker)));
  assert.equal(h.query('SELECT COUNT(*) AS count FROM runs WHERE session_id = ?', source.id)[0].count, 1);
  await h.killMain();
  await h.start();
  const continued = await h.command('prompt', { text: 'FORK_RESTART' });
  await h.workerPid();
  await h.terminal(continued.commandId);
  assert.equal(mapping(h).pi_session_id, target.pi_session_id);
  assert.equal(h.provider.requests.length, 4);
  assert.ok(JSON.stringify(h.provider.requests.at(-1).messages).includes('FORK_SECOND'));
});

test('native switch imports an unmapped header-only history and synchronizes extension/API titles', { timeout: 120000 }, async t => {
  const h = await RealProcessHarness.create(t, { extension: true });
  const warmup = await h.command('prompt', { text: 'IMPORT_SOURCE' });
  await h.workerPid();
  await h.terminal(warmup.commandId);
  const source = mapping(h);
  const header = (await history(source.pi_session_file))[0];
  const importedId = randomUUID();
  const path = join(h.project, 'synthetic-header-only.jsonl');
  await writeFile(path, JSON.stringify({ ...header, id: importedId }) + '\n');
  const switched = await h.command('extension_command', { text: `/r16-switch ${path}` });
  await h.terminal(switched.commandId);
  const imported = await until(() => h.query('SELECT id FROM sessions WHERE pi_session_id = ?', importedId)[0], 'imported native identity');
  h.sessionId = imported.id;
  await until(() => h.query("SELECT id FROM runs WHERE session_id = ? AND status = 'completed'", imported.id).length === 1, 'import continuation');
  const setTitle = async title => {
    const receipt = await h.command('extension_command', { text: `/r16-title ${title}` });
    await h.terminal(receipt.commandId);
    await until(() => h.query('SELECT title FROM sessions WHERE id = ?', h.sessionId)[0].title === title, 'native title projected');
  };
  await setTitle('Native A');
  const snapshot = await h.http('GET', `/v1/sessions/${h.sessionId}/snapshot`);
  await h.http('PATCH', `/v1/sessions/${h.sessionId}`, { expectedVersion: snapshot.session.version, title: 'Phone B' });
  await until(async () => (await history(path)).filter(item => item.type === 'session_info').at(-1)?.name === 'Phone B', 'phone rename persisted by SDK');
  await setTitle('Native A');
  assert.equal((await history(path)).filter(item => item.type === 'session_info').at(-1).name, 'Native A');
  assert.equal(h.query('SELECT title FROM sessions WHERE id = ?', source.id)[0].title, 'R16 real SDK');
  const importedHistory = JSON.stringify(await history(path));
  assert.ok(importedHistory.includes('WITH_SESSION_SWITCH'));
  assert.ok(!importedHistory.includes('IMPORT_SOURCE'));
  await h.killMain();
  await h.start();
  const resumed = await h.command('prompt', { text: 'IMPORT_RESTART' });
  await h.workerPid();
  await h.terminal(resumed.commandId);
  assert.equal(mapping(h).pi_session_id, importedId);
  assert.equal(h.query('SELECT title FROM sessions WHERE id = ?', h.sessionId)[0].title, 'Native A');
  assert.equal(h.provider.requests.length, 3);
});

test('native switch rejects missing and corrupt history without recreating it or poisoning the source', { timeout: 120000 }, async t => {
  const h = await RealProcessHarness.create(t, { extension: true });
  const initial = await h.command('prompt', { text: 'INTACT_SOURCE' });
  await h.workerPid();
  await h.terminal(initial.commandId);
  const source = mapping(h);
  for (const content of [null, '', '{broken-json\n']) {
    const path = join(h.project, `invalid-${randomUUID()}.jsonl`);
    if (content !== null) await writeFile(path, content);
    const rejected = await h.command('extension_command', { text: `/r16-switch ${path}` });
    // Native extension command dispatch catches handler exceptions and reports
    // them through ExtensionRunner; a completed Command is not import success.
    await h.terminal(rejected.commandId);
    const operationId = h.query("SELECT operation_id FROM events WHERE session_id = ? AND type = 'command.updated' AND operation_id IS NOT NULL AND json_extract(payload_json, '$.commandId') = ? ORDER BY seq DESC LIMIT 1", h.sessionId, rejected.commandId)[0].operation_id;
    assert.ok(operationId);
    await until(() => h.query("SELECT payload_json FROM events WHERE session_id = ? AND operation_id = ? AND type = 'runtime.notice'", h.sessionId, operationId)
      .map(row => JSON.parse(row.payload_json)).some(notice => notice.details?.extensionPath === 'command:r16-switch'
        && notice.details?.event === 'command' && notice.message.includes('Pi session history is invalid:') && notice.message.includes(path)), 'native import failure notice belongs to the rejected command');
    if (content === null) await assert.rejects(readFile(path), { code: 'ENOENT' });
    else assert.equal(await readFile(path, 'utf8'), content);
    assert.deepEqual(mapping(h), source);
    assert.equal(h.query('SELECT COUNT(*) AS count FROM sessions')[0].count, 1);
  }
  const continued = await h.command('prompt', { text: 'AFTER_REJECTED_IMPORT' });
  await h.terminal(continued.commandId);
  assert.equal(h.provider.requests.length, 2);
  assert.ok(JSON.stringify(h.provider.requests.at(-1).messages).includes('INTACT_SOURCE'));
});
