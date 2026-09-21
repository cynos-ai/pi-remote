import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile, readdir, rename, mkdir, rmdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { RealProcessHarness, until } from './real-process-harness.mjs';

const history = async path => (await readFile(path, 'utf8')).trim().split('\n').map(JSON.parse);
const mapping = h => h.query('SELECT id, pi_session_id, pi_session_file FROM sessions WHERE id = ?', h.sessionId)[0];

async function treeHarness(t, settings = {}, options = {}) {
  const h = await RealProcessHarness.create(t, { extension: true, ...options });
  await writeFile(join(h.agent, 'keybindings.json'), JSON.stringify({ 'app.session.tree': 'ctrl+alt+t', 'app.message.copy': 'ctrl+alt+c' }));
  const settingsPath = join(h.agent, 'settings.json');
  await writeFile(settingsPath, JSON.stringify({ ...JSON.parse(await readFile(settingsPath, 'utf8')), ...settings }));
  const command = async (kind, payload) => { const receipt = await h.command(kind, payload); await h.workerPid(); await h.terminal(receipt.commandId); return receipt; };
  const extension = text => command('extension_command', { text });
  const snapshot = () => h.http('GET', `/v1/sessions/${h.sessionId}/snapshot`);
  const used = new Set();
  const next = title => until(async () => (await snapshot()).pendingInteractions.find(f => f.title === title && !used.has(f.interactionId)), title, 5000);
  const answer = async (title, response) => {
    const form = await next(title); used.add(form.interactionId);
    const payload = { operationId: form.operationId, interactionId: form.interactionId, response };
    const id = randomUUID(); const receipt = await h.command('respond', payload, id); await h.terminal(receipt.commandId);
    assert.equal((await h.command('respond', payload, id)).commandId, receipt.commandId);
    return form;
  };
  const key = (title, value) => answer(title, { value });
  const combo = async (title, inputTitle, value) => { await key(title, '组合键'); await key(inputTitle, value); };
  const open = async () => { await combo('扩展编辑器', '扩展编辑器输入文本', 'ctrl+alt+t'); return next('会话树'); };
  const search = async value => { await key('会话树', '输入文本'); await key('会话树输入', value); };
  const draft = async () => (await snapshot()).notices.filter(n => n.details?.method === 'setEditorText').at(-1)?.details.args[0];
  const after = async count => until(async () => { const lines = await h.lines('tree-after'); return lines.length >= count ? JSON.parse(lines.at(-1)) : undefined; }, 'native tree event', 5000);
  return { h, command, extension, snapshot, next, answer, key, combo, open, search, draft, after };
}

test('startup trust is answerable before mapping, survives reconnect and gates project resources', { timeout: 120000 }, async t => {
  const { h, snapshot } = await treeHarness(t);
  await mkdir(join(h.project, '.pi', 'extensions'), { recursive: true });
  const marker = join(h.project, 'trust-project-loaded');
  await writeFile(join(h.project, '.pi', 'extensions', 'trusted.js'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'loaded'); export default function() {}`);
  const prompt = await h.command('prompt', { text: 'STARTUP_TRUST' }); await h.workerPid();
  const form = await until(async () => (await snapshot()).pendingInteractions.find(f => f.title.startsWith('Trust project folder?')), 'pre-mapping trust form', 5000);
  assert.equal(form.runId, null); assert.equal(form.origin, 'initialize'); assert.equal(mapping(h).pi_session_id, null);
  await assert.rejects(readFile(marker), { code: 'ENOENT' }); assert.equal(h.provider.requests.length, 0);
  const reconnected = await h.connect();
  assert.ok(reconnected.events().some(event => event.type === 'interaction.requested' && event.payload.interactionId === form.interactionId));
  const payload = { operationId: form.operationId, interactionId: form.interactionId, response: { value: 'Trust (this session only)' } };
  const id = randomUUID(), receipt = await h.command('respond', payload, id);
  await h.terminal(receipt.commandId); assert.equal((await h.command('respond', payload, id)).commandId, receipt.commandId);
  await h.terminal(prompt.commandId);
  assert.equal(await readFile(marker, 'utf8'), 'loaded'); await assert.rejects(readFile(join(h.agent, 'trust.json')), { code: 'ENOENT' });
  assert.equal(h.provider.requests.length, 1);
});

test('startup trust hooks use confirm input and notifications before project code loads', { timeout: 120000 }, async t => {
  const { h, snapshot, answer, next } = await treeHarness(t, { defaultProjectTrust: 'never' });
  await mkdir(join(h.project, '.pi', 'extensions'), { recursive: true });
  const marker = join(h.project, 'trust-hook-project-loaded');
  await writeFile(join(h.project, '.pi', 'extensions', 'trusted.js'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'loaded'); export default function() {}`);
  await writeFile(join(h.agent, 'extensions', 'trust-hook.js'), `export default function(pi) { pi.on('project_trust', async (_event, ctx) => {
    const ok = await ctx.ui.confirm('Startup trust hook', 'Allow project resources?');
    const value = await ctx.ui.input('Startup trust input'); ctx.ui.notify('startup-trust-hook-finished');
    return { trusted: ok && value === 'allow' ? 'yes' : 'no', remember: true };
  }); }`);
  const prompt = await h.command('prompt', { text: 'STARTUP_HOOK' }); await h.workerPid();
  const form = await next('Startup trust hook'); assert.equal(form.runId, null);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
  await answer('Startup trust hook', { confirmed: true }); await answer('Startup trust input', { value: 'allow' });
  await h.terminal(prompt.commandId);
  assert.equal(JSON.parse(await readFile(join(h.agent, 'trust.json'), 'utf8'))[h.project], true);
  assert.equal(await readFile(marker, 'utf8'), 'loaded');
  assert.ok((await snapshot()).notices.some(n => n.message === 'startup-trust-hook-finished'));
  assert.equal(h.provider.requests.length, 1);
});

test('startup trust cancellation skips project resources and permits the requested conversation', { timeout: 120000 }, async t => {
  const { h, snapshot } = await treeHarness(t);
  await mkdir(join(h.project, '.pi'), { recursive: true });
  await writeFile(join(h.project, '.pi', 'SYSTEM.md'), 'PRIVATE_PROJECT_CONTEXT_NOT_TRUSTED');
  const prompt = await h.command('prompt', { text: 'TRUST_CANCEL_CONTINUE' }); await h.workerPid();
  const form = await until(async () => (await snapshot()).pendingInteractions.find(f => f.title.startsWith('Trust project folder?')), 'cancel trust form', 5000);
  const answer = await h.command('respond', { operationId: form.operationId, interactionId: form.interactionId, response: { cancelled: true } });
  await h.terminal(answer.commandId); await h.terminal(prompt.commandId);
  assert.ok(!JSON.stringify(h.provider.requests).includes('PRIVATE_PROJECT_CONTEXT_NOT_TRUSTED'));
  assert.equal(h.provider.requests.length, 1); await assert.rejects(readFile(join(h.agent, 'trust.json')), { code: 'ENOENT' });
});

test('editor trust saves native decisions without interrupting generation and invalidates closed menus', { timeout: 120000 }, async t => {
  const { h, extension, next, key, snapshot } = await treeHarness(t);
  const active = await h.command('prompt', { text: 'HOLD_MODEL' });
  await until(() => h.provider.requests.length === 1, 'active trust test model', 5000);
  await extension('/r16-editor');
  const open = async () => { await extension('/r16-editor-draft /trust'); await key('扩展编辑器', 'Enter'); return next('项目信任'); };
  const file = join(h.agent, 'trust.json');
  const menu = await open(); assert.equal(menu.runId, null);
  await open();
  assert.equal((await snapshot()).pendingInteractions.filter(f => f.title === '项目信任').length, 1);
  await key('项目信任', 'Esc'); await assert.rejects(readFile(file), { code: 'ENOENT' });
  await open(); await key('项目信任', '↓'); await key('项目信任', '↓'); await key('项目信任', 'Enter');
  await until(async () => JSON.parse(await readFile(file, 'utf8'))[h.project] === false, 'untrusted saved', 5000);
  await open(); await key('项目信任', '↑'); await key('项目信任', 'Enter');
  const saved = await until(async () => { const value = JSON.parse(await readFile(file, 'utf8')); return value[dirname(h.project)] === true && value; }, 'parent trust saved', 5000);
  assert.equal(saved[h.project], undefined);
  assert.equal(h.query('SELECT status FROM runs WHERE id = ?', active.runId)[0].status, 'running');
  assert.equal(h.provider.requests.length, 1);
  const stale = await open();
  await extension('/r16-editor-draft /quit'); await key('扩展编辑器', 'Enter');
  await until(async () => !(await snapshot()).pendingInteractions.some(f => f.title === '项目信任'), 'trust menu closed with editor', 5000);
  await assert.rejects(h.command('respond', { operationId: stale.operationId, interactionId: stale.interactionId, response: { value: 'Enter' } }), /INTERACTION_CLOSED/);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), saved);
  const stop = await h.command('abort', { targetRunId: active.runId }); await h.terminal(stop.commandId); await h.terminal(active.commandId, 'cancelled');
});

test('editor trust persistence failure fails its operation and preserves the draft', { timeout: 120000 }, async t => {
  const { h, command, extension, next, key, draft } = await treeHarness(t);
  await command('prompt', { text: 'TRUST_SAVE_FAILURE' }); await extension('/r16-editor');
  await extension('/r16-editor-draft /trust'); await key('扩展编辑器', 'Enter');
  const menu = await next('项目信任');
  await mkdir(join(h.agent, 'trust.json'));
  await key('项目信任', 'Enter');
  await until(() => h.query("SELECT 1 FROM events WHERE operation_id = ? AND type = 'operation.updated' AND json_extract(payload_json, '$.status') = 'failed'", menu.operationId).length, 'trust operation failed', 5000);
  await until(async () => await draft() === '/trust', 'trust failure draft', 5000);
  assert.equal(h.provider.requests.length, 1);
});

test('editor clone includes the current leaf and preserves source history without prompting', { timeout: 120000 }, async t => {
  const { h, command, extension, key } = await treeHarness(t);
  await command('prompt', { text: 'CLONE_FIRST' }); await command('prompt', { text: 'CLONE_LAST' });
  const source = mapping(h), original = await readFile(source.pi_session_file, 'utf8');
  const leaf = (await history(source.pi_session_file)).at(-1);
  await extension('/r16-editor'); await extension('/r16-editor-draft /clone'); await key('扩展编辑器', 'Enter');
  const destination = await until(() => h.query('SELECT id, pi_session_file FROM sessions WHERE id != ? AND pi_session_file IS NOT NULL', source.id)[0], 'clone mapping', 5000);
  assert.equal(await readFile(source.pi_session_file, 'utf8'), original);
  assert.ok((await history(destination.pi_session_file)).some(row => row.id === leaf.id), 'clone includes current leaf');
  assert.equal(h.provider.requests.length, 2);
  h.sessionId = destination.id; await command('prompt', { text: 'CLONE_CONTINUE' });
  assert.ok(JSON.stringify(h.provider.requests.at(-1)).includes('CLONE_LAST'));
});

test('editor import confirms, validates and maps copied history to its native identity', { timeout: 120000 }, async t => {
  const { h, command, extension, next, answer, key } = await treeHarness(t);
  await command('prompt', { text: 'IMPORT_SOURCE' }); const source = mapping(h);
  const entries = await history(source.pi_session_file), id = randomUUID();
  const input = join(h.project, 'external history.jsonl');
  const content = entries.map(row => JSON.stringify(row.type === 'session' ? { ...row, id } : row)).join('\n') + '\n';
  await writeFile(input, content); await extension('/r16-editor');
  const open = async path => { await extension(`/r16-editor-draft /import "${path}"`); await key('扩展编辑器', 'Enter'); return next('导入会话'); };
  await open(input); await answer('导入会话', { confirmed: false });
  assert.equal(h.query('SELECT COUNT(*) AS n FROM sessions')[0].n, 1);
  await open(input); await answer('导入会话', { confirmed: true });
  const destination = await until(() => h.query('SELECT id, pi_session_file FROM sessions WHERE pi_session_id = ?', id)[0], () => `import mapping: ${JSON.stringify(h.query("SELECT payload_json FROM events WHERE type = 'runtime.notice' ORDER BY seq DESC LIMIT 8"))}`, 5000);
  assert.notEqual(destination.pi_session_file, input); assert.equal(await readFile(input, 'utf8'), content);
  assert.equal((await history(destination.pi_session_file))[0].id, id);
  assert.equal(h.provider.requests.length, 1);
  h.sessionId = destination.id; await command('prompt', { text: 'IMPORT_CONTINUE' });
  assert.ok(JSON.stringify(h.provider.requests.at(-1)).includes('IMPORT_SOURCE'));
  const previous = mapping(h), previousContent = await readFile(previous.pi_session_file, 'utf8');
  await extension('/r16-editor'); await open(input); await answer('导入会话', { confirmed: true });
  await until(() => mapping(h).pi_session_file !== previous.pi_session_file, 'same-id import rebinds copied file', 5000);
  assert.equal(mapping(h).id, destination.id); assert.equal(mapping(h).pi_session_id, id);
  assert.equal(await readFile(previous.pi_session_file, 'utf8'), previousContent);
  assert.equal(h.provider.requests.length, 2, 're-import does not replay model input');
});

