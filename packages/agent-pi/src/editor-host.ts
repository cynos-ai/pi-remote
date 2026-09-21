import type { ExtensionUIContext, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider, EditorComponent } from "@earendil-works/pi-tui";
import { runCustomUi } from "./custom-ui.js";

type Factory = NonNullable<Parameters<ExtensionUIContext["setEditorComponent"]>[0]>;
type Wrapper = Parameters<ExtensionUIContext["addAutocompleteProvider"]>[0];
type Bridge = Parameters<typeof runCustomUi>[1] & {
  changed(text: string): void;
  submit(text: string): Promise<void>;
  failure(error: unknown): void;
  autocomplete(): AutocompleteProvider;
  paddingX?: number;
  autocompleteMaxVisible?: number;
  shortcuts?(keys: KeybindingsManager): (data: string) => boolean;
  actions?: ReadonlyMap<string, () => void | Promise<void>>;
  pasteImage?: () => void | Promise<void>;
};

/** Keep editor state and callbacks in the worker; use one-shot controls for input. */
export class EditorHost {
  private component?: EditorComponent;
  private factory?: Factory;
  private text = "";
  private revision = 0;
  private controller?: AbortController;
  private wrappers: Wrapper[] = [];
  private bridge?: Bridge;
  private refresh?: () => void;
  private keys?: KeybindingsManager;

  getFactory(): Factory | undefined { return this.factory; }
  getKeybindings(): KeybindingsManager | undefined { return this.keys; }
  getText(): string { return this.component?.getText() ?? this.text; }
  async submitCurrent(submit = this.bridge?.submit): Promise<boolean> {
    const editor = this.component;
    if (!editor || !submit) return false;
    const expanded = (editor as EditorComponent & { getExpandedText?(): string }).getExpandedText?.();
    const text = (expanded ?? editor.getText()).trim();
    if (!text) return false;
    await this.submitText(editor, text, submit);
    return true;
  }
  refreshAutocomplete(): void { if (this.component && this.bridge) this.component.setAutocompleteProvider?.(this.autocomplete()); }
  setPaddingX(value: number): void { this.component?.setPaddingX?.(value); this.refresh?.(); }
  setAutocompleteMaxVisible(value: number): void { this.component?.setAutocompleteMaxVisible?.(value); this.refresh?.(); }
  setText(text: string): void {
    if (text !== this.getText()) this.revision++;
    this.text = text;
    this.component?.setText(text);
    this.sync();
  }
  paste(text: string): void {
    if (this.component?.insertTextAtCursor) this.component.insertTextAtCursor(text);
    else if (this.component) this.component.handleInput(`\u001b[200~${text}\u001b[201~`);
    else this.text += text;
    this.sync();
  }
  addAutocompleteProvider(wrapper: Wrapper): void {
    this.wrappers.push(wrapper);
    this.component?.setAutocompleteProvider?.(this.autocomplete());
  }
  private autocomplete(): AutocompleteProvider {
    let provider = this.bridge!.autocomplete();
    const triggers: string[] = [];
    for (const wrap of this.wrappers) {
      provider = wrap(provider);
      triggers.push(...provider.triggerCharacters ?? []);
    }
    if (triggers.length) provider.triggerCharacters = [...new Set(triggers)];
    return provider;
  }
  private sync(): void {
    const next = this.component?.getText() ?? this.text;
    if (next !== this.text) this.revision++;
    this.text = next;
    this.bridge?.changed(this.text);
    this.refresh?.();
  }

  private async submitText(editor: EditorComponent, text: string, submit: (text: string) => Promise<void>): Promise<void> {
    editor.addToHistory?.(text);
    editor.setText(""); this.sync(); this.refresh?.();
    const submittedRevision = this.revision;
    try {
      await submit(text);
    } catch (error) {
      if (this.component === editor && this.revision === submittedRevision && editor.getText() === "") {
        editor.setText(text); this.sync(); this.refresh?.();
      }
      throw error;
    }
  }

