import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Test-only timing gates around real manager methods. No message rewriting,
// fake worker, replacement persistence or production endpoint. The parent
// test checks the real on-disk state, then SIGKILLs this stopped process.
export function installFaultCheckpoints(manager, stateDir) {
  const arm = join(stateDir, 'fault-arm');
  function checkpoint(point, payload) {
    if (!existsSync(arm) || readFileSync(arm, 'utf8') !== point) return;
    unlinkSync(arm);
    writeFileSync(join(stateDir, 'fault-reached'), JSON.stringify({ point, payload }));
    process.kill(process.pid, 'SIGSTOP');
  }
  const bound = manager.handleReplacementBound.bind(manager);
  manager.handleReplacementBound = (worker, payload) => {
    checkpoint('before-bound', payload);
    return bound(worker, payload);
  };
  const send = manager.send.bind(manager);
  manager.send = (worker, type, payload) => {
    if (type === 'session_replace_ack' && payload.phase === 'bound') checkpoint('before-bound-ack', payload);
    return send(worker, type, payload);
  };
  const batch = manager.handleEventBatch.bind(manager);
  manager.handleEventBatch = (worker, message, ...rest) => {
    if (message.payload.events.some(event => event.type === 'session.updated' && event.payload.changes?.title === 'TITLE_AFTER_CRASH')) {
      checkpoint('before-title-commit', { sessionId: worker.sessionId });
    }
    return batch(worker, message, ...rest);
  };
}