test('editor import rejects corrupt and missing-cwd histories without replacing the source', { timeout: 120000 }, async t => {
  const { h, command, extension, next, answer, key, draft } = await treeHarness(t);
  await command('prompt', { text: 'IMPORT_VALID_SOURCE' }); const source = mapping(h), pid = await h.workerPid();
  const entries = await history(source.pi_session_file); await extension('/r16-editor');
  for (const [name, content] of [['corrupt.jsonl', JSON.stringify(entries[0]) + '\ninvalid'], ['missing-cwd.jsonl', JSON.stringify({ ...entries[0], id: randomUUID(), cwd: join(h.project, 'missing') }) + '\n']]) {
    const input = join(h.project, name); await writeFile(input, content);
    const text = `/import "${input}"`; await extension(`/r16-editor-draft ${text}`); await key('扩展编辑器', 'Enter'); await next('导入会话'); await answer('导入会话', { confirmed: true });
    await until(async () => await draft() === text, 'failed import draft', 5000);
    assert.deepEqual(mapping(h), source); assert.equal(await readFile(input, 'utf8'), content); assert.equal(await h.workerPid(), pid);
  }
  await command('prompt', { text: 'IMPORT_SOURCE_STILL_WORKS' });
});

test('reload resets old UI, loads fresh resources and keeps new hook forms answerable', { timeout: 120000 }, async t => {
  const { h, command, extension, snapshot, next, answer, key, combo } = await treeHarness(t);
  await command('prompt', { text: 'RELOAD_SOURCE' }); const source = mapping(h);
  await extension('/r16-surface'); await extension('/r16-editor');
  await writeFile(join(h.agent, 'extensions', 'reload-new.js'), `export default function(pi) {
    pi.registerCommand('after-reload', { description: 'Fresh command', handler: async (_args, ctx) => { pi.setSessionName('Reloaded command'); ctx.ui.notify('new resource executed'); } });
    pi.on('session_start', async (event, ctx) => { if (event.reason === 'reload') { await ctx.ui.confirm('reload-new-form', 'Continue reload?'); ctx.ui.setStatus('reload-test', 'fresh'); } });
  }`);
  await writeFile(join(h.agent, 'keybindings.json'), JSON.stringify({ 'app.message.copy': 'ctrl+alt+y' }));
  await extension('/r16-editor-draft /reload'); await key('扩展编辑器', 'Enter');
  const form = await next('reload-new-form').catch(error => { throw new Error(`${error.message}: ${JSON.stringify(h.query("SELECT payload_json FROM events WHERE type = 'runtime.notice' ORDER BY seq DESC LIMIT 12"))}`); }); assert.equal(form.runId, null);
  await next('扩展编辑器'); await answer('reload-new-form', { confirmed: true });
  await until(async () => (await snapshot()).notices.some(n => n.message.startsWith('已重载扩展')), 'reload completed', 5000);
  assert.deepEqual(mapping(h), source);
  for (const method of ['setHeader', 'setFooter']) assert.equal((await snapshot()).notices.filter(n => n.details?.method === method).at(-1).details.args[0], null);
  await combo('扩展编辑器', '扩展编辑器输入文本', 'ctrl+alt+y'); await next('复制最后回复'); await answer('复制最后回复', { cancelled: true });
  await extension('/r16-editor-draft /after-reload'); await key('扩展编辑器', 'Enter');
  await until(() => h.query('SELECT title FROM sessions WHERE id = ?', h.sessionId)[0].title === 'Reloaded command', 'new extension command executed', 5000);
  const active = await h.command('prompt', { text: 'HOLD_MODEL' }); await until(() => h.provider.requests.length === 2, 'active reload guard', 5000);
  await extension('/r16-editor-draft /reload'); await key('扩展编辑器', 'Enter');
  await until(async () => (await snapshot()).notices.some(n => n.message.includes('原生前置条件')), 'native reload streaming guard', 5000);
  assert.equal(h.query('SELECT status FROM runs WHERE id = ?', active.runId)[0].status, 'running');
  const stop = await h.command('abort', { targetRunId: active.runId }); await h.terminal(stop.commandId); await h.terminal(active.commandId, 'cancelled');
});

test('editor information, title, copy and exports stay local and preserve failure drafts', { timeout: 120000 }, async t => {
  const { h, command, extension, snapshot, next, answer, key, combo, draft } = await treeHarness(t);
  await command('prompt', { text: 'BUILTIN_SOURCE' }); await extension('/r16-editor');
  const submit = async text => { await extension(`/r16-editor-draft ${text}`); await key('扩展编辑器', 'Enter'); };
  await submit('/name Native command title');
  await until(() => h.query('SELECT title FROM sessions WHERE id = ?', h.sessionId)[0].title === 'Native command title', 'native title synced', 5000);
  await submit('/session'); const info = await next('会话信息'); assert.equal(info.runId, null);
  const frame = () => h.query("SELECT payload_json FROM events WHERE operation_id = ? AND type = 'runtime.notice' AND json_extract(payload_json, '$.details.method') = 'custom.render' ORDER BY seq DESC LIMIT 1", info.operationId).map(row => JSON.parse(row.payload_json))[0];
  assert.ok(JSON.stringify(frame()).includes('Native command title'));
  await key('会话信息', 'End'); await key('会话信息', 'Esc');
  await submit('/hotkeys'); await next('会话信息'); await key('会话信息', 'End'); await key('会话信息', 'Enter');
  await submit('/changelog'); await next('会话信息'); await key('会话信息', 'Page Down'); await key('会话信息', 'Esc');
  await submit('/copy'); const copy = await next('复制最后回复'); assert.equal(copy.runId, null);
  assert.equal(copy.prefill, 'local-stream-complete'); await answer('复制最后回复', { cancelled: true });
  await combo('扩展编辑器', '扩展编辑器输入文本', 'ctrl+alt+c'); await next('复制最后回复'); await answer('复制最后回复', { cancelled: true });
  await submit('/export "builtin history.jsonl"');
  await until(async () => (await h.lines('builtin history.jsonl')).length > 1, 'JSONL export', 5000);
  assert.ok((await h.lines('builtin history.jsonl')).map(JSON.parse).some(row => row.message?.role === 'assistant'));
  await submit('/export "builtin history.html"');
  await until(async () => (await h.lines('builtin history.html')).join('\n').includes('<!DOCTYPE html>'), 'HTML export', 5000);
  await submit('/export /dev/null/fail.jsonl');
  await until(async () => await draft() === '/export /dev/null/fail.jsonl', 'export failure draft preserved', 5000);
  await submit('/login');
  await until(async () => (await snapshot()).notices.some(n => n.message.includes('provider 鉴权') && n.message.includes('文本已保留')), 'specific pending command diagnostic', 5000);
  assert.equal(h.provider.requests.length, 1, 'builtin information and exports never prompt the model');
});

test('remote quit and native exit keys close the editor without stopping a running model', { timeout: 120000 }, async t => {
  const { h, extension, snapshot, next, key, combo } = await treeHarness(t);
  const active = await h.command('prompt', { text: 'HOLD_MODEL' });
  await until(() => h.provider.requests.length === 1, 'active model before remote exit', 5000);
  for (const exit of ['slash', 'ctrl+d', 'double-clear']) {
    await extension('/r16-editor'); await extension('/r16-editor-draft');
    const stale = await next('扩展编辑器');
    if (exit === 'slash') { await extension('/r16-editor-draft /quit'); await key('扩展编辑器', 'Enter'); }
    else if (exit === 'ctrl+d') await combo('扩展编辑器', '扩展编辑器输入文本', 'ctrl+d');
    else { await combo('扩展编辑器', '扩展编辑器输入文本', 'ctrl+c'); await combo('扩展编辑器', '扩展编辑器输入文本', 'ctrl+c'); }
    await until(async () => !(await snapshot()).pendingInteractions.some(f => f.title === '扩展编辑器'), 'editor exited', 5000);
    assert.equal(h.query('SELECT status FROM runs WHERE id = ?', active.runId)[0].status, 'running');
    await assert.rejects(h.command('respond', { operationId: stale.operationId, interactionId: stale.interactionId, response: { value: 'Enter' } }), /INTERACTION_CLOSED/);
  }
  assert.equal(h.provider.requests.length, 1);
  const stop = await h.command('abort', { targetRunId: active.runId }); await h.terminal(stop.commandId); await h.terminal(active.commandId, 'cancelled');
});

test('editor compact uses native compaction and reports empty-history failure', { timeout: 120000 }, async t => {
  const { h, command, extension, snapshot, key, draft } = await treeHarness(t, { compaction: { enabled: false, keepRecentTokens: 1 } });
  await extension('/r16-editor'); await extension('/r16-editor-draft /compact'); await key('扩展编辑器', 'Enter');
  await until(async () => await draft() === '/compact', 'empty compaction failure retains draft', 5000);
  assert.equal(h.provider.requests.length, 0);
  await command('prompt', { text: 'COMPACT_FIRST' }); await command('prompt', { text: 'COMPACT_SECOND' });
  await extension('/r16-editor-draft /compact preserve marker'); await key('扩展编辑器', 'Enter');
  await until(async () => (await snapshot()).notices.some(n => n.message === '手动压缩已完成'), 'native editor compaction', 5000);
  assert.ok((await history(mapping(h).pi_session_file)).some(row => row.type === 'compaction'));
});

test('native scoped models apply without saving, explicitly persist and release stale menus', { timeout: 120000 }, async t => {
  const { h, extension, snapshot, next, key, combo } = await treeHarness(t, {}, { editorModels: true });
  await extension('/r16-editor');
  const settings = async () => JSON.parse(await readFile(join(h.agent, 'settings.json'), 'utf8'));
  const open = async () => { await extension('/r16-editor-draft /scoped-models'); await key('扩展编辑器', 'Enter'); return next('模型范围'); };
  await open(); await key('模型范围', '输入文本'); await key('模型范围输入', 'deterministic'); await key('模型范围', 'Enter');
  assert.equal((await settings()).enabledModels, undefined, 'selection alone does not persist');
  await key('模型范围', 'Esc');
  await combo('扩展编辑器', '扩展编辑器输入文本', 'ctrl+p');
  assert.equal((await snapshot()).session.model.id, 'deterministic', 'native single-model scope does not cycle or force-switch the current model');
  await extension('/r16-editor-draft /model reasoned'); await key('扩展编辑器', 'Enter');
  await until(async () => (await snapshot()).session.model.id === 'reasoned', 'explicit scoped model selected', 5000);
  await combo('扩展编辑器', '扩展编辑器输入文本', 'ctrl+p');
  assert.equal((await snapshot()).session.model.id, 'reasoned', 'excluded model stays outside cycling');
  await open(); await combo('模型范围', '模型范围输入', 'ctrl+s');
  await until(async () => (await settings()).enabledModels?.join() === 'r16-local/reasoned', 'explicit scope saved', 5000);
  await combo('模型范围', '模型范围输入', 'ctrl+x'); await combo('模型范围', '模型范围输入', 'ctrl+s');
  await until(async () => (await settings()).enabledModels?.length === 0, 'explicit empty scope saved', 5000);
  await key('模型范围', 'Esc'); await combo('扩展编辑器', '扩展编辑器输入文本', 'ctrl+p');
  await until(async () => (await snapshot()).session.model.id === 'deterministic', 'empty scope means unrestricted native cycling', 5000);
  await open(); await combo('模型范围', '模型范围输入', 'ctrl+a'); await combo('模型范围', '模型范围输入', 'ctrl+s');
  await until(async () => (await settings()).enabledModels === undefined, 'all enabled clears persisted patterns', 5000);
  const stale = await next('模型范围'); await extension('/r16-editor-clear');
  await until(async () => !(await snapshot()).pendingInteractions.some(f => f.interactionId === stale.interactionId), 'scope menu closed with editor', 5000);
  await assert.rejects(h.command('respond', { operationId: stale.operationId, interactionId: stale.interactionId, response: { value: 'Enter' } }), /INTERACTION_CLOSED/);
  assert.equal(h.provider.requests.length, 0);
  assert.equal(h.query('SELECT COUNT(*) AS count FROM runs')[0].count, 0);
});