  async run(factory: Factory, bridge: Bridge): Promise<void> {
    this.stop();
    this.factory = factory;
    this.bridge = bridge;
    const controller = new AbortController();
    this.controller = controller;
    const abort = () => controller.abort();
    bridge.signal.addEventListener("abort", abort, { once: true });
    if (bridge.signal.aborted) abort();
    try {
      await runCustomUi((tui, theme, keys) => {
        const editor = factory(tui, {
          borderColor: text => theme.fg("borderMuted", text),
          selectList: {
            selectedPrefix: text => theme.fg("accent", text), selectedText: text => theme.fg("accent", text),
            description: text => theme.fg("muted", text), scrollInfo: text => theme.fg("muted", text), noMatch: text => theme.fg("muted", text)
          }
        }, keys);
        if (controller.signal.aborted) return editor;
        this.component = editor;
        this.keys = keys;
        try {
          this.refresh = () => tui.requestRender();
          const custom = editor as EditorComponent & {
            actionHandlers?: Map<unknown, unknown>; onExtensionShortcut?: (data: string) => boolean;
            onPasteImage?: () => void;
          };
          custom.onPasteImage = () => {
            if (this.component !== editor || controller.signal.aborted) return;
            try { void Promise.resolve(bridge.pasteImage?.()).catch(bridge.failure); }
            catch (error) { bridge.failure(error); }
          };
          if (custom.actionHandlers instanceof Map) {
            if (!custom.onExtensionShortcut) custom.onExtensionShortcut = bridge.shortcuts?.(keys);
            for (const [action, handler] of bridge.actions ?? []) {
              const invoke = () => {
                if (this.component !== editor || controller.signal.aborted) return;
                try { void Promise.resolve(handler()).catch(bridge.failure); }
                catch (error) { bridge.failure(error); }
              };
              // Native CustomEditor owns matching, completion and history priority.
              custom.actionHandlers.set(action, invoke);
            }
          }
          editor.onChange = () => { if (this.component === editor) { this.sync(); tui.requestRender(); } };
          editor.onSubmit = text => {
            if (this.component !== editor || controller.signal.aborted || !text.trim()) return;
            void this.submitText(editor, text.trim(), bridge.submit).catch(bridge.failure);
          };
          editor.setText(this.text);
          if (bridge.paddingX !== undefined) editor.setPaddingX?.(bridge.paddingX);
          if (bridge.autocompleteMaxVisible !== undefined) editor.setAutocompleteMaxVisible?.(bridge.autocompleteMaxVisible);
          editor.setAutocompleteProvider?.(this.autocomplete());
          this.sync();
          return {
            render: width => editor.render(width), invalidate: () => editor.invalidate(),
            handleInput: data => { editor.handleInput(data); this.sync(); },
            get focused() { return (editor as EditorComponent & { focused?: boolean }).focused ?? false; },
            set focused(value: boolean) { (editor as EditorComponent & { focused?: boolean }).focused = value; },
            dispose: () => {
              if (this.component === editor) { this.text = editor.getText(); this.component = undefined; }
              (editor as EditorComponent & { dispose?(): void }).dispose?.();
            }
          };
        } catch (error) {
          if (this.component === editor) this.component = undefined;
          try { (editor as EditorComponent & { dispose?(): void }).dispose?.(); } catch (disposeError) { bridge.failure(disposeError); }
          throw error;
        }
      }, { ...bridge, signal: controller.signal });
    } finally {
      bridge.signal.removeEventListener("abort", abort);
      if (this.controller === controller) {
        this.text = this.getText(); this.component = undefined; this.factory = undefined; this.controller = undefined;
        bridge.changed(this.text); this.bridge = undefined; this.refresh = undefined; this.keys = undefined;
      }
    }
  }

  stop(): void {
    this.text = this.getText();
    this.component = undefined;
    this.factory = undefined;
    this.controller?.abort();
    this.controller = undefined;
    this.bridge = undefined;
    this.refresh = undefined;
    this.keys = undefined;
  }

  reset(): void { this.stop(); this.wrappers = []; }
}
