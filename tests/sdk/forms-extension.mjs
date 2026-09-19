import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';

// Discovered by the unmodified SDK in an isolated test agent directory.
export default function extension(pi) {
  const phase = process.env.R16_FORMS_PHASE;
  async function forms(ctx) {
    const results = [];
    for (const cancelled of [false, true]) {
      const label = cancelled ? 'cancel' : 'answer';
      results.push(await ctx.ui.select(`${label}-select`, ['alpha', 'beta']));
      results.push(await ctx.ui.confirm(`${label}-confirm`, 'Continue?'));
      results.push(await ctx.ui.input(`${label}-input`, 'placeholder'));
      results.push(await ctx.ui.editor(`${label}-editor`, 'prefill'));
    }
    results.push(await ctx.ui.input('expire-input', 'Do not answer', { timeout: 200 }));
    await appendFile(join(ctx.cwd, 'form-results'), JSON.stringify(results) + '\n');
  }
  if (phase === 'initialize') pi.on('session_start', async (_event, ctx) => forms(ctx));
  if (phase === 'configure') pi.on('thinking_level_select', async (_event, ctx) => forms(ctx));
  if (phase === 'run') pi.on('before_agent_start', async (_event, ctx) => { await forms(ctx); });
  if (phase === 'bash') pi.on('user_bash', async (_event, ctx) => { await forms(ctx); });
  pi.registerCommand('forms', { description: 'Exercise native dialogs', handler: async (_args, ctx) => {
    if (phase === 'extension') await forms(ctx);
  } });
}