test('scoped models remain usable during streaming and report actual save failures', { timeout: 120000 }, async t => {
  const { h, extension, snapshot, next, answer, key, combo } = await treeHarness(t, {}, { editorModels: true });
  await extension('/r16-editor');
  const active = await h.command('prompt', { text: 'HOLD_MODEL' });
  await until(() => h.provider.requests.length === 1, 'active model before scope change', 5000);
  await extension('/r16-editor-draft /scoped-models'); await key('扩展编辑器', 'Enter');
  const menu = await next('模型范围'); assert.equal(menu.origin, 'configure'); assert.equal(menu.runId, null);
  await key('模型范围', '输入文本'); await key('模型范围输入', 'deterministic'); await key('模型范围', 'Enter');
  const path = join(h.agent, 'settings.json'), backup = join(h.agent, 'settings.saved');
  await rename(path, backup); await mkdir(path);
  try {
    await combo('模型范围', '模型范围输入', 'ctrl+s');
    await until(async () => (await snapshot()).notices.some(n => n.message.includes('模型范围保存失败')), 'scope write failure', 5000);
    assert.ok(!(await snapshot()).notices.some(n => n.message === '模型范围已保存'));
    await answer('模型范围', { cancelled: true });
    await until(() => h.query("SELECT seq FROM events WHERE operation_id = ? AND type = 'operation.updated' AND json_extract(payload_json, '$.status') = 'failed'", menu.operationId).length, 'failed scope operation', 5000);
  } finally { await rmdir(path); await rename(backup, path); }
  assert.equal(h.query('SELECT status FROM runs WHERE id = ?', active.runId)[0].status, 'running');
  assert.equal(h.provider.requests.length, 1);
  await key('扩展编辑器', 'Esc'); await h.terminal(active.commandId, 'cancelled');
});

test('native settings persist changes, update active editor and reject unsupported rendering controls', { timeout: 120000 }, async t => {
  const { h, command, extension, snapshot, next, answer, key, combo, draft } = await treeHarness(t);
  await command('prompt', { text: 'SETTINGS_SOURCE' }); await extension('/r16-editor');
  const settings = async () => JSON.parse(await readFile(join(h.agent, 'settings.json'), 'utf8'));
  const open = async () => { await extension('/r16-editor-draft /settings'); await key('扩展编辑器', 'Enter'); return next('设置'); };
  const search = async value => { await combo('设置', '设置输入', 'ctrl+u'); await key('设置', '输入文本'); await key('设置输入', value); };
  const change = async label => { await search(label); await key('设置', 'Enter'); };
  const initial = await settings();
  await open(); await extension('/r16-editor-draft KEEP_SETTINGS_DRAFT');
  await change('Auto-compact'); await until(async () => (await settings()).compaction.enabled === true, 'auto compact persisted', 5000);
  await change('Editor padding'); await until(async () => (await settings()).editorPaddingX !== undefined, 'editor padding persisted', 5000);
  await change('Autocomplete max items'); await until(async () => (await settings()).autocompleteMaxVisible !== undefined, 'completion layout persisted', 5000);
  await change('Double escape'); await until(async () => (await settings()).doubleEscapeAction !== undefined, 'double Escape setting persisted', 5000);
  await change('Hide thinking');
  await until(() => h.query("SELECT seq FROM events WHERE type = 'runtime.notice' AND json_extract(payload_json, '$.message') LIKE '%尚未接入%未修改%' ").length, 'unsupported setting diagnostic', 5000);
  assert.equal((await settings()).hideThinkingBlock, initial.hideThinkingBlock);
  await search('Warnings'); await key('设置', 'Enter'); await key('设置', 'Enter'); await key('设置', 'Esc');
  assert.deepEqual((await settings()).warnings, initial.warnings);
  const latestSettingsFrame = h.query("SELECT payload_json FROM events WHERE type = 'runtime.notice' AND json_extract(payload_json, '$.details.method') = 'custom.render' ORDER BY seq DESC")
    .map(row => JSON.parse(row.payload_json)).find(p => JSON.stringify(p.details.args).includes('Warnings'));
  assert.ok(JSON.stringify(latestSettingsFrame).includes('待适配'), 'nested pending settings must not display as applied');
  assert.equal(await draft(), 'KEEP_SETTINGS_DRAFT');
  const replay = await h.connect();
  assert.ok(replay.events().some(e => e.type === 'runtime.notice' && e.payload.details?.method === 'custom.render' && JSON.stringify(e.payload.details.args).includes('待适配')));
  await answer('设置', { cancelled: true });
  assert.equal((await settings()).compaction.enabled, true, 'closing settings does not roll back changes');
  await extension('/r16-editor-draft'); await key('扩展编辑器', 'Esc'); await key('扩展编辑器', 'Esc');
  const action = (await settings()).doubleEscapeAction;
  if (action !== 'none') { const title = action === 'fork' ? '分叉会话' : '会话树'; await next(title); await key(title, 'Esc'); }
  await open(); const stale = await next('设置'); await extension('/r16-editor-clear');
  await until(async () => !(await snapshot()).pendingInteractions.some(f => f.interactionId === stale.interactionId), 'settings closed with editor', 5000);
  await assert.rejects(h.command('respond', { operationId: stale.operationId, interactionId: stale.interactionId, response: { value: 'Enter' } }), /INTERACTION_CLOSED/);
  assert.equal(h.provider.requests.length, 1);
});

test('settings per-model thinking override applies during streaming and can be cleared', { timeout: 120000 }, async t => {
  const { h, extension, snapshot, next, answer, key } = await treeHarness(t, { defaultThinkingLevel: 'medium' }, { editorModels: true });
  await extension('/r16-editor'); await extension('/r16-editor-draft /model reasoned'); await key('扩展编辑器', 'Enter');
  await until(async () => (await snapshot()).session.model.id === 'reasoned', 'settings reasoning model', 5000);
  const active = await h.command('prompt', { text: 'HOLD_MODEL' }); await until(() => h.provider.requests.length === 1, 'active settings response', 5000);
  await extension('/r16-editor-draft /settings'); await key('扩展编辑器', 'Enter');
  await next('设置'); await key('设置', '输入文本'); await key('设置输入', 'Default thinking level per model'); await key('设置', 'Enter');
  await key('设置', 'Enter'); await key('设置', '↓'); await key('设置', '↓'); await key('设置', 'Enter');
  const settings = async () => JSON.parse(await readFile(join(h.agent, 'settings.json'), 'utf8'));
  await until(async () => (await settings()).modelThinkingLevels?.['r16-local/reasoned'] === 'low', 'model override saved', 5000);
  await until(async () => (await snapshot()).session.thinkingLevel === 'low', 'model override applied', 5000);
  await key('设置', 'Enter'); await key('设置', '↑'); await key('设置', '↑'); await key('设置', '↑'); await key('设置', 'Enter');
  await until(async () => (await settings()).modelThinkingLevels?.['r16-local/reasoned'] === undefined, 'model override removed', 5000);
  await until(async () => (await snapshot()).session.thinkingLevel === 'medium', 'global default restored', 5000);
  assert.equal(h.query('SELECT status FROM runs WHERE id = ?', active.runId)[0].status, 'running');
  await answer('设置', { cancelled: true }); await key('扩展编辑器', 'Esc'); await h.terminal(active.commandId, 'cancelled');
  assert.equal(h.provider.requests.length, 1);
});

test('settings persistence failure is reported without claiming a successful save', { timeout: 120000 }, async t => {
  const { h, extension, snapshot, next, answer, key } = await treeHarness(t);
  await extension('/r16-editor'); await extension('/r16-editor-draft /settings'); await key('扩展编辑器', 'Enter');
  const menu = await next('设置');
  const path = join(h.agent, 'settings.json'), backup = join(h.agent, 'settings.saved');
  await rename(path, backup); await mkdir(path);
  try {
    await key('设置', 'Enter');
    await until(async () => (await snapshot()).notices.some(n => n.message.includes('设置保存失败')), 'settings write failure', 5000);
    assert.ok(!(await snapshot()).notices.some(n => n.message === '设置已保存'));
    await answer('设置', { cancelled: true });
    await until(() => h.query("SELECT seq FROM events WHERE operation_id = ? AND type = 'operation.updated' AND json_extract(payload_json, '$.status') = 'failed'", menu.operationId).length, 'failed settings operation', 5000);
  } finally { await rmdir(path); await rename(backup, path); }
  assert.equal(h.provider.requests.length, 0);
});

test('thinking slash and native selector preserve defaults, capability checks and asynchronous hooks', { timeout: 120000 }, async t => {
  const { h, extension, snapshot, next, answer, key, combo, draft } = await treeHarness(t, {}, { editorModels: true });
  await writeFile(join(h.agent, 'keybindings.json'), JSON.stringify({ 'app.thinking.save': 'ctrl+alt+s' }));
  const settingsPath = join(h.agent, 'settings.json'), original = await readFile(settingsPath, 'utf8');
  await extension('/r16-editor');
  const submit = async text => { await extension(`/r16-editor-draft ${text}`); await key('扩展编辑器', 'Enter'); };
  const level = async () => (await snapshot()).session.thinkingLevel;
  const search = async text => { await key('思考等级', '输入文本'); await key('思考等级输入', text); };
  await submit('/thinking high');
  await until(async () => (await snapshot()).notices.some(n => n.message.includes('未知思考等级') && n.message.includes('off')), 'unsupported thinking diagnostic', 5000);
  assert.equal(await level(), 'off'); assert.equal(await draft(), '');
  await submit('/model reasoned');
  await until(async () => (await snapshot()).session.model.id === 'reasoned', 'reasoning model', 5000);
  await submit('/thinking HIGH'); await until(async () => await level() === 'high', 'explicit thinking reference', 5000);
  assert.equal(await readFile(settingsPath, 'utf8'), original);
  await submit('/thinking nonsense');
  await until(async () => (await snapshot()).notices.some(n => n.message.includes('nonsense') && n.message.includes('可用等级')), 'invalid level diagnostic', 5000);
  assert.equal(await level(), 'high');
  await submit('/thinking'); await search('low'); await key('思考等级', 'Enter');
  await until(async () => await level() === 'low', 'normal menu choice', 5000);
  assert.equal(await readFile(settingsPath, 'utf8'), original);
  await submit('/thinking'); await search('high');
  await combo('思考等级', '思考等级输入', 'ctrl+alt+s');
  await until(async () => JSON.parse(await readFile(settingsPath, 'utf8')).defaultThinkingLevel === 'high', 'explicit saved default', 5000);
  const active = await h.command('prompt', { text: 'HOLD_MODEL' });
  await until(() => h.provider.requests.length === 1, 'active thinking menu response', 5000);
  await submit('/thinking');
  await extension('/r16-editor-draft KEEP_DRAFT'); await key('思考等级', 'Esc');
  assert.equal(await draft(), 'KEEP_DRAFT');
  assert.equal(h.query('SELECT status FROM runs WHERE id = ?', active.runId)[0].status, 'running');
  await extension('/r16-config-hooks thinking'); await submit('/thinking low');
  const first = await next('editor-thinking-first'); assert.equal(first.origin, 'configure'); assert.equal(first.runId, null);
  await answer('editor-thinking-first', { confirmed: true });
  const second = await next('editor-thinking-second'); assert.equal(second.runId, null);
  assert.notEqual(second.operationId, active.operationId);
  await key('editor-thinking-second', 'thinking-menu-hook');
  await until(async () => (await h.lines('editor-thinking-hooks')).length === 1, 'thinking hook completed', 5000);
  await extension('/r16-config-hooks off');
  await submit('/thinking'); const stale = await next('思考等级');
  await extension('/r16-editor-clear');
  await until(async () => !(await snapshot()).pendingInteractions.some(f => f.interactionId === stale.interactionId), 'thinking menu closes with editor', 5000);
  await assert.rejects(h.command('respond', { operationId: stale.operationId, interactionId: stale.interactionId, response: { value: 'Enter' } }), /INTERACTION_CLOSED/);
  const stop = await h.command('abort', { targetRunId: active.runId }); await h.terminal(stop.commandId); await h.terminal(active.commandId, 'cancelled');
  assert.equal(JSON.parse(await readFile(settingsPath, 'utf8')).defaultThinkingLevel, 'high');
  assert.equal(h.provider.requests.length, 1);
});

test('thinking menu uses SDK clamping if model capabilities change while it is open', { timeout: 120000 }, async t => {
  const { h, extension, snapshot, next, key } = await treeHarness(t, {}, { editorModels: true });
  await extension('/r16-editor');
  const submit = async text => { await extension(`/r16-editor-draft ${text}`); await key('扩展编辑器', 'Enter'); };
  await submit('/model reasoned'); await until(async () => (await snapshot()).session.model.id === 'reasoned', 'reasoned model', 5000);
  await submit('/thinking'); await key('思考等级', '输入文本'); await key('思考等级输入', 'high');
  await submit('/model deterministic'); await until(async () => (await snapshot()).session.model.id === 'deterministic', 'changed model while menu open', 5000);
  await next('思考等级'); await key('思考等级', 'Enter');
  await until(async () => (await snapshot()).notices.some(n => n.message === '思考等级：off'), 'native thinking clamp', 5000);
  assert.equal((await snapshot()).session.thinkingLevel, 'off');
  assert.equal(JSON.parse(await readFile(join(h.agent, 'settings.json'), 'utf8')).defaultThinkingLevel, undefined);
  assert.equal(h.provider.requests.length, 0);
});

