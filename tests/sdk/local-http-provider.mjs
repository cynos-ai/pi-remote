import { createServer } from 'node:http';

/** Deterministic OpenAI-compatible transport, NOT a replacement worker or SDK.
 * Only this model endpoint is synthetic; pi performs parsing, tool execution,
 * streaming, JSONL persistence and IPC using its production code.
 */
export async function localHttpProvider() {
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
    if (text.includes('HOLD_MODEL')) {
      chunk({ content: 'partial-before-stop' });
      held.add(res);
      res.on('close', () => held.delete(res));
      return;
    }
    if (text.includes('TOOL_BASH') && !body.messages.slice(lastUser + 1).some(m => m.role === 'tool')) {
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
