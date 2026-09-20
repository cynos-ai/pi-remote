import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { RealProcessHarness, until } from './real-process-harness.mjs';

const options = { timeout: 300000 };

async function freshBash(h) {
  const command = await h.command('bash', { command: "printf 'fresh\n' >> fresh-effects; printf 'fresh-output\n'" });
  await h.workerPid();
  await h.terminal(command.commandId);
  assert.deepEqual(await h.lines('fresh-effects'), ['fresh']);
}

async function assertReplay(h, afterSeq = 0) {
  const replay = await h.connect(afterSeq);
  const events = replay.events();
  const durable = h.query('SELECT seq, type, payload_json FROM events WHERE session_id = ? AND seq > ? ORDER BY seq', h.sessionId, afterSeq);
  assert.ok(events.length > 0, 'must replay actual durable production events');
  assert.deepEqual(events.map(e => e.seq), durable.map(e => e.seq));
  for (let i = 0; i < events.length; i++) {
    assert.equal(events[i].seq, afterSeq + i + 1, 'gap-free cursor replay');
    assert.equal(events[i].type, durable[i].type);
    assert.deepEqual(events[i].payload, JSON.parse(durable[i].payload_json));
  }
  return events;
}

test('real HTTPS/WSS + production SDK: streamed model tool round trip, JSONL, idempotency, restart', options, async t => {
  const h = await RealProcessHarness.create(t);
  const live = await h.connect();
  const key = randomUUID();
  const receipt = await h.command('prompt', { text: 'TOOL_BASH' }, key);
  const pid = await h.workerPid();
  assert.notEqual(pid, h.main.pid);
  await h.terminal(receipt.commandId);
  await until(() => live.events().some(e => e.type === 'run.updated' && e.payload.status === 'completed'), 'live completed Run');
  const events = live.events();
  const starts = events.filter(e => e.type === 'message.started' && e.payload.role === 'assistant');
  const ends = events.filter(e => e.type === 'message.completed' && e.payload.role === 'assistant');
  assert.equal(starts.length, 2, 'tool-call assistant message then final answer');
  assert.deepEqual(starts.map(e => e.payload.messageId), ends.map(e => e.payload.messageId));
  assert.ok(events.some(e => e.type === 'tool.finished' && JSON.stringify(e.payload).includes('tool-result-marker')));
  assert.ok(events.some(e => e.type === 'content.delta'));
  assert.equal(h.provider.requests.length, 2);
  assert.ok(h.provider.requests[1].messages.some(m => m.role === 'tool' && JSON.stringify(m).includes('tool-result-marker')));
  assert.deepEqual(await h.lines('model-effects'), ['model-tool']);
  const mapping = h.query('SELECT pi_session_id, pi_session_file, pi_persistence_state FROM sessions WHERE id = ?', h.sessionId)[0];
  assert.equal(mapping.pi_persistence_state, 'persisted');
  const jsonl = (await readFile(mapping.pi_session_file, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(jsonl[0].id, mapping.pi_session_id);
  assert.ok(jsonl.some(entry => JSON.stringify(entry).includes('local-stream-complete')));
  assert.deepEqual((await h.http('GET', `/v1/sessions/${h.sessionId}/snapshot`)).liveItems, []);
  const cursor = events.at(-1).seq;
  live.socket.terminate();
  await h.killMain();
  await h.start();
  assert.equal((await h.command('prompt', { text: 'TOOL_BASH' }, key)).commandId, receipt.commandId);
  await h.terminal(receipt.commandId);
  await freshBash(h);
  await assertReplay(h, cursor);
  assert.deepEqual(await h.lines('model-effects'), ['model-tool']);
  assert.equal(h.provider.requests.length, 2, 'completed prompt never re-executed after restart');
  const reopened = h.query('SELECT pi_session_id FROM sessions WHERE id = ?', h.sessionId)[0];
  assert.equal(reopened.pi_session_id, mapping.pi_session_id);
});

test('real provider HTTP error becomes failed Command and Run', options, async t => {
  const h = await RealProcessHarness.create(t);
  const command = await h.command('prompt', { text: 'PROVIDER_ERROR' });
  await h.workerPid();
  await h.terminal(command.commandId, 'failed');
  const events = await assertReplay(h);
  assert.ok(events.some(e => e.type === 'run.updated' && e.payload.status === 'failed'));
  assert.ok(!events.some(e => e.type === 'run.updated' && e.payload.status === 'completed'));
  assert.equal(h.provider.requests.length, 1);
});

for (const fault of ['worker-executing', 'main-executing', 'main-before-result-persisted']) {
  test(`real external SIGKILL: ${fault}, durable unknown result, one Bash side effect, explicit restart`, options, async t => {
    const h = await RealProcessHarness.create(t);
    // Keep Bash fault coverage independent of model-message defects. This also
    // exercises restart of a mapping with no assistant-flushed JSONL yet.
    const live = await h.connect();
    const key = randomUUID();
    const payload = { command: "printf '%s\n' \"$$\" >> shell-pids; printf 'effect\n' >> effects; printf 'before-gate\n'; while [ ! -f release ]; do sleep 0.05; done; printf 'finished\n' >> shell-finished; printf 'after-gate\n'" };
    const command = await h.command('bash', payload, key);
    const worker = await h.workerPid();
    await until(async () => (await h.lines('effects')).length === 1, 'actual Bash side effect before kill');
    await until(() => h.query('SELECT state FROM commands WHERE id = ?', command.commandId)[0]?.state === 'accepted', 'command acceptance persisted before fault injection');
    if (fault === 'worker-executing') {
      process.kill(worker, 'SIGKILL');
    } else {
      if (fault === 'main-before-result-persisted') {
        process.kill(h.main.pid, 'SIGSTOP');
        await until(async () => /State:\s+T/.test(await readFile(`/proc/${h.main.pid}/status`, 'utf8')), 'main stopped before releasing Bash');
        await writeFile(join(h.project, 'release'), 'go');
        await until(async () => (await h.lines('shell-finished')).length === 1, 'Bash finished while main cannot persist result');
        assert.equal(h.query('SELECT state FROM commands WHERE id = ?', command.commandId)[0].state, 'accepted');
      }
      await h.killMain();
      await h.start();
    }
    await h.terminal(command.commandId, 'unknown');
    const replay = await assertReplay(h);
    assert.ok(replay.some(e => e.type === 'operation.updated' && e.payload.commandId === command.commandId && e.payload.status === 'interrupted'));
    assert.equal((await h.command('bash', payload, key)).commandId, command.commandId);
    await h.terminal(command.commandId, 'unknown');
    assert.equal(h.query('SELECT count(*) AS n FROM commands WHERE client_command_id = ?', key)[0].n, 1);
    assert.deepEqual(await h.lines('effects'), ['effect']);
    // Let any surviving shell settle. Its completion cannot authorize replay.
    await writeFile(join(h.project, 'release'), 'go');
    await freshBash(h);
    assert.deepEqual(await h.lines('effects'), ['effect']);
    live.socket.terminate();
    await assertReplay(h);
  });
}

test('real SDK stop returns duplicate unconsumed steer drafts without replay', options, async t => {
  const h = await RealProcessHarness.create(t);
  const live = await h.connect();
  const prompt = await h.command('prompt', { text: 'HOLD_MODEL' });
  await h.workerPid();
  await until(() => live.events().some(e => e.type === 'content.delta'), 'SDK partial stream');
  const commands = [];
  for (let n = 0; n < 2; n++) {
    commands.push(await h.command('steer', { targetRunId: prompt.runId, text: 'duplicate unconsumed draft' }));
  }
  await until(() => live.events().filter(e => e.type === 'input.updated' && e.payload.state === 'queued').length === 2, 'SDK queued both inputs');
  const stopped = await h.command('abort', { targetRunId: prompt.runId });
  await h.terminal(stopped.commandId);
  await h.terminal(prompt.commandId, 'cancelled');
  const events = await assertReplay(h);
  assert.ok(events.some(e => e.type === 'run.updated' && e.runId === prompt.runId && e.payload.status === 'aborted'));
  const returned = events.filter(e => e.type === 'input.updated' && e.payload.state === 'returned');
  assert.equal(returned.length, 2);
  assert.equal(new Set(returned.map(e => e.payload.inputId)).size, 2);
  assert.deepEqual(returned.map(e => e.payload.commandId).sort(), commands.map(c => c.commandId).sort());
  assert.ok(returned.every(e => e.payload.content.text === 'duplicate unconsumed draft'));
  assert.ok(!events.some(e => e.type === 'input.updated' && e.payload.state === 'consumed'));
  assert.equal(h.provider.requests.length, 1);
  const snapshot = await h.http('GET', `/v1/sessions/${h.sessionId}/snapshot`);
  assert.deepEqual(snapshot.liveItems, []);
  assert.deepEqual(snapshot.recoveredInputs.map(input => ({ id: input.inputId, text: input.content.text })).sort((a, b) => a.id.localeCompare(b.id)),
    returned.map(e => ({ id: e.payload.inputId, text: 'duplicate unconsumed draft' })).sort((a, b) => a.id.localeCompare(b.id)));
});

test('real main SIGKILL preserves HTTP-created undispatched follow_up and seals active partial', options, async t => {
  const h = await RealProcessHarness.create(t);
  const live = await h.connect();
  const active = await h.command('prompt', { text: 'HOLD_MODEL' });
  await h.workerPid();
  await until(() => live.events().some(e => e.type === 'content.delta'), 'active SDK stream before queueing tail');
  const tail = await h.command('follow_up', { text: 'must remain queued after crash' });
  assert.equal(h.query('SELECT state FROM commands WHERE id = ?', tail.commandId)[0].state, 'queued');
  assert.equal(h.query('SELECT dispatched_at FROM commands WHERE id = ?', tail.commandId)[0].dispatched_at, null, 'tail has not crossed execute IPC');
  assert.equal(h.query('SELECT status FROM runs WHERE id = ?', tail.runId)[0].status, 'queued');
  await h.killMain();
  await h.start();
  await h.terminal(active.commandId, 'unknown');
  const snapshot = await h.http('GET', `/v1/sessions/${h.sessionId}/snapshot`);
  assert.equal(snapshot.queue.state, 'paused');
  assert.ok(snapshot.queue.items.some(item => item.commandId === tail.commandId && item.runId === tail.runId));
  assert.equal((await h.http('GET', `/v1/commands/${tail.commandId}`)).state, 'queued');
  assert.deepEqual(snapshot.liveItems, []);
  const events = await assertReplay(h);
  assert.ok(events.some(e => e.type === 'run.updated' && e.runId === active.runId && e.payload.status === 'interrupted'));
  assert.ok(h.query('SELECT completeness FROM timeline_items WHERE session_id = ?', h.sessionId).some(row => row.completeness === 'partial'));
  await freshBash(h);
  assert.equal(h.provider.requests.length, 1, 'no automatic replay of active prompt or queued tail');
});

test('real startup extension form survives >60 seconds and WSS reconnect before one answer', options, async t => {
  const h = await RealProcessHarness.create(t, { startupForm: true });
  const live = await h.connect();
  const command = await h.command('prompt', { text: 'startup continued' });
  const worker = await h.workerPid();
  const requested = await until(() => live.events().find(e => e.type === 'interaction.requested' && e.payload.title === 'R16 startup confirmation'), 'real session_start form');
  const cursor = requested.seq;
  live.socket.terminate();
  await delay(61500);
  process.kill(worker, 0);
  assert.equal(await h.workerPid(), worker, 'same worker survives normal ready deadline');
  assert.equal(h.provider.requests.length, 0, 'initial prompt awaits startup form');
  const snapshot = await h.http('GET', `/v1/sessions/${h.sessionId}/snapshot`);
  assert.ok(snapshot.pendingInteractions.some(i => i.interactionId === requested.payload.interactionId));
  const reconnect = await h.connect(cursor);
  const key = randomUUID();
  const payload = { interactionId: requested.payload.interactionId, operationId: requested.operationId, response: { confirmed: true } };
  const response = await h.command('respond', payload, key);
  assert.equal((await h.command('respond', payload, key)).commandId, response.commandId);
  await h.terminal(response.commandId);
  await h.terminal(command.commandId);
  assert.deepEqual(await h.lines('startup-answers'), ['answered']);
  assert.equal(h.provider.requests.length, 1);
  await until(() => reconnect.events().some(e => e.type === 'interaction.resolved'), 'resolved startup interaction over reconnected WSS');
});

test('real native new/switch withSession routes autonomous turns to mapped sessions and survives restart', options, async t => {
  const h = await RealProcessHarness.create(t, { extension: true });
  const initial = await h.command('prompt', { text: 'source history' });
  const worker = await h.workerPid();
  await h.terminal(initial.commandId);
  const sourceId = h.sessionId;
  const source = h.query('SELECT pi_session_id, pi_session_file FROM sessions WHERE id = ?', sourceId)[0];
  const created = await h.command('extension_command', { text: '/r16-new' });
  await h.terminal(created.commandId);
  const destination = await until(() => h.query('SELECT id, pi_session_id, pi_session_file FROM sessions WHERE id <> ?', sourceId)[0], 'native replacement mapped to application Session');
  h.sessionId = destination.id;
  await until(() => h.query("SELECT id FROM runs WHERE session_id = ? AND status = 'completed'", destination.id).length > 0, 'withSession new autonomous Run settled');
  const newEvents = await assertReplay(h);
  assert.ok(newEvents.some(e => e.type === 'message.completed' && JSON.stringify(e.payload).includes('WITH_SESSION_NEW')));
  assert.notEqual(destination.pi_session_id, source.pi_session_id);
  assert.equal(await h.workerPid(), worker);
  const switched = await h.command('extension_command', { text: `/r16-switch ${source.pi_session_file}` });
  await h.terminal(switched.commandId);
  h.sessionId = sourceId;
  await until(() => h.query("SELECT id FROM runs WHERE session_id = ? AND status = 'completed'", sourceId).length >= 2, 'withSession switch autonomous Run settled');
  const sourceEvents = await assertReplay(h);
  assert.ok(sourceEvents.some(e => e.type === 'message.completed' && JSON.stringify(e.payload).includes('WITH_SESSION_SWITCH')));
  assert.ok(!sourceEvents.some(e => e.type === 'message.completed' && JSON.stringify(e.payload).includes('WITH_SESSION_NEW')));
  assert.equal(await h.workerPid(), worker);
  for (const mapping of [source, destination]) {
    const jsonl = (await readFile(mapping.pi_session_file, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(jsonl[0].id, mapping.pi_session_id);
  }
  await h.killMain();
  await h.start();
  const continued = await h.command('prompt', { text: 'after switch restart' });
  await h.workerPid();
  await h.terminal(continued.commandId);
  assert.equal(h.query('SELECT pi_session_id FROM sessions WHERE id = ?', sourceId)[0].pi_session_id, source.pi_session_id);
  assert.equal(h.provider.requests.length, 4);
});