for (const action of ['tree', 'fork', 'none']) {
  test(`empty editor double Escape follows native ${action} setting without taking over stop`, { timeout: 120000 }, async t => {
    const { h, command, extension, snapshot, next, key } = await treeHarness(t, { doubleEscapeAction: action });
    await command('prompt', { text: 'DOUBLE_ESCAPE_SOURCE' }); await extension('/r16-editor');
    const menus = async () => (await snapshot()).pendingInteractions.filter(f => ['会话树', '分叉会话'].includes(f.title));
    await key('扩展编辑器', 'Esc'); await key('扩展编辑器', 'Esc');
    assert.equal((await menus()).length, 0, 'nonempty editor cannot open a session menu');
    await extension('/r16-editor-draft');
    const active = await h.command('prompt', { text: 'HOLD_MODEL' });
    await until(() => h.provider.requests.length === 2, 'double Escape active response', 5000);
    await key('扩展编辑器', 'Esc'); await h.terminal(active.commandId, 'cancelled');
    assert.equal((await menus()).length, 0, 'stop does not count as an idle Escape');
    await key('扩展编辑器', 'Esc');
    assert.equal((await menus()).length, 0);
    // A key outside the native window becomes a new first press.
    await new Promise(resolve => setTimeout(resolve, 550));
    await key('扩展编辑器', 'Esc'); assert.equal((await menus()).length, 0);
    await key('扩展编辑器', 'Esc');
    if (action === 'none') assert.equal((await menus()).length, 0);
    else {
      const title = action === 'tree' ? '会话树' : '分叉会话';
      await next(title); assert.equal((await menus()).length, 1);
      await key(title, 'Esc');
      await key('扩展编辑器', 'Esc'); assert.equal((await menus()).length, 0, 'successful double Escape resets its window');
    }
    assert.equal(h.provider.requests.length, 2, 'menus never submit a model prompt');
  });
}

test('model slash selects exact native references, searches partial references and keeps defaults unchanged', { timeout: 120000 }, async t => {
  const { h, extension, snapshot, next, answer, key } = await treeHarness(t, {}, { editorModels: true });
  const settings = await readFile(join(h.agent, 'settings.json'), 'utf8');
  await extension('/r16-editor');
  const submit = async text => { await extension(`/r16-editor-draft ${text}`); await key('扩展编辑器', 'Enter'); };
  const model = async () => (await snapshot()).session.model;
  const original = await model();
  await submit('/model'); await next('模型选择'); await key('模型选择', 'Esc');
  await submit(`/model ${original.provider.toUpperCase()}/REASONED`);
  await until(async () => (await model()).id === 'reasoned', 'exact slash model selection', 5000);
  assert.ok(!(await snapshot()).pendingInteractions.some(f => f.title === '模型选择'));
  await submit('/model deterministic');
  await until(async () => (await model()).id === 'deterministic', 'bare exact model id', 5000);
  await submit('/model reaso'); await next('模型选择');
  await until(async () => (await snapshot()).notices.some(n => n.details?.method === 'custom.render' && JSON.stringify(n.details.args).includes('reaso')), 'prefilled model search', 5000);
  await key('模型选择', 'Enter');
  await until(async () => (await model()).id === 'reasoned', 'partial search selection', 5000);
  await submit('/model no-such-model'); await next('模型选择'); await key('模型选择', 'Esc');
  assert.equal((await model()).id, 'reasoned');
  await extension('/r16-config-hooks model');
  const active = await h.command('prompt', { text: 'HOLD_MODEL' });
  await until(() => h.provider.requests.length === 1, 'streaming during model slash', 5000);
  await submit('/model deterministic');
  const hook = await next('editor-model-first');
  assert.notEqual(hook.operationId, active.operationId);
  assert.equal(hook.origin, 'configure'); assert.equal(hook.runId, null);
  await answer('editor-model-first', { confirmed: true }); await key('editor-model-second', 'slash-hook');
  await until(async () => (await model()).id === 'deterministic', 'model slash hook completion', 5000);
  assert.equal(h.query('SELECT status FROM runs WHERE id = ?', active.runId)[0].status, 'running');
  await key('扩展编辑器', 'Esc'); await h.terminal(active.commandId, 'cancelled');
  assert.equal(await readFile(join(h.agent, 'settings.json'), 'utf8'), settings);
  assert.equal(h.provider.requests.length, 1);
});

test('native tree preserves search, labels, copy, hook cancellation and selected branch context', { timeout: 120000 }, async t => {
  const { h, command, extension, snapshot, next, answer, key, combo, open, search, draft, after } = await treeHarness(t);
  await command('prompt', { text: 'TREE_FIRST' }); await command('prompt', { text: 'TREE_SECOND' });
  await extension('/r16-editor');
  const source = mapping(h), entries = await history(source.pi_session_file);
  const second = entries.find(e => e.type === 'message' && e.message.role === 'user' && JSON.stringify(e.message).includes('TREE_SECOND'));
  await open(); await key('会话树', 'Enter');
  await until(async () => (await snapshot()).notices.some(n => n.message === '已在所选节点'), 'current leaf no-op', 5000);
  assert.equal((await snapshot()).pendingInteractions.filter(f => f.title === '分支摘要选项').length, 0);
  await open(); await search('TREE_SECOND');
  await combo('会话树', '会话树输入', 'ctrl+alt+c');
  assert.equal((await next('复制树节点文本')).prefill, 'TREE_SECOND');
  await answer('复制树节点文本', { cancelled: true }); assert.equal(await draft(), 'seed');
  await combo('会话树', '会话树输入', 'shift+l'); await search('branch-label'); await key('会话树', 'Enter');
  assert.ok((await history(source.pi_session_file)).some(e => e.type === 'label' && e.targetId === second.id && e.label === 'branch-label'));
  await key('会话树', 'Enter'); await answer('分支摘要选项', { cancelled: true });
  await next('会话树'); await key('会话树', 'Enter');
  await key('分支摘要选项', '使用自定义提示生成摘要'); await answer('自定义摘要指令', { cancelled: true });
  await next('分支摘要选项');
  await extension('/r16-tree-hooks cancel'); await key('分支摘要选项', '不生成摘要');
  await until(async () => (await snapshot()).notices.some(n => n.message === '树导航已取消'), 'native tree veto', 5000);
  assert.equal((await h.lines('tree-after')).length, 0); assert.equal(await draft(), 'seed');
  await extension('/r16-tree-hooks form');
  await open(); await search('TREE_SECOND'); await key('会话树', 'Enter');
  const summary = await next('分支摘要选项'); await key('分支摘要选项', '不生成摘要');
  assert.equal((await next('tree-hook-confirm')).operationId, summary.operationId);
  await answer('tree-hook-confirm', { confirmed: true });
  assert.equal((await after(1)).newLeafId, second.parentId); assert.equal(await draft(), 'seed');
  await command('prompt', { text: 'TREE_NEW_BRANCH' });
  assert.ok(JSON.stringify(h.provider.requests.at(-1)).includes('TREE_FIRST'));
  assert.ok(!JSON.stringify(h.provider.requests.at(-1)).includes('TREE_SECOND'));
  const bytes = await readFile(source.pi_session_file, 'utf8');
  assert.ok(bytes.includes('TREE_SECOND'), 'abandoned branch stays in native history');
  await extension('/r16-tree-hooks off'); await extension('/r16-editor-draft /tree'); await key('扩展编辑器', 'Enter');
  await search('TREE_SECOND'); await key('会话树', 'Enter'); await key('分支摘要选项', '不生成摘要');
  await after(2); await until(async () => await draft() === 'TREE_SECOND', 'empty draft restores selected text', 5000);
  assert.equal(h.provider.requests.length, 3);
  await open(); const stale = await next('会话树'); await extension('/r16-editor-clear');
  await until(async () => !(await snapshot()).pendingInteractions.some(f => f.interactionId === stale.interactionId), 'tree closes with editor', 5000);
  await assert.rejects(h.command('respond', { operationId: stale.operationId, interactionId: stale.interactionId, response: { value: 'Enter' } }), /INTERACTION_CLOSED/);
});

test('tree commit returns queued inputs before stopping while cancellation keeps the response running', { timeout: 120000 }, async t => {
  const { h, command, extension, next, answer, key, open, search, draft, after } = await treeHarness(t);
  await command('prompt', { text: 'QUEUE_TREE_FIRST' }); await command('prompt', { text: 'QUEUE_TREE_SECOND' });
  await extension('/r16-editor');
  const active = await h.command('prompt', { text: 'HOLD_MODEL' });
  await until(() => h.provider.requests.length === 3, 'held tree response', 5000);
  await command('steer', { targetRunId: active.runId, text: 'queued steer' });
  await command('prompt', { text: 'queued follow', streamingBehavior: 'followUp' });
  await open(); await search('QUEUE_TREE_SECOND'); await key('会话树', 'Enter');
  await answer('分支摘要选项', { cancelled: true }); await next('会话树');
  assert.equal(h.query('SELECT status FROM runs WHERE id = ?', active.runId)[0].status, 'running');
  await key('会话树', 'Enter'); await key('分支摘要选项', '不生成摘要');
  await after(1); await h.terminal(active.commandId, 'cancelled');
  assert.equal(await draft(), 'queued steer\n\nqueued follow\n\nseed');
  const returned = h.query("SELECT payload_json FROM events WHERE type = 'input.updated'").map(r => JSON.parse(r.payload_json)).filter(p => p.state === 'returned');
  assert.equal(returned.length, 2); assert.equal(h.provider.requests.length, 3);
  await command('prompt', { text: 'TREE_AFTER_STOP' });
  assert.ok(!JSON.stringify(h.provider.requests.at(-1)).includes('HOLD_MODEL'));
});

test('tree summary supports custom instructions, explicit cancellation, return to tree and native summary persistence', { timeout: 120000 }, async t => {
  const { h, command, extension, snapshot, next, key, open, search, after } = await treeHarness(t);
  await command('prompt', { text: 'SUMMARY_TREE_FIRST' }); await command('prompt', { text: 'SUMMARY_TREE_SECOND' });
  await extension('/r16-editor');
  const source = mapping(h), original = await readFile(source.pi_session_file, 'utf8');
  await open(); await search('SUMMARY_TREE_FIRST'); await key('会话树', 'Enter');
  await key('分支摘要选项', '使用自定义提示生成摘要'); await key('自定义摘要指令', 'HOLD_MODEL custom summary');
  await until(() => h.provider.requests.length === 3, 'native summary stream', 5000);
  await key('正在生成分支摘要', '取消摘要'); await next('会话树');
  assert.equal(await readFile(source.pi_session_file, 'utf8'), original);
  assert.equal((await h.lines('tree-after')).length, 0);
  await key('会话树', 'Enter'); await key('分支摘要选项', '使用自定义提示生成摘要');
  await key('自定义摘要指令', 'HOLD_MODEL cancel with Escape');
  await until(() => h.provider.requests.length === 4, 'second native summary stream', 5000);
  await key('扩展编辑器', 'Esc'); await next('会话树');
  assert.equal(await readFile(source.pi_session_file, 'utf8'), original);
  await key('会话树', 'Enter'); await key('分支摘要选项', '使用自定义提示生成摘要');
  await key('自定义摘要指令', 'PROVIDER_ERROR');
  await until(async () => (await snapshot()).notices.some(n => n.message.includes('deterministic local provider failure')), 'summary error reported', 5000);
  assert.equal(await readFile(source.pi_session_file, 'utf8'), original);
  await open(); await search('SUMMARY_TREE_FIRST'); await key('会话树', 'Enter');
  await key('分支摘要选项', '使用自定义提示生成摘要');
  await key('自定义摘要指令', 'Keep the synthetic project markers');
  const expectedSummary = 'The user explored a different conversation branch before returning here.\nSummary of that exploration:\n\nlocal-stream-complete';
  const result = await after(1); assert.equal(result.summary, expectedSummary);
  assert.ok(JSON.stringify(h.provider.requests.at(-1)).includes('Keep the synthetic project markers'));
  assert.ok((await history(source.pi_session_file)).some(e => e.type === 'branch_summary' && e.summary === expectedSummary));
  assert.equal(h.query('SELECT COUNT(*) AS count FROM runs')[0].count, 2, 'summary uses an Operation, not a prompt Run');
});

