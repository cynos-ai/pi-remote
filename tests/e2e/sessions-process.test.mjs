import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RealProcessHarness, until } from './real-process-harness.mjs';

const history = async path => (await readFile(path, 'utf8')).trim().split('\n').map(JSON.parse);
const mapping = h => h.query('SELECT id, pi_session_id, pi_session_file FROM sessions WHERE id = ?', h.sessionId)[0];

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
