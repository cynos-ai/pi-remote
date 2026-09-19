import { createServer } from 'node:http';

/** Deterministic OpenAI-compatible transport, NOT a replacement worker or SDK.
 * Only this model endpoint is synthetic; pi performs parsing, tool execution,
 * streaming, JSONL persistence and IPC using its production code.
 */
export async function localHttpProvider(options = {}) {
  const requests = [];
  const held = new Set();
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404).end();
      return;
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    const lastUser = body.messages.findLastIndex(m => m.role === 'user');
    const prompt = body.messages[lastUser]?.content;
    const text = typeof prompt === 'string' ? prompt : JSON.stringify(prompt);
    if (text.includes('PROVIDER_ERROR')) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'deterministic local provider failure', type: 'invalid_request_error' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({
      id: 'local-completion', object: 'chat.completion.chunk', created: 1, model: 'deterministic',
      choices: [{ index: 0, delta, finish_reason }]
    })}\n\n`);
    chunk({ role: 'assistant' });
    if (options.emptyStream) {
      chunk({}, 'stop');
      res.end('data: [DONE]\n\n');
      return;
    }
    if (text.includes('HOLD_MODEL')) {
      chunk({ content: 'partial-before-stop' });
      held.add(res);
      res.on('close', () => held.delete(res));
      return;
    }
    const results = body.messages.slice(lastUser + 1).filter(m => m.role === 'tool');
    if (options.compact && body.tools?.length && /COMPACT_(GATE|AFTER)/.test(text) && !results.length) {
      const name = text.includes('COMPACT_AFTER') ? 'write' : 'bash';
      const args = name === 'write' ? { path: 'compact-result.txt', content: 'pi-compact-marker' } : { command: 'bash compact-gate.sh' };
      chunk({ tool_calls: [{ index: 0, id: `compact-${requests.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
      chunk({}, 'tool_calls');
    } else if (options.compact) {
      chunk({ content: 'Project marker: pi-compact-marker. Keep the queued user instructions.' });
      chunk({}, 'stop');
    } else if (options.controls && /CONTROL_(GATE|STEER|FOLLOW)/.test(text) && !results.length) {
      const command = text.includes('CONTROL_STEER') ? "printf 'steer\\n' >> effects"
        : text.includes('CONTROL_FOLLOW') ? "printf 'follow\\n' >> effects" : text.includes('fresh-gate.sh') ? 'bash fresh-gate.sh' : 'bash gate.sh';
      chunk({ tool_calls: [{ index: 0, id: `control-${requests.length}`, type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command }) } }] });
      chunk({}, 'tool_calls');
    } else if (options.toolCopy && results.length < 2) {
      const name = results.length === 0 ? 'read' : 'write';
      const args = results.length === 0 ? { path: 'marker.txt' } : { path: 'result.txt', content: 'pi-live-marker\n' };
      chunk({ tool_calls: [{ index: 0, id: `copy-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
      chunk({}, 'tool_calls');
    } else if (text.includes('TOOL_BASH') && !results.length) {
      chunk({ tool_calls: [{ index: 0, id: 'local-bash-call', type: 'function', function: { name: 'bash', arguments: '' } }] });
      const args = JSON.stringify({ command: "printf 'model-tool\n' >> model-effects; printf 'tool-result-marker\n'" });
      for (const part of [args.slice(0, 20), args.slice(20)]) {
        chunk({ tool_calls: [{ index: 0, function: { arguments: part } }] });
      }
      chunk({}, 'tool_calls');
    } else {
      for (const content of ['local-', 'stream-', 'complete']) chunk({ content });
      chunk({}, 'stop');
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, requests,
    async close() {
      for (const response of held) response.destroy();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  };
}