test('tree honors the native skip-summary preference without calling a model', { timeout: 120000 }, async t => {
  const { h, command, extension, snapshot, key, open, search, after } = await treeHarness(t, {
    branchSummary: { skipPrompt: true }, treeFilterMode: 'user-only'
  });
  await command('prompt', { text: 'SKIP_TREE_FIRST' }); await command('prompt', { text: 'SKIP_TREE_SECOND' });
  await extension('/r16-editor'); await open(); await search('SKIP_TREE_FIRST'); await key('会话树', 'Enter');
  await after(1);
  assert.ok(!(await snapshot()).pendingInteractions.some(f => f.title.includes('摘要')));
  assert.equal(JSON.parse((await h.lines('tree-before')).at(-1)).summarize, false);
  assert.equal(h.provider.requests.length, 2);
});

test('native fork menu handles empty history, cancellation and destination draft without resubmission', { timeout: 120000 }, async t => {
  const h = await RealProcessHarness.create(t, { extension: true });
  await writeFile(join(h.agent, 'keybindings.json'), JSON.stringify({ 'app.session.fork': 'ctrl+alt+f' }));
  const command = async (kind, payload) => { const receipt = await h.command(kind, payload); await h.workerPid(); await h.terminal(receipt.commandId); return receipt; };
  const extension = text => command('extension_command', { text });
  const snapshot = () => h.http('GET', `/v1/sessions/${h.sessionId}/snapshot`);
  const used = new Set();
  const next = title => until(async () => (await snapshot()).pendingInteractions.find(f => f.title === title && !used.has(f.interactionId)), title, 5000);
  const key = async (title, value) => {
    const form = await next(title); used.add(form.interactionId);
    const payload = { operationId: form.operationId, interactionId: form.interactionId, response: { value } };
    const id = randomUUID(); const receipt = await h.command('respond', payload, id); await h.terminal(receipt.commandId);
    assert.equal((await h.command('respond', payload, id)).commandId, receipt.commandId);
    return form;
  };
  const open = async () => { await key('扩展编辑器', '组合键'); await key('扩展编辑器输入文本', 'ctrl+alt+f'); };
  await extension('/r16-editor');
  await open();
  await until(async () => (await snapshot()).notices.some(n => n.message.includes('没有可分叉')), 'empty fork diagnostic', 5000);
  assert.equal((await snapshot()).pendingInteractions.filter(f => f.title === '分叉会话').length, 0);
  await command('prompt', { text: 'FORK_MENU_FIRST' });
  await command('prompt', { text: 'FORK_MENU_SECOND' });
  const source = mapping(h);
  const sourceBytes = await readFile(source.pi_session_file, 'utf8');
  await open(); const menu = await next('分叉会话');
  await open();
  assert.equal((await snapshot()).pendingInteractions.filter(f => f.title === '分叉会话').length, 1);
  const replay = await h.connect();
  assert.ok(replay.events().some(e => e.type === 'runtime.notice' && e.payload.details?.method === 'custom.render' && JSON.stringify(e.payload.details.args).includes('FORK_MENU_SECOND')));
  await key('分叉会话', 'Esc');
  assert.equal(mapping(h).pi_session_id, source.pi_session_id);
  assert.equal((await snapshot()).notices.filter(n => n.details?.method === 'setEditorText').at(-1).details.args[0], 'seed');
  await extension('/r16-fork-cancel on');
  await open(); const vetoed = await next('分叉会话'); await key('分叉会话', 'Enter');
  await until(() => h.query("SELECT seq FROM events WHERE operation_id = ? AND type = 'operation.updated' AND json_extract(payload_json, '$.status') = 'completed'", vetoed.operationId).length, 'vetoed fork finishes', 5000);
  assert.equal(h.query('SELECT COUNT(*) AS count FROM sessions')[0].count, 1);
  assert.equal(mapping(h).pi_session_id, source.pi_session_id);
  assert.equal((await snapshot()).notices.filter(n => n.details?.method === 'setEditorText').at(-1).details.args[0], 'seed');
  await extension('/r16-fork-cancel off');
  // Ending the editor also invalidates its child menu and old response keys.
  await open(); const stale = await next('分叉会话');
  await extension('/r16-editor-clear');
  await until(async () => !(await snapshot()).pendingInteractions.some(f => f.interactionId === stale.interactionId), 'fork menu closes with editor', 5000);
  await assert.rejects(h.command('respond', { operationId: stale.operationId, interactionId: stale.interactionId, response: { value: 'Enter' } }), /INTERACTION_CLOSED/);
  await extension('/r16-editor');
  await extension('/r16-editor-draft /fork'); await key('扩展编辑器', 'Enter');
  const oldEditor = await next('扩展编辑器');
  await key('分叉会话', 'Enter');
  const destination = await until(() => h.query('SELECT id, pi_session_file FROM sessions WHERE id != ?', source.id)[0], 'fork destination', 5000);
  h.sessionId = destination.id;
  await until(async () => (await snapshot()).notices.some(n => n.details?.method === 'setEditorText' && n.details.args[0] === 'FORK_MENU_SECOND'), 'destination draft after mapping', 5000);
  assert.equal(await readFile(source.pi_session_file, 'utf8'), sourceBytes);
  const forked = await readFile(destination.pi_session_file, 'utf8');
  assert.ok(forked.includes('FORK_MENU_FIRST'));
  assert.ok(!forked.includes('FORK_MENU_SECOND'));
  assert.equal(h.provider.requests.length, 2, 'fork restores draft without prompting');
  assert.equal(h.query('SELECT COUNT(*) AS count FROM runs WHERE session_id = ?', destination.id)[0].count, 0);
  h.sessionId = source.id;
  await assert.rejects(h.command('respond', { operationId: oldEditor.operationId, interactionId: oldEditor.interactionId, response: { value: 'Enter' } }), /INTERACTION_CLOSED/);
  assert.ok(h.query("SELECT seq FROM events WHERE operation_id = ? AND type = 'operation.updated' AND json_extract(payload_json, '$.status') = 'completed'", menu.operationId).length);
  h.sessionId = destination.id;
  await command('prompt', { text: 'FORK_MENU_CONTINUE' });
  assert.ok(JSON.stringify(h.provider.requests.at(-1)).includes('FORK_MENU_FIRST'));
  assert.ok(!JSON.stringify(h.provider.requests.at(-1)).includes('FORK_MENU_SECOND'));
});

test('native session menu renames, protects current history, deletes with confirmation, resumes and starts new sessions', { timeout: 120000 }, async t => {
  const h = await RealProcessHarness.create(t, { extension: true });
  await writeFile(join(h.agent, 'keybindings.json'), JSON.stringify({ 'app.session.resume': 'ctrl+alt+r', 'app.session.new': 'ctrl+alt+n' }));
  const command = async (kind, payload) => { const receipt = await h.command(kind, payload); await h.workerPid(); await h.terminal(receipt.commandId); return receipt; };
  await command('prompt', { text: 'SESSION_MENU_SOURCE' });
  await command('extension_command', { text: '/r16-title MENU_SOURCE' });
  const source = mapping(h);
  const entries = await history(source.pi_session_file);
  const targetId = randomUUID(), targetPath = join(dirname(source.pi_session_file), `${targetId}.jsonl`);
  const trashId = randomUUID(), trashPath = join(dirname(source.pi_session_file), `${trashId}.jsonl`);
  const fixture = (id, name) => entries.map(e => JSON.stringify(e.type === 'session' ? { ...e, id } : e.type === 'session_info' ? { ...e, name } : e)).join('\n') + '\n';
  await writeFile(targetPath, fixture(targetId, 'MENU_TARGET')); await writeFile(trashPath, fixture(trashId, 'MENU_TRASH'));
  await command('extension_command', { text: '/r16-editor' });
  const snapshot = () => h.http('GET', `/v1/sessions/${h.sessionId}/snapshot`);
  const used = new Set();
  const next = title => until(async () => (await snapshot()).pendingInteractions.find(form => form.title === title && !used.has(form.interactionId)), title, 5000);
  const key = async (title, value) => {
    const form = await next(title); used.add(form.interactionId);
    const payload = { operationId: form.operationId, interactionId: form.interactionId, response: { value } };
    const id = randomUUID(); const answer = await command('respond', payload);
    // Retrying a consumed interaction with a new id must be rejected.
    await assert.rejects(h.command('respond', payload, id), /INTERACTION_CLOSED/);
    return { form, answer };
  };
  const editorCombo = async value => { await key('扩展编辑器', '组合键'); await key('扩展编辑器输入文本', value); };
  const combo = async value => { await key('恢复会话', '组合键'); await key('会话菜单输入', value); };
  const open = async (slash = false) => {
    if (slash) { await command('extension_command', { text: '/r16-editor-draft /resume' }); await key('扩展编辑器', 'Enter'); }
    else await editorCombo('ctrl+alt+r');
    return next('恢复会话');
  };
  const search = async value => { await key('恢复会话', '输入文本'); await key('会话菜单输入', value); await next('恢复会话'); };
  const frame = async text => until(async () => (await snapshot()).notices.some(n => n.details?.method === 'custom.render' && JSON.stringify(n.details.args).includes(text)), `session menu frame ${text}`, 5000);
  const active = await h.command('prompt', { text: 'HOLD_MODEL' });
  const stream = await h.connect(); await until(() => stream.events().some(e => e.runId === active.runId && e.type === 'content.delta'), 'active stream');
  await open(true); await frame('MENU_TARGET'); await key('恢复会话', 'Esc');
  assert.equal(h.query('SELECT status FROM runs WHERE id = ?', active.runId)[0].status, 'running');
  await key('扩展编辑器', 'Esc'); await h.terminal(active.commandId, 'cancelled');
  await open(); await search('MENU_SOURCE'); await combo('ctrl+d');
  await readFile(source.pi_session_file, 'utf8');
  await frame('Cannot delete the currently active session');
  await combo('ctrl+r'); await combo('ctrl+e'); await combo('ctrl+u'); await search('MENU_RENAMED'); await key('恢复会话', 'Enter');
  await until(() => h.query('SELECT title FROM sessions WHERE id = ?', source.id)[0].title === 'MENU_RENAMED', 'current rename projected', 5000);
  await key('恢复会话', 'Esc');
  await open(); await search('MENU_TRASH'); await combo('ctrl+d'); await key('恢复会话', 'Esc');
  await readFile(trashPath, 'utf8');
  await combo('ctrl+d'); await key('恢复会话', 'Enter');
  await until(async () => !(await readdir(dirname(trashPath))).includes(`${trashId}.jsonl`), 'native deletion after confirmation', 5000);
  await key('恢复会话', 'Esc');
  const sourceBytes = await readFile(source.pi_session_file, 'utf8');
  const validTarget = await readFile(targetPath, 'utf8');
  await open(); await search('MENU_TARGET');
  await writeFile(targetPath, '{broken-json\n');
  await key('恢复会话', 'Enter');
  await until(async () => (await snapshot()).notices.some(n => n.message.includes('history') && n.message.includes('invalid')), 'invalid menu target diagnostic', 5000);
  assert.equal(await readFile(targetPath, 'utf8'), '{broken-json\n', 'stale menu selection must not silently recreate history');
  assert.equal(mapping(h).pi_session_id, source.pi_session_id);
  await writeFile(targetPath, validTarget);
  await open(); await search('MENU_TARGET');
  const oldEditor = await next('扩展编辑器');
  const replay = await h.connect(); assert.ok(replay.events().some(e => e.type === 'runtime.notice' && e.payload.details?.method === 'custom.render' && JSON.stringify(e.payload.details.args).includes('MENU_TARGET')));
  await key('恢复会话', 'Enter');
  const destination = await until(() => h.query('SELECT id FROM sessions WHERE pi_session_id = ?', targetId)[0], 'resumed target identity');
  assert.equal(await readFile(source.pi_session_file, 'utf8'), sourceBytes);
  await assert.rejects(h.command('respond', { operationId: oldEditor.operationId, interactionId: oldEditor.interactionId, response: { value: 'Enter' } }), /INTERACTION_CLOSED/);
  h.sessionId = destination.id;
  await command('prompt', { text: 'RESUMED_FROM_MENU' });
  assert.ok(JSON.stringify(h.provider.requests.at(-1)).includes('SESSION_MENU_SOURCE'));
  await command('extension_command', { text: '/r16-editor' });
  const targetBytes = await readFile(targetPath, 'utf8');
  const count = h.query('SELECT COUNT(*) AS count FROM sessions')[0].count;
  await command('extension_command', { text: '/r16-editor-draft /new' }); await key('扩展编辑器', 'Enter');
  await until(() => h.query('SELECT COUNT(*) AS count FROM sessions')[0].count === count + 1, 'new session via app action');
  assert.equal(await readFile(targetPath, 'utf8'), targetBytes);
  assert.equal(h.provider.requests.length, 3, 'new/resume actions do not prompt');
});

