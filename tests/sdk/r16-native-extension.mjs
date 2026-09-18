import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';

// Loaded by the real SDK's normal extension discovery, from the temporary
// agentDir. No SDK internals, transport replacements or worker test hooks.
export default function extension(pi) {
  pi.on('session_start', async (_event, ctx) => {
    if (process.env.R16_STARTUP_FORM === '1') {
      const answer = await ctx.ui.confirm('R16 startup confirmation', 'Wait beyond the normal 15 second handshake, then answer.');
      if (!answer) throw new Error('R16 startup confirmation was not accepted');
      await appendFile(join(ctx.cwd, 'startup-answers'), 'answered\n');
    }
  });
  pi.registerCommand('r16-new', {
    description: 'Real native newSession with replacement-context continuation',
    handler: async (_args, ctx) => {
      await ctx.newSession({ withSession: async replacement => {
        await replacement.sendUserMessage('WITH_SESSION_NEW');
      } });
    }
  });
  pi.registerCommand('r16-switch', {
    description: 'Real native switchSession with replacement-context continuation',
    handler: async (args, ctx) => {
      await ctx.switchSession(args.trim(), { withSession: async replacement => {
        await replacement.sendUserMessage('WITH_SESSION_SWITCH');
      } });
    }
  });
}
