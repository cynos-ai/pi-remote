import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { RealProcessHarness, until } from './real-process-harness.mjs';

for (const phase of ['initialize', 'configure', 'run', 'bash', 'extension']) {
  test(`native ${phase} dialogs: four kinds, cancel, expire, reconnect and duplicate response`, { timeout: 120000 }, async t => {
    const h = await RealProcessHarness.create(t, { formsPhase: phase });
    let stream = await h.connect();
    let receipt;
    if (phase === 'configure') {
      const warmup = await h.command('prompt', { text: '/forms' });
      await h.terminal(warmup.commandId);
      const snapshot = await h.http('GET', `/v1/sessions/${h.sessionId}/snapshot`);
      receipt = await h.command('set_thinking', { expectedVersion: snapshot.session.version, level: snapshot.session.thinkingLevel === 'low' ? 'high' : 'low' });
    } else if (phase === 'extension') receipt = await h.command('extension_command', { text: '/forms' });
    else if (phase === 'bash') receipt = await h.command('bash', { command: "printf 'executed\\n' >> bash-effects" });
    else receipt = await h.command('prompt', { text: phase === 'run' ? 'form test' : '/forms' });
    await h.workerPid();
    const seen = [];
    for (const mode of ['answer', 'cancel']) {
      for (const kind of ['select', 'confirm', 'input', 'editor']) {
        const title = `${mode}-${kind}`;
        const form = await until(() => stream.events().find(e => e.type === 'interaction.requested' && e.payload.title === title), title);
        const asynchronousChild = phase === 'configure' && seen.length > 0;
        assert.equal(form.payload.origin, asynchronousChild ? 'extension' : phase);
        if (asynchronousChild) {
          const operation = h.query("SELECT payload_json FROM events WHERE session_id = ? AND type = 'operation.updated' AND operation_id = ? ORDER BY seq", h.sessionId, form.operationId)
            .map(row => JSON.parse(row.payload_json)).find(value => value.parentOperationId);
          assert.equal(operation.parentOperationId, seen[0].operationId);
          await h.terminal(receipt.commandId);
        }
        assert.equal(form.payload.kind, kind);
        assert.ok(form.operationId);
        if (['initialize', 'configure', 'extension'].includes(phase)) assert.equal(form.runId, null);
        seen.push(form);
        if (mode === 'answer' && kind === 'select') {
          stream.socket.terminate();
          const snapshot = await h.http('GET', `/v1/sessions/${h.sessionId}/snapshot`);
          assert.ok(snapshot.pendingInteractions.some(item => item.interactionId === form.payload.interactionId));
          stream = await h.connect(form.seq - 1);
          assert.deepEqual(stream.events().find(e => e.seq === form.seq), form);
        }
        const response = mode === 'cancel' ? { cancelled: true } : kind === 'confirm' ? { confirmed: true }
          : { value: kind === 'select' ? 'beta' : kind === 'input' ? 'typed' : 'edited\ntext' };
        const payload = { operationId: form.operationId, interactionId: form.payload.interactionId, response };
        const key = randomUUID();
        const answer = await h.command('respond', payload, key);
        assert.equal((await h.command('respond', payload, key)).commandId, answer.commandId);
        await h.terminal(answer.commandId);
        await assert.rejects(h.command('respond', payload), /INTERACTION_CLOSED/);
      }
    }
    await until(async () => (await h.lines('form-results')).length === 1, 'SDK hook returned all actual answers');
    assert.deepEqual(JSON.parse((await h.lines('form-results'))[0]), ['beta', true, 'typed', 'edited\ntext', null, false, null, null, null]);
    await h.terminal(receipt.commandId);
    const interactions = h.query('SELECT id, status, operation_id, payload_json FROM interactions WHERE session_id = ?', h.sessionId);
    for (const form of seen) assert.equal(interactions.find(item => item.id === form.payload.interactionId).status,
      form.payload.title.startsWith('cancel') ? 'cancelled' : 'resolved');
    const expired = interactions.find(form => JSON.parse(form.payload_json).title === 'expire-input');
    assert.equal(expired.status, 'expired');
    await assert.rejects(h.command('respond', { operationId: expired.operation_id, interactionId: expired.id, response: { value: 'late' } }), /INTERACTION_CLOSED/);
    if (phase === 'bash') assert.deepEqual(await h.lines('bash-effects'), ['executed']);
    assert.equal(h.provider.requests.length, phase === 'run' ? 1 : 0, 'only run phase uses the local synthetic provider');
  });
}