test('native model menu searches, cancels, replays, saves defaults and closes with its editor', { timeout: 120000 }, async t => {
  const h = await RealProcessHarness.create(t, { extension: true, editorModels: true });
  await writeFile(join(h.agent, 'keybindings.json'), JSON.stringify({ 'app.models.save': 'ctrl+alt+s' }));
  const originalSettings = await readFile(join(h.agent, 'settings.json'), 'utf8');
  const extension = async text => { const cmd = await h.command('extension_command', { text }); await h.workerPid(); await h.terminal(cmd.commandId); };
  await extension('/r16-editor');
  const snapshot = () => h.http('GET', `/v1/sessions/${h.sessionId}/snapshot`);
  const previous = new Set();
  const next = title => until(async () => (await snapshot()).pendingInteractions.find(form => !previous.has(form.interactionId) && form.title === title), title, 5000);
  const respond = async (form, response) => {
    previous.add(form.interactionId);
    const payload = { operationId: form.operationId, interactionId: form.interactionId, response };
    const id = randomUUID(); const cmd = await h.command('respond', payload, id); await h.terminal(cmd.commandId);
    assert.equal((await h.command('respond', payload, id)).commandId, cmd.commandId);
  };
  const key = async (title, value) => respond(await next(title), { value });
  const editorCombo = async value => { await key('扩展编辑器', '组合键'); await key('扩展编辑器输入文本', value); await next('扩展编辑器'); };
  const open = async () => { await editorCombo('ctrl+l'); return next('模型选择'); };
  const search = async text => { await key('模型选择', '输入文本'); await key('模型选择输入', text); return next('模型选择'); };
  const active = await h.command('prompt', { text: 'HOLD_MODEL' });
  const stream = await h.connect();
  await until(() => stream.events().some(e => e.type === 'content.delta'), 'active model');
  const first = await open();
  assert.equal(first.origin, 'configure'); assert.equal(first.runId, null);
  await editorCombo('ctrl+l');
  assert.equal((await snapshot()).pendingInteractions.filter(form => form.title === '模型选择').length, 1, 'repeated open keeps a single existing menu');
  await search('no-such-model-in-fixture'); await key('模型选择', 'Enter');
  assert.equal((await snapshot()).session.model.id, 'deterministic');
  await next('模型选择'); await key('模型选择', 'Esc');
  await until(async () => !(await snapshot()).pendingInteractions.some(form => form.title.startsWith('模型选择')), 'menu cancelled', 5000);
  assert.equal(h.query('SELECT status FROM runs WHERE id = ?', active.runId)[0].status, 'running', 'menu Esc does not stop generation');
  assert.equal((await snapshot()).notices.filter(n => n.details?.method === 'setEditorText').at(-1).details.args[0], 'seed');
  await open(); const selection = await search('reasoned');
  const replay = await h.connect();
  assert.ok(replay.events().some(e => e.type === 'runtime.notice' && e.operationId === selection.operationId && e.payload.details?.method === 'custom.render' && JSON.stringify(e.payload.details.args).includes('reasoned')));
  await extension('/r16-config-hooks model');
  await key('模型选择', 'Enter');
  const hook = await next('editor-model-first'); assert.equal(hook.operationId, selection.operationId);
  await respond(hook, { confirmed: true });
  await key('editor-model-second', 'menu selected');
  await until(async () => (await snapshot()).session.model.id === 'reasoned', 'menu model selected', 5000);
  assert.equal(await readFile(join(h.agent, 'settings.json'), 'utf8'), originalSettings);
  assert.deepEqual(JSON.parse((await h.lines('editor-model-hooks'))[0]), { source: 'set', first: true, second: 'menu selected' });
  await extension('/r16-config-hooks off');
  await open(); await search('reasoned'); await key('模型选择', '组合键'); await key('模型选择输入', 'ctrl+alt+s');
  await until(async () => JSON.parse(await readFile(join(h.agent, 'settings.json'), 'utf8')).defaultModel === 'reasoned', 'native default saved', 5000);
  assert.equal(JSON.parse(await readFile(join(h.agent, 'settings.json'), 'utf8')).defaultProvider, 'r16-local');
  assert.equal(h.provider.requests.length, 1, 'menus do not start or restart model requests');
  const stale = await open();
  await extension('/r16-editor-clear');
  await until(async () => (await snapshot()).pendingInteractions.length === 0, 'closing editor closes menu', 5000);
  await assert.rejects(h.command('respond', { operationId: stale.operationId, interactionId: stale.interactionId, response: { value: 'Enter' } }), /INTERACTION_CLOSED/);
  const abort = await h.command('abort', { targetRunId: active.runId }); await h.terminal(abort.commandId); await h.terminal(active.commandId, 'cancelled');
  await extension('/r16-editor'); const sourceMenu = await open();
  await extension('/r16-new');
  await until(async () => (await snapshot()).pendingInteractions.length === 0, 'replacement closes source model menu', 5000);
  await assert.rejects(h.command('respond', { operationId: sourceMenu.operationId, interactionId: sourceMenu.interactionId, response: { value: 'Enter' } }), /INTERACTION_CLOSED/);
});

test('editor cycles native models and thinking while streaming, with independent configuration hooks', { timeout: 120000 }, async t => {
  const h = await RealProcessHarness.create(t, { extension: true, editorModels: true });
  const defaults = await readFile(join(h.agent, 'settings.json'), 'utf8');
  const extension = async text => { const cmd = await h.command('extension_command', { text }); await h.workerPid(); await h.terminal(cmd.commandId); };
  await extension('/r16-editor');
  const snapshot = () => h.http('GET', `/v1/sessions/${h.sessionId}/snapshot`);
  let previous;
  const next = () => until(async () => (await snapshot()).pendingInteractions.find(form => form.interactionId !== previous && form.title.startsWith('扩展编辑器')), 'configuration editor control', 5000);
  const respond = async (form, response) => {
    const payload = { operationId: form.operationId, interactionId: form.interactionId, response };
    const key = randomUUID(); const cmd = await h.command('respond', payload, key); await h.terminal(cmd.commandId);
    assert.equal((await h.command('respond', payload, key)).commandId, cmd.commandId);
  };
  const key = async value => { const form = await next(); previous = form.interactionId; await respond(form, { value }); await next(); };
  const combo = async value => { await key('组合键'); await key(value); };
  const model = async id => until(async () => (await snapshot()).session.model?.id === id, `model ${id}`, 5000);
  await combo('shift+tab');
  assert.ok((await snapshot()).notices.some(n => n.message === '当前模型不支持思考等级'));
  await combo('ctrl+p'); await model('reasoned');
  const before = (await snapshot()).session.thinkingLevel;
  await combo('shift+tab');
  assert.notEqual((await snapshot()).session.thinkingLevel, before);
  await combo('ctrl+shift+p'); await model('deterministic');
  assert.equal((await snapshot()).session.thinkingLevel, 'off');
  assert.equal(h.provider.requests.length, 0);
  assert.equal(h.query('SELECT COUNT(*) AS count FROM runs')[0].count, 0);
  const stream = await h.connect();
  const active = await h.command('prompt', { text: 'HOLD_MODEL' });
  await until(() => stream.events().some(e => e.type === 'content.delta'), 'model is streaming');
  await combo('ctrl+p'); await model('reasoned');
  await extension('/r16-config-hooks model');
  await combo('ctrl+shift+p');
  const form = title => until(async () => (await snapshot()).pendingInteractions.find(item => item.title === title), title, 5000);
  const first = await form('editor-model-first');
  assert.equal(first.origin, 'configure'); assert.equal(first.runId, null);
  await respond(first, { confirmed: true });
  const second = await form('editor-model-second');
  assert.equal(second.operationId, first.operationId, 'awaited model hook keeps its operation across delayed forms');
  assert.ok(!h.query("SELECT seq FROM events WHERE operation_id = ? AND type = 'operation.updated' AND json_extract(payload_json, '$.status') = 'completed'", first.operationId).length);
  await respond(second, { value: 'model done' });
  await model('deterministic');
  assert.deepEqual(JSON.parse((await h.lines('editor-model-hooks'))[0]), { source: 'cycle', first: true, second: 'model done' });
  await extension('/r16-config-hooks off');
  await combo('ctrl+p'); await model('reasoned');
  await extension('/r16-config-hooks thinking');
  await combo('shift+tab');
  const thinkingFirst = await form('editor-thinking-first');
  assert.equal(thinkingFirst.origin, 'configure'); assert.equal(thinkingFirst.runId, null);
  await respond(thinkingFirst, { cancelled: true });
  const thinkingSecond = await form('editor-thinking-second');
  assert.equal(thinkingSecond.runId, null, 'late thinking hook must not adopt the unrelated streaming Run');
  assert.notEqual(thinkingSecond.operationId, active.operationId);
  await respond(thinkingSecond, { value: 'thinking done' });
  await until(async () => (await h.lines('editor-thinking-hooks')).length === 1, 'thinking hook result');
  assert.deepEqual(JSON.parse((await h.lines('editor-thinking-hooks'))[0]), { first: false, second: 'thinking done' });
  assert.equal(h.query('SELECT status FROM runs WHERE id = ?', active.runId)[0].status, 'running');
  assert.equal(h.provider.requests.length, 1, 'configuration keys never prompt or restart the model');
  await extension('/r16-config-hooks off');
  await key('Esc'); await h.terminal(active.commandId, 'cancelled');
  assert.equal(await readFile(join(h.agent, 'settings.json'), 'utf8'), defaults, 'cycles do not overwrite global defaults');
  const native = await history(mapping(h).pi_session_file);
  assert.equal(native.filter(e => e.type === 'model_change').at(-1).modelId, 'reasoned');
  assert.equal(native.filter(e => e.type === 'thinking_level_change').at(-1).thinkingLevel, (await snapshot()).session.thinkingLevel);
});

test('editor cycles respect configured keys, explicit history priority and a single available model', { timeout: 120000 }, async t => {
  const h = await RealProcessHarness.create(t, { extension: true });
  await writeFile(join(h.agent, 'keybindings.json'), JSON.stringify({
    'app.model.cycleForward': ['ctrl+p', 'ctrl+alt+m'], 'tui.editor.historyPrevious': 'ctrl+p',
    'app.thinking.cycle': 'alt+t'
  }));
  const install = await h.command('extension_command', { text: '/r16-editor' });
  await h.workerPid(); await h.terminal(install.commandId);
  const snapshot = () => h.http('GET', `/v1/sessions/${h.sessionId}/snapshot`);
  let previous;
  const next = () => until(async () => (await snapshot()).pendingInteractions.find(form => form.interactionId !== previous && form.title.startsWith('扩展编辑器')), 'custom key control', 5000);
  const answer = async value => {
    const form = await next(); previous = form.interactionId;
    const cmd = await h.command('respond', { operationId: form.operationId, interactionId: form.interactionId, response: { value } });
    await h.terminal(cmd.commandId); await next();
  };
  const combo = async value => { await answer('组合键'); await answer(value); };
  await combo('ctrl+p');
  assert.ok(!(await snapshot()).notices.some(n => n.message === '只有一个可用模型'), 'explicit history binding wins over the app action');
  await combo('ctrl+alt+m');
  assert.ok((await snapshot()).notices.some(n => n.message === '只有一个可用模型'));
  await combo('alt+t');
  assert.ok((await snapshot()).notices.some(n => n.message === '当前模型不支持思考等级'));
  assert.equal((await snapshot()).session.model.id, 'deterministic');
  assert.equal(h.provider.requests.length, 0);
  assert.equal(h.query('SELECT COUNT(*) AS count FROM runs')[0].count, 0);
});

