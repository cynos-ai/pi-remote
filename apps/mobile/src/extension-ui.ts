export interface ExtensionUiState {
  seq: number;
  statuses: Record<string, string>;
  widgets: Record<string, string[]>;
  workingMessage: string;
  editorText: string;
  editorSelection?: { start: number; end: number };
  unsupported: string | null;
}

export const emptyExtensionUi = (): ExtensionUiState => ({
  seq: 0, statuses: {}, widgets: {}, workingMessage: "", editorText: "", unsupported: null
});

export interface ExtensionNotice {
  seq: number;
  kind: string;
  details?: Record<string, unknown>;
}

export function applyExtensionNotice(state: ExtensionUiState, notice: ExtensionNotice): ExtensionUiState {
  if (notice.kind !== "extension_ui" || notice.seq <= state.seq) return state;
  const next = { ...state, seq: notice.seq, statuses: { ...state.statuses }, widgets: { ...state.widgets } };
  const method = notice.details?.method;
  const args = notice.details?.args;
  if (!Array.isArray(args)) return { ...next, unsupported: "扩展 UI 参数无法读取" };
  const [key, value] = args;
  switch (method) {
    case "setStatus":
      if (typeof key === "string") {
        if (typeof value === "string") next.statuses[key] = value;
        else delete next.statuses[key];
      }
      break;
    case "setWidget":
      if (typeof key === "string") {
        if (Array.isArray(value) && value.every((line) => typeof line === "string")) next.widgets[key] = value;
        else if (value == null) delete next.widgets[key];
        else next.unsupported = "此扩展 widget 使用终端渲染函数，需要扩展提供文本回退";
      }
      break;
    case "setWorkingMessage": next.workingMessage = typeof key === "string" ? key : ""; break;
    case "setEditorText":
      if (typeof key === "string") { next.editorText = key; next.editorSelection = { start: key.length, end: key.length }; }
      break;
    case "pasteToEditor":
      if (typeof key === "string") {
        const start = Math.min(next.editorSelection?.start ?? next.editorText.length, next.editorText.length);
        const end = Math.min(next.editorSelection?.end ?? start, next.editorText.length);
        next.editorText = next.editorText.slice(0, start) + key + next.editorText.slice(end);
        next.editorSelection = { start: start + key.length, end: start + key.length };
      }
      break;
    case "getEditorText": break;
    default: next.unsupported = `扩展 UI ${String(method)} 尚无手机组件，需要文本或标准表单回退`;
  }
  return next;
}
