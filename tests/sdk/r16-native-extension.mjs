import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CustomEditor } from '@earendil-works/pi-coding-agent';
import { matchesKey } from '@earendil-works/pi-tui';

// Loaded by the real SDK's normal extension discovery, from the temporary
// agentDir. No SDK internals, transport replacements or worker test hooks.
export default function extension(pi) {
  let cancelFork = false;
  pi.registerCommand('r16-fork-cancel', { description: 'Veto native fork', handler: async args => { cancelFork = args.trim() === 'on'; } });
  pi.on('session_before_fork', async () => cancelFork ? { cancel: true } : undefined);
  let configurationHooks = '';
  pi.registerCommand('r16-config-hooks', { description: 'Enable native configuration forms', handler: async (args) => { configurationHooks = args.trim(); } });
  pi.on('model_select', async (event, ctx) => {
    if (configurationHooks !== 'model') return;
    const first = await ctx.ui.confirm('editor-model-first', 'First model hook');
    await new Promise(resolve => setTimeout(resolve, 20));
    const second = await ctx.ui.input('editor-model-second', 'Second model hook');
    await appendFile(join(ctx.cwd, 'editor-model-hooks'), JSON.stringify({ source: event.source, first, second }) + '\n');
  });
  pi.on('thinking_level_select', async (_event, ctx) => {
    if (configurationHooks !== 'thinking') return;
    const first = await ctx.ui.confirm('editor-thinking-first', 'First thinking hook');
    await new Promise(resolve => setTimeout(resolve, 20));
    const second = await ctx.ui.input('editor-thinking-second', 'Second thinking hook');
    await appendFile(join(ctx.cwd, 'editor-thinking-hooks'), JSON.stringify({ first, second }) + '\n');
  });
  let removeKeys = [];
  pi.registerShortcut('ctrl+alt+k', {
    description: 'Native shortcut test',
    handler: async ctx => {
      await appendFile(join(ctx.cwd, 'shortcut-calls'), 'shortcut\n');
      ctx.ui.setStatus('keys-shortcut', 'done');
    }
  });
  pi.registerShortcut('ctrl+alt+e', { description: 'Native shortcut error', handler: () => { throw new Error('shortcut input failure'); } });
  pi.registerCommand('r16-keys', {
    description: 'Subscribe terminal listeners in native order',
    handler: async (_args, ctx) => {
      removeKeys = [
        ctx.ui.onTerminalInput(data => {
          if (matchesKey(data, 'ctrl+alt+x')) { ctx.ui.setStatus('keys-consumed', 'yes'); return { consume: true }; }
          if (matchesKey(data, 'ctrl+alt+j')) return { data: '\u001b[107;7u' };
        }),
        ctx.ui.onTerminalInput(data => { ctx.ui.setStatus('keys-observed', matchesKey(data, 'ctrl+alt+k') ? 'shortcut' : 'other'); })
      ];
    }
  });
  pi.registerCommand('r16-keys-off', { description: 'Unsubscribe native listeners', handler: async () => { for (const remove of removeKeys) { remove(); remove(); } removeKeys = []; } });
  pi.registerCommand('r16-editor-draft', { description: 'Set native editor draft', handler: async (args, ctx) => ctx.ui.setEditorText(args) });
  pi.registerCommand('r16-editor-paste', { description: 'Paste at native cursor', handler: async (args, ctx) => ctx.ui.pasteToEditor(args) });
  pi.registerCommand('r16-editor-clear', { description: 'Restore default editor', handler: async (_args, ctx) => ctx.ui.setEditorComponent(undefined) });
  pi.registerCommand('r16-editor', {
    description: 'Install the real CustomEditor and native autocomplete wrapper',
    handler: async (_args, ctx) => {
      const disposePath = join(ctx.cwd, 'editor-disposed');
      ctx.ui.setEditorText('seed');
      ctx.ui.addAutocompleteProvider(base => ({
        ...base,
        getSuggestions: async (lines, line, col, options) => lines[line]?.startsWith('com')
          ? { prefix: 'com', items: [{ value: 'EDITOR_NATIVE_SUBMIT', label: 'EDITOR_NATIVE_SUBMIT' }] }
          : lines[line]?.startsWith('cho')
            ? { prefix: 'cho', items: [{ value: 'choice-one', label: 'choice-one' }, { value: 'choice-two', label: 'choice-two' }] }
            : base.getSuggestions(lines, line, col, options),
        applyCompletion: (lines, line, col, item, prefix) => item.value === 'EDITOR_NATIVE_SUBMIT'
          ? { lines: ['EDITOR_NATIVE_SUBMIT'], cursorLine: 0, cursorCol: 20 }
          : base.applyCompletion(lines, line, col, item, prefix)
      }));
      const factory = (tui, theme, keys) => {
        class TestEditor extends CustomEditor {
          dispose() { void appendFile(disposePath, 'disposed\n'); }
        }
        return new TestEditor(tui, theme, keys);
      };
      ctx.ui.setEditorComponent(factory);
      ctx.ui.setStatus('editor-factory', String(ctx.ui.getEditorComponent() === factory));
    }
  });
  pi.registerCommand('r16-surface', {
    description: 'Native header/footer factories and footer data',
    handler: async (args, ctx) => {
      if (args.trim() === 'clear') { ctx.ui.setHeader(undefined); ctx.ui.setFooter(undefined); return; }
      if (args.trim() === 'status') { ctx.ui.setStatus('surface', 'updated'); return; }
      if (args.trim() === 'fail') { ctx.ui.setHeader(() => { throw new Error('surface factory failed'); }); return; }
      const disposedPath = join(ctx.cwd, 'surface-disposed');
      const refreshPath = join(ctx.cwd, 'surface-refresh');
      ctx.ui.setStatus('surface', 'ready');
      ctx.ui.setHeader((tui, theme) => {
        let count = 0;
        let expanded = false;
        const timer = setInterval(async () => {
          try {
            const next = Number(await readFile(refreshPath, 'utf8'));
            if (next !== count) { count = next; tui.requestRender(); }
          } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }, 50);
        return {
          render: width => [theme.fg('accent', `header:${width}:${count}:${expanded}`)],
          invalidate() {}, setExpanded(value) { expanded = value; },
          dispose() { clearInterval(timer); void appendFile(disposedPath, 'header\n'); }
        };
      });
      ctx.ui.setFooter((tui, theme, data) => {
        const unsubscribe = data.onBranchChange(() => tui.requestRender());
        return {
          render: width => [theme.fg('accent', `footer:${width}:${data.getGitBranch()}:${data.getExtensionStatuses().get('surface')}:${data.getAvailableProviderCount()}`)],
          invalidate() {}, dispose() { unsubscribe(); void appendFile(disposedPath, 'footer\n'); }
        };
      });
    }
  });
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