test('native editor actions clear, expand, dismiss completion and restore queued text before stop', { timeout: 120000 }, async t => {
  const h = await RealProcessHarness.create(t, { extension: true });
  const install = await h.command('extension_command', { text: '/r16-editor' });
  await h.workerPid(); await h.terminal(install.commandId);
  const snapshot = () => h.http('GET', `/v1/sessions/${h.sessionId}/snapshot`);
  let previous;
  const next = () => until(async () => (await snapshot()).pendingInteractions.find(form => form.interactionId !== previous && form.title.startsWith('扩展编辑器')), 'action editor control', 5000);
  const answer = async value => {
    const form = await next(); previous = form.interactionId;
    const payload = { operationId: form.operationId, interactionId: form.interactionId, response: { value } };
    const key = randomUUID(); const cmd = await h.command('respond', payload, key); await h.terminal(cmd.commandId);
    assert.equal((await h.command('respond', payload, key)).commandId, cmd.commandId);
    await next();
  };
  const combo = async key => { await answer('组合键'); await answer(key); };
  const draft = async text => { const cmd = await h.command('extension_command', { text: `/r16-editor-draft ${text}` }); await h.terminal(cmd.commandId); };
  const text = async () => (await snapshot()).notices.filter(n => n.details?.method === 'setEditorText').at(-1)?.details.args[0];
  await combo('ctrl+o');
  assert.equal((await snapshot()).notices.filter(n => n.details?.method === 'setToolsExpanded').at(-1).details.args[0], true);
  await combo('ctrl+o');
  assert.equal((await snapshot()).notices.filter(n => n.details?.method === 'setToolsExpanded').at(-1).details.args[0], false);
  assert.equal(h.query('SELECT COUNT(*) AS count FROM runs')[0].count, 0);
  const active = await h.command('prompt', { text: 'HOLD_MODEL' });
  await until(() => h.provider.requests.length === 1, 'held model');
  await combo('ctrl+c');
  assert.equal(await text(), '');
  assert.equal(h.query('SELECT status FROM runs WHERE id = ?', active.runId)[0].status, 'running');
  await draft('cho'); await answer('Tab');
  await answer('Esc');
  assert.equal(h.query('SELECT status FROM runs WHERE id = ?', active.runId)[0].status, 'running', 'Esc dismisses completion without stopping');
  for (let i = 0; i < 2; i++) {
    const queued = await h.command('steer', { targetRunId: active.runId, text: 'unconsumed draft' }); await h.terminal(queued.commandId);
  }
  await draft('current draft'); await answer('Esc');
  await h.terminal(active.commandId, 'cancelled');
  assert.equal(await text(), 'unconsumed draft\n\nunconsumed draft\n\ncurrent draft');
  const returned = h.query("SELECT payload_json FROM events WHERE type = 'input.updated'").map(row => JSON.parse(row.payload_json)).filter(p => p.state === 'returned');
  assert.equal(new Set(returned.map(p => p.inputId)).size, 2);
  assert.equal(h.provider.requests.length, 1, 'recovered drafts are never resubmitted');
  await draft('!!printf started > editor-bash-started; sleep 30'); await answer('Enter');
  await until(async () => (await h.lines('editor-bash-started')).length === 1, 'editor Bash starts');
  await answer('Esc');
  await until(async () => (await history(mapping(h).pi_session_file)).some(item => item.type === 'message' && item.message.role === 'bashExecution' && item.message.cancelled), 'editor Bash cancelled', 5000);
  await draft('ab'); await answer('Home'); await combo('ctrl+d');
  assert.equal(await text(), 'b', 'nonempty Ctrl+D keeps native delete-forward');
  const replay = await h.connect();
  assert.ok(replay.events().some(e => e.type === 'runtime.notice' && e.payload.details?.method === 'setToolsExpanded'));
});

test('terminal listeners consume and transform input before native extension shortcuts', { timeout: 120000 }, async t => {
  const h = await RealProcessHarness.create(t, { extension: true });
  for (const text of ['/r16-keys', '/r16-editor']) {
    const command = await h.command('extension_command', { text }); await h.workerPid(); await h.terminal(command.commandId);
  }
  const snapshot = () => h.http('GET', `/v1/sessions/${h.sessionId}/snapshot`);
  let previous;
  const next = () => until(async () => (await snapshot()).pendingInteractions.find(form => form.interactionId !== previous && form.title.startsWith('扩展编辑器')), 'editor key form');
  const answer = async value => {
    const form = await next(); previous = form.interactionId;
    const payload = { operationId: form.operationId, interactionId: form.interactionId, response: { value } };
    const key = randomUUID(); const command = await h.command('respond', payload, key); await h.terminal(command.commandId);
    assert.equal((await h.command('respond', payload, key)).commandId, command.commandId);
  };
  const combo = async key => { await answer('组合键'); await answer(key); await next(); };
  await combo('ctrl+alt+x');
  let value = await snapshot();
  assert.ok(value.notices.some(n => n.details?.method === 'setStatus' && n.details.args[0] === 'keys-consumed'));
  assert.ok(!value.notices.some(n => n.details?.method === 'setStatus' && n.details.args[0] === 'keys-observed'));
  assert.equal((await h.lines('shortcut-calls')).length, 0);
  await combo('ctrl+alt+j');
  await until(async () => (await h.lines('shortcut-calls')).length === 1, 'transformed shortcut runs once');
  value = await snapshot();
  assert.ok(value.notices.some(n => n.details?.method === 'setStatus' && n.details.args[0] === 'keys-observed' && n.details.args[1] === 'shortcut'));
  assert.equal(value.notices.filter(n => n.details?.method === 'setEditorText').at(-1).details.args[0], 'seed');
  const off = await h.command('extension_command', { text: '/r16-keys-off' }); await h.terminal(off.commandId);
  const observedBefore = (await snapshot()).notices.filter(n => n.details?.method === 'setStatus' && n.details.args[0] === 'keys-observed').length;
  await combo('ctrl+alt+j');
  assert.equal((await h.lines('shortcut-calls')).length, 1);
  assert.equal((await snapshot()).notices.filter(n => n.details?.method === 'setStatus' && n.details.args[0] === 'keys-observed').length, observedBefore);
  await combo('ctrl+alt+k');
  await until(async () => (await h.lines('shortcut-calls')).length === 2, 'shortcut still works after unsubscribe');
  await combo('ctrl+alt+e');
  assert.ok((await snapshot()).notices.some(n => n.message.includes('shortcut input failure')));
  await combo('ctrl+unknown');
  assert.ok((await snapshot()).notices.some(n => n.message.includes('无法识别组合键')));
  assert.equal(h.provider.requests.length, 0);
  assert.equal(h.query('SELECT COUNT(*) AS count FROM runs')[0].count, 0);
  const replay = await h.connect();
  assert.ok(replay.events().some(e => e.type === 'runtime.notice' && e.payload.details?.args?.[0] === 'keys-shortcut'));
  const register = await h.command('extension_command', { text: '/r16-keys' }); await h.terminal(register.commandId);
  const custom = await h.command('extension_command', { text: '/r16-custom' });
  const oldForm = await until(async () => (await snapshot()).pendingInteractions.find(form => form.title === '自定义组件控制'), 'source custom with listeners');
  const replacement = await h.command('extension_command', { text: '/r16-new' }); await h.terminal(replacement.commandId);
  const observedAtReplacement = (await snapshot()).notices.filter(n => n.details?.method === 'setStatus' && n.details.args[0] === 'keys-observed').length;
  const finish = await h.command('respond', { operationId: oldForm.operationId, interactionId: oldForm.interactionId, response: { value: 'Enter' } });
  await h.terminal(finish.commandId); await h.terminal(custom.commandId);
  assert.deepEqual(JSON.parse((await h.lines('custom-results'))[0]), { result: { down: 0, text: '' }, disposed: true });
  assert.equal((await snapshot()).notices.filter(n => n.details?.method === 'setStatus' && n.details.args[0] === 'keys-observed').length, observedAtReplacement, 'old application listeners removed even from surviving custom surfaces');
});

test('real CustomEditor edits, completes and submits once; reset invalidates old keys', { timeout: 120000 }, async t => {
  const h = await RealProcessHarness.create(t, { extension: true });
  const install = await h.command('extension_command', { text: '/r16-editor' });
  await h.workerPid(); await h.terminal(install.commandId);
  const snapshot = () => h.http('GET', `/v1/sessions/${h.sessionId}/snapshot`);
  let previous;
  const next = () => until(async () => (await snapshot()).pendingInteractions.find(item => item.interactionId !== previous), 'editor input form');
  const key = async value => {
    const form = await next(); previous = form.interactionId;
    const payload = { operationId: form.operationId, interactionId: form.interactionId, response: { value } };
    const id = randomUUID();
    const answer = await h.command('respond', payload, id); await h.terminal(answer.commandId);
    assert.equal((await h.command('respond', payload, id)).commandId, answer.commandId);
    return form;
  };
  await next();
  assert.ok((await snapshot()).notices.some(n => n.details?.method === 'setStatus' && n.details.args[0] === 'editor-factory' && n.details.args[1] === 'true'));
  const draft = async text => { const cmd = await h.command('extension_command', { text: `/r16-editor-draft ${text}` }); await h.terminal(cmd.commandId); };
  await draft('com');
  await key('Tab');
  await until(async () => (await snapshot()).notices.some(n => n.details?.method === 'setEditorText' && n.details.args[0] === 'EDITOR_NATIVE_SUBMIT'), 'native autocomplete result');
  const replay = await h.connect();
  assert.ok(replay.events().some(e => e.type === 'runtime.notice' && e.payload.details?.method === 'custom.render'));
  await key('Enter');
  await until(() => h.query("SELECT id FROM runs WHERE status = 'completed'").length === 1, 'editor native submission');
  assert.equal(h.provider.requests.length, 1);
  assert.ok(JSON.stringify(h.provider.requests[0]).includes('EDITOR_NATIVE_SUBMIT'));
  assert.equal(h.query('SELECT command_id FROM runs')[0].command_id, null, 'install command must not own later user submissions');
  await draft('/r16-title Editor command'); await key('Enter');
  await until(() => h.query('SELECT title FROM sessions WHERE id = ?', h.sessionId)[0].title === 'Editor command', 'editor extension command');
  await draft('!!printf editor-shell'); await key('Enter');
  await until(async () => (await history(mapping(h).pi_session_file)).some(item => item.type === 'message' && item.message.role === 'bashExecution' && item.message.command === 'printf editor-shell' && item.message.excludeFromContext === true), 'editor native Bash');
  assert.ok(h.query("SELECT seq FROM events WHERE type = 'operation.updated' AND json_extract(payload_json, '$.kind') = 'bash'").length > 0);
  await draft('/login'); await key('Enter');
  await until(async () => (await snapshot()).notices.some(n => n.message.includes('/login') && n.message.includes('文本已保留')), 'terminal menu diagnostic');
  assert.equal((await snapshot()).notices.filter(n => n.details?.method === 'setEditorText').at(-1).details.args[0], '/login');
  assert.equal(h.provider.requests.length, 1, 'Bash and terminal menus never become model prompts');
  await draft('keep');
  await key('Home');
  await next();
  await h.http('POST', `/v1/sessions/${h.sessionId}/editor-state`, { text: 'keep' });
  const paste = await h.command('extension_command', { text: '/r16-editor-paste cursor:' }); await h.terminal(paste.commandId);
  await until(async () => (await snapshot()).notices.filter(n => n.details?.method === 'setEditorText').at(-1)?.details.args[0] === 'cursor:keep', 'native cursor paste');
  const stale = await next();
  const clear = await h.command('extension_command', { text: '/r16-editor-clear' }); await h.terminal(clear.commandId);
  await until(async () => (await snapshot()).pendingInteractions.length === 0, 'editor reset');
  await assert.rejects(h.command('respond', { operationId: stale.operationId, interactionId: stale.interactionId, response: { value: 'Enter' } }), /INTERACTION_CLOSED/);
  assert.equal(h.provider.requests.length, 1);
  assert.equal((await snapshot()).notices.filter(n => n.details?.method === 'setEditorText').at(-1).details.args[0], 'cursor:keep');
  await until(async () => (await h.lines('editor-disposed')).length === 1, 'native editor dispose');
  const reinstall = await h.command('extension_command', { text: '/r16-editor' }); await h.terminal(reinstall.commandId);
  const old = await next();
  const replacement = await h.command('extension_command', { text: '/r16-new' }); await h.terminal(replacement.commandId);
  await until(async () => (await snapshot()).pendingInteractions.length === 0, 'source editor closed on replacement');
  const targetId = h.query('SELECT id FROM sessions WHERE id != ?', h.sessionId)[0].id;
  assert.equal((await h.http('GET', `/v1/sessions/${targetId}/snapshot`)).pendingInteractions.length, 0);
  await assert.rejects(h.command('respond', { operationId: old.operationId, interactionId: old.interactionId, response: { value: 'Enter' } }), /INTERACTION_CLOSED/);
  await until(async () => (await h.lines('editor-disposed')).length === 2, 'replaced editor disposed');
  assert.equal(h.provider.requests.length, 2, 'only the explicit native replacement continuation creates another request');
});

