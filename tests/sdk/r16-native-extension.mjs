import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';

// Loaded by the real SDK's normal extension discovery, from the temporary
// agentDir. No SDK internals, transport replacements or worker test hooks.
export default function extension(pi) {
  let overlayHandle;
  pi.registerCommand('r16-overlay-show', {
    description: 'Restore a pending native overlay',
    handler: async () => { overlayHandle.setHidden(false); overlayHandle.focus(); }
  });
  pi.registerCommand('r16-overlay', {
    description: 'Native overlay geometry, hidden input and original done result',
    handler: async (_args, ctx) => {
      const path = join(ctx.cwd, 'overlay-results');
      let disposed = false;
      let inputs = 0;
      const result = await ctx.ui.custom((_tui, _theme, _keys, done) => ({
        render: width => [`overlay:${width}:${inputs}`],
        invalidate() {},
        handleInput() {
          inputs++;
          if (inputs === 1) overlayHandle.setHidden(true);
          else done({ inputs, bounds: overlayHandle.getBounds(), focused: overlayHandle.isFocused() });
        },
        dispose() { disposed = true; }
      }), { overlay: true, overlayOptions: { width: 20, row: 1, col: 2 }, onHandle: handle => { overlayHandle = handle; } });
      await appendFile(path, JSON.stringify({ result, disposed }) + '\n');
    }
  });
  pi.registerCommand('r16-custom', {
    description: 'Custom keyboard component returns its own done value',
    handler: async (_args, ctx) => {
      // Native ctx getters become stale on replacement. Capture the fixture's
      // output destination before awaiting UI; do not reuse the old ctx later.
      const resultPath = join(ctx.cwd, 'custom-results');
      let disposed = false;
      const result = await ctx.ui.custom((tui, theme, _keys, done) => {
        let down = 0;
        let text = '';
        return {
          render: () => [theme.fg('accent', `custom:${down}:${text}`)],
          invalidate() {},
          handleInput(data) {
            if (data === '\u001b[B') down++;
            else if (data === '\r') done({ down, text });
            else if (data === '\u001b') done({ escaped: true });
            else text += data;
            tui.requestRender();
          },
          dispose() { disposed = true; }
        };
      });
      await appendFile(resultPath, JSON.stringify({ result: result ?? null, disposed }) + '\n');
      if (_args.trim() === 'error') throw new Error('custom source callback failure');
    }
  });
  pi.registerCommand('r16-widget', {
    description: 'Native widget factory with delayed refresh and disposal',
    handler: async (args, ctx) => {
      if (args.trim() === 'clear') { ctx.ui.setWidget('native-widget', undefined); return; }
      ctx.ui.setWidget('native-widget', (tui, theme) => {
        let count = 0;
        const timer = setInterval(() => { count++; tui.requestRender(); if (count === 2) clearInterval(timer); }, 100);
        return {
          render: width => [theme.fg('accent', `native-widget:${count}:${width}`)],
          invalidate() {},
          dispose() { clearInterval(timer); void appendFile(join(ctx.cwd, 'widget-disposed'), 'disposed\n'); }
        };
      }, { placement: 'belowEditor' });
    }
  });
  pi.registerCommand('r16-ui', {
    description: 'Native scalar UI controls without a model Run',
    handler: async (args, ctx) => {
      ctx.ui.setStatus('tools-before', String(ctx.ui.getToolsExpanded()));
      ctx.ui.setToolsExpanded(args.trim() !== 'reset');
      ctx.ui.setStatus('tools-after', String(ctx.ui.getToolsExpanded()));
      ctx.ui.setWorkingMessage('Checking extension UI');
      ctx.ui.setWorkingVisible(false);
      ctx.ui.setWorkingIndicator({ frames: ['a', 'b'], intervalMs: 120 });
      ctx.ui.setHiddenThinkingLabel('Private reasoning');
      ctx.ui.setTitle('Extension window');
    }
  });
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
  pi.registerCommand('r16-fork', {
    description: 'Native fork followed by two causally related model runs',
    handler: async (args, ctx) => {
      await ctx.fork(args.trim(), { position: 'at', withSession: async replacement => {
        await replacement.sendUserMessage('FORK_FIRST');
        await replacement.sendUserMessage('FORK_SECOND');
      } });
    }
  });
  pi.registerCommand('r16-title', {
    description: 'Native extension title event',
    handler: async args => { pi.setSessionName(args.trim()); }
  });
}