test('native header/footer render, watch Git, replay and keep original Session ownership', { timeout: 120000 }, async t => {
  const h = await RealProcessHarness.create(t, { extension: true });
  execFileSync('git', ['init', '-q', '-b', 'surface-main', h.project]);
  const receipt = await h.command('extension_command', { text: '/r16-surface' });
  await h.workerPid(); await h.terminal(receipt.commandId);
  const snapshot = () => h.http('GET', `/v1/sessions/${h.sessionId}/snapshot`);
  const frame = (value, method) => value.notices.filter(n => n.details?.method === method).at(-1)?.details.args[0];
  const first = await snapshot();
  assert.deepEqual(frame(first, 'setHeader'), ['header:80:0:false']);
  assert.match(frame(first, 'setFooter')[0], /^footer:80:surface-main:ready:\d+$/);
  const change = await h.command('extension_command', { text: '/r16-surface status' });
  await h.terminal(change.commandId);
  execFileSync('git', ['-C', h.project, 'symbolic-ref', 'HEAD', 'refs/heads/surface-next']);
  await until(async () => frame(await snapshot(), 'setFooter')?.[0]?.includes(':surface-next:updated:'), 'native footer branch update');
  const replay = await h.connect();
  assert.ok(replay.events().some(e => e.type === 'runtime.notice' && e.payload.details?.method === 'setFooter' && e.payload.details.args[0]?.[0]?.includes(':surface-next:updated:')));
  assert.equal(h.provider.requests.length, 0);
  assert.equal(h.query('SELECT COUNT(*) AS count FROM runs')[0].count, 0);
  const failed = await h.command('extension_command', { text: '/r16-surface fail' });
  await h.terminal(failed.commandId);
  assert.deepEqual(frame(await snapshot(), 'setHeader'), { rendererError: 'surface factory failed' });
  const clear = await h.command('extension_command', { text: '/r16-surface clear' });
  await h.terminal(clear.commandId);
  assert.equal(frame(await snapshot(), 'setHeader'), null);
  assert.equal(frame(await snapshot(), 'setFooter'), null);
  await until(async () => (await h.lines('surface-disposed')).length === 2, 'both surfaces disposed');
  const reinstalled = await h.command('extension_command', { text: '/r16-surface' });
  await h.terminal(reinstalled.commandId);
  const sourceId = h.sessionId;
  const replace = await h.command('extension_command', { text: '/r16-new' });
  await h.terminal(replace.commandId);
  h.sessionId = h.query('SELECT id FROM sessions WHERE id != ?', sourceId)[0].id;
  await writeFile(join(h.project, 'surface-refresh'), '1');
  const source = await until(async () => {
    const value = await h.http('GET', `/v1/sessions/${sourceId}/snapshot`);
    return frame(value, 'setHeader')?.[0] === 'header:80:1:false' ? value : null;
  }, 'original surface async refresh after replacement');
  assert.deepEqual(frame(source, 'setHeader'), ['header:80:1:false']);
  assert.equal(frame(await snapshot(), 'setHeader'), undefined);
});

test('native overlay hides input, restores focus and replays its composited frame', { timeout: 120000 }, async t => {
  const h = await RealProcessHarness.create(t, { extension: true });
  const receipt = await h.command('extension_command', { text: '/r16-overlay' });
  await h.workerPid();
  let previous;
  const next = () => until(async () => (await h.http('GET', `/v1/sessions/${h.sessionId}/snapshot`)).pendingInteractions.find(item => item.interactionId !== previous), 'overlay control');
  const enter = async () => {
    const form = await next();
    previous = form.interactionId;
    const answer = await h.command('respond', { operationId: form.operationId, interactionId: form.interactionId, response: { value: 'Enter' } });
    await h.terminal(answer.commandId);
    await next();
  };
  await enter(); // First input hides the overlay.
  await enter(); // Hidden overlay must not receive this input.
  assert.equal((await h.lines('overlay-results')).length, 0);
  const hidden = await h.http('GET', `/v1/sessions/${h.sessionId}/snapshot`);
  assert.ok(!hidden.notices.filter(n => n.details?.method === 'custom.render').at(-1).details.args[1].some(line => line.includes('overlay:')));
  const restore = await h.command('extension_command', { text: '/r16-overlay-show' });
  await h.terminal(restore.commandId);
  const replay = await h.connect();
  const frames = replay.events().filter(e => e.type === 'runtime.notice' && e.payload.details?.method === 'custom.render');
  assert.ok(frames.at(-1).payload.details.args[1][1].startsWith('  overlay:20:1'));
  const form = await next();
  const answer = await h.command('respond', { operationId: form.operationId, interactionId: form.interactionId, response: { value: 'Enter' } });
  await h.terminal(answer.commandId);
  await h.terminal(receipt.commandId);
  const saved = JSON.parse((await h.lines('overlay-results'))[0]);
  assert.equal(saved.disposed, true);
  assert.equal(saved.result.inputs, 2);
  assert.equal(saved.result.focused, true);
  assert.equal(saved.result.bounds.width, 20);
  const final = await h.http('GET', `/v1/sessions/${h.sessionId}/snapshot`);
  assert.equal(final.pendingInteractions.length, 0);
  assert.equal(final.notices.filter(n => n.details?.method === 'custom.render').at(-1).details.args[1], null);
  assert.equal(h.query('SELECT COUNT(*) AS count FROM runs')[0].count, 0);
  assert.equal(h.provider.requests.length, 0);
});

test('custom component keys/text survive reconnect, return native done results and cancel explicitly', { timeout: 120000 }, async t => {
  const h = await RealProcessHarness.create(t, { extension: true });
  const receipt = await h.command('extension_command', { text: '/r16-custom' });
  await h.workerPid();
  let previous;
  const next = () => until(async () => {
    const snapshot = await h.http('GET', `/v1/sessions/${h.sessionId}/snapshot`);
    return snapshot.pendingInteractions.find(item => item.interactionId !== previous);
  }, 'next custom control form');
  const answer = async (form, response, key = randomUUID()) => {
    previous = form.interactionId;
    const payload = { operationId: form.operationId, interactionId: form.interactionId, response };
    const accepted = await h.command('respond', payload, key);
    await h.terminal(accepted.commandId);
    assert.equal((await h.command('respond', payload, key)).commandId, accepted.commandId);
    await assert.rejects(h.command('respond', payload), /INTERACTION_CLOSED/);
  };
  const first = await next();
  assert.equal(first.kind, 'select');
  await answer(first, { value: '↓' });
  const second = await next();
  const replay = await h.connect();
  assert.ok(replay.events().some(e => e.type === 'runtime.notice' && e.payload.details?.method === 'custom.render' && e.payload.details.args[1]?.[0] === 'custom:1:'));
  replay.socket.terminate();
  await answer(second, { value: '输入文本' });
  const text = await next();
  assert.equal(text.kind, 'input');
  await answer(text, { value: 'phone中文' });
  await answer(await next(), { value: 'Enter' });
  await h.terminal(receipt.commandId);
  assert.deepEqual(JSON.parse((await h.lines('custom-results'))[0]), { result: { down: 1, text: 'phone中文' }, disposed: true });
  const cancelled = await h.command('extension_command', { text: '/r16-custom' });
  await answer(await next(), { cancelled: true });
  await h.terminal(cancelled.commandId);
  assert.deepEqual(JSON.parse((await h.lines('custom-results'))[1]), { result: null, disposed: true });
  const final = await h.http('GET', `/v1/sessions/${h.sessionId}/snapshot`);
  assert.equal(final.pendingInteractions.length, 0);
  assert.equal(final.notices.filter(n => n.details?.method === 'custom.render').at(-1).details.args[1], null);
  assert.equal(h.query('SELECT COUNT(*) AS count FROM runs')[0].count, 0);
  assert.equal(h.provider.requests.length, 0);
});

test('pending custom controls keep source ownership across native session replacement', { timeout: 120000 }, async t => {
  const h = await RealProcessHarness.create(t, { extension: true });
  const sourceId = h.sessionId;
  const custom = await h.command('extension_command', { text: '/r16-custom error' });
  await h.workerPid();
  const form = await until(async () => (await h.http('GET', `/v1/sessions/${sourceId}/snapshot`)).pendingInteractions[0], 'source custom form');
  const replace = await h.command('extension_command', { text: '/r16-new' });
  await h.terminal(replace.commandId);
  const targetId = h.query('SELECT id FROM sessions WHERE id != ?', sourceId)[0].id;
  const target = await h.http('GET', `/v1/sessions/${targetId}/snapshot`);
  assert.equal(target.pendingInteractions.length, 0);
  assert.ok(!target.notices.some(n => n.details?.method === 'custom.render'));
  const answer = await h.command('respond', { operationId: form.operationId, interactionId: form.interactionId, response: { value: 'Enter' } });
  await h.terminal(answer.commandId);
  await h.terminal(custom.commandId);
  assert.deepEqual(JSON.parse((await h.lines('custom-results'))[0]), { result: { down: 0, text: '' }, disposed: true });
  const source = await h.http('GET', `/v1/sessions/${sourceId}/snapshot`);
  assert.equal(source.pendingInteractions.length, 0);
  assert.equal(source.notices.filter(n => n.details?.method === 'custom.render').at(-1).details.args[1], null);
  assert.ok(source.notices.some(n => n.message.includes('custom source callback failure')));
  const after = await h.http('GET', `/v1/sessions/${targetId}/snapshot`);
  assert.ok(!after.notices.some(n => n.message.includes('custom source callback failure')));
});

test('native widget factory refreshes after command completion and replays before explicit removal', { timeout: 120000 }, async t => {
  const h = await RealProcessHarness.create(t, { extension: true });
  const receipt = await h.command('extension_command', { text: '/r16-widget' });
  await h.workerPid();
  await h.terminal(receipt.commandId);
  const snapshot = await until(async () => {
    const value = await h.http('GET', `/v1/sessions/${h.sessionId}/snapshot`);
    return value.notices.some(n => n.details?.args?.[1]?.[0] === 'native-widget:2:80') ? value : null;
  }, 'delayed widget render');
  const rendered = snapshot.notices.filter(n => n.details?.method === 'setWidget');
  assert.equal(rendered.at(-1).details.args[2].placement, 'belowEditor');
  assert.ok(rendered.every(n => !JSON.stringify(n).includes('unsupportedRenderer')));
  const replay = await h.connect();
  assert.deepEqual(replay.events().filter(e => e.type === 'runtime.notice' && e.payload.details?.method === 'setWidget').map(e => e.payload.details), rendered.map(n => n.details));
  assert.equal(h.provider.requests.length, 0);
  assert.equal(h.query('SELECT COUNT(*) AS count FROM runs')[0].count, 0);
  const clear = await h.command('extension_command', { text: '/r16-widget clear' });
  await h.terminal(clear.commandId);
  await until(async () => (await h.lines('widget-disposed')).length === 1, 'widget disposed');
  const final = await h.http('GET', `/v1/sessions/${h.sessionId}/snapshot`);
  assert.deepEqual(final.notices.filter(n => n.details?.method === 'setWidget').at(-1).details.args, ['native-widget', null]);
});

test('native UI controls persist without Runs and expansion follows session replacement', { timeout: 120000 }, async t => {
  const h = await RealProcessHarness.create(t, { extension: true });
  const stream = await h.connect();
  const receipt = await h.command('extension_command', { text: '/r16-ui' });
  await h.workerPid();
  await h.terminal(receipt.commandId);
  const snapshot = await h.http('GET', `/v1/sessions/${h.sessionId}/snapshot`);
  const details = snapshot.notices.filter(n => n.kind === 'extension_ui').map(n => n.details);
  assert.deepEqual(details, [
    { method: 'setToolsExpanded', args: [false] },
    { method: 'setStatus', args: ['tools-before', 'false'] },
    { method: 'setToolsExpanded', args: [true] },
    { method: 'setStatus', args: ['tools-after', 'true'] },
    { method: 'setWorkingMessage', args: ['Checking extension UI'] },
    { method: 'setWorkingVisible', args: [false] },
    { method: 'setWorkingIndicator', args: [{ frames: ['a', 'b'], intervalMs: 120 }] },
    { method: 'setHiddenThinkingLabel', args: ['Private reasoning'] },
    { method: 'setTitle', args: ['Extension window'] }
  ]);
  assert.equal(h.provider.requests.length, 0);
  assert.equal(h.query('SELECT COUNT(*) AS count FROM runs')[0].count, 0);
  assert.equal(h.query('SELECT title FROM sessions WHERE id = ?', h.sessionId)[0].title, 'R16 real SDK');
  await until(() => stream.events().filter(e => e.type === 'runtime.notice' && e.payload.kind === 'extension_ui').length === details.length, 'UI notices broadcast');
  stream.socket.terminate();
  const replay = await h.connect();
  assert.deepEqual(replay.events().filter(e => e.type === 'runtime.notice' && e.payload.kind === 'extension_ui').map(e => e.payload.details), details);
  const sourceId = h.sessionId;
  const replacement = await h.command('extension_command', { text: '/r16-new' });
  await h.terminal(replacement.commandId);
  const destination = h.query('SELECT id FROM sessions WHERE id != ?', sourceId)[0];
  assert.ok(destination);
  h.sessionId = destination.id;
  const target = await h.http('GET', `/v1/sessions/${h.sessionId}/snapshot`);
  assert.deepEqual(target.notices.filter(n => n.details?.method === 'setToolsExpanded').map(n => n.details.args), [[true]]);
  const reset = await h.command('extension_command', { text: '/r16-ui reset' });
  await h.terminal(reset.commandId);
  const final = await h.http('GET', `/v1/sessions/${h.sessionId}/snapshot`);
  assert.ok(final.notices.some(n => n.details?.method === 'setStatus' && JSON.stringify(n.details.args) === JSON.stringify(['tools-before', 'true'])));
  assert.ok(final.notices.some(n => n.details?.method === 'setStatus' && JSON.stringify(n.details.args) === JSON.stringify(['tools-after', 'false'])));
});

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
