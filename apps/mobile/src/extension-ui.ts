export interface ExtensionUiState {
  seq: number;
  statuses: Record<string, string>;
  widgets: Record<string, string[]>;
  customFrames: Record<string, string[]>;
  widgetPlacements: Record<string, "aboveEditor" | "belowEditor">;
  workingMessage: string;
  workingVisible: boolean;
  workingIndicator: { frames: string[]; intervalMs: number } | null;
  hiddenThinkingLabel: string;
  windowTitle: string;
  toolsExpanded: boolean;
  toolsExpansionSeq: number;
  editorText: string;
  editorSelection?: { start: number; end: number };
  unsupported: string | null;
}

export const emptyExtensionUi = (): ExtensionUiState => ({
  seq: 0, statuses: {}, widgets: {}, customFrames: {}, widgetPlacements: {}, workingMessage: "", workingVisible: true,
  workingIndicator: null, hiddenThinkingLabel: "思考内容已隐藏", windowTitle: "",
  toolsExpanded: false, toolsExpansionSeq: 0, editorText: "", unsupported: null
});

export interface ExtensionNotice {
  seq: number;
  kind: string;
  details?: Record<string, unknown>;
}

export function applyExtensionNotice(state: ExtensionUiState, notice: ExtensionNotice): ExtensionUiState {
  if (notice.kind !== "extension_ui" || notice.seq <= state.seq) return state;
  const next = { ...state, seq: notice.seq, statuses: { ...state.statuses }, widgets: { ...state.widgets }, widgetPlacements: { ...state.widgetPlacements } };
  const method = notice.details?.method;
  const args = notice.details?.args;
  if (!Array.isArray(args)) return { ...next, unsupported: "扩展 UI 参数无法读取" };
  const [key, value] = args;
  switch (method) {
    case "custom.render":
      if (typeof key === "string") {
        next.customFrames = { ...state.customFrames };
        if (Array.isArray(value) && value.every(line => typeof line === "string")) next.customFrames[key] = [...value];
        else delete next.customFrames[key];
      }
      break;
    case "setStatus":
      if (typeof key === "string") {
        if (typeof value === "string") next.statuses[key] = value;
        else delete next.statuses[key];
      }
      break;
    case "setWidget":
      if (typeof key === "string") {
        const failurePrefix = `扩展 widget ${JSON.stringify(key)} 渲染失败：`;
        if (next.unsupported?.startsWith(failurePrefix)) next.unsupported = null;
        if (Array.isArray(value) && value.every((line) => typeof line === "string")) {
          next.widgets[key] = value;
          next.widgetPlacements[key] = args[2]?.placement === "belowEditor" ? "belowEditor" : "aboveEditor";
        } else if (value == null) { delete next.widgets[key]; delete next.widgetPlacements[key]; }
        else {
          delete next.widgets[key]; delete next.widgetPlacements[key];
          next.unsupported = typeof value?.rendererError === "string" ? `${failurePrefix}${value.rendererError}` : "此扩展 widget 尚未获得可显示内容";
        }
      }
      break;
    case "setWorkingMessage": next.workingMessage = typeof key === "string" ? key : ""; break;
    case "setWorkingVisible": if (typeof key === "boolean") next.workingVisible = key; break;
    case "setWorkingIndicator": {
      if (key == null) { next.workingIndicator = null; break; }
      if (typeof key === "object" && (key.frames === undefined || (Array.isArray(key.frames) && key.frames.every((frame: unknown) => typeof frame === "string")))) {
        next.workingIndicator = { frames: key.frames === undefined ? ["◐", "◓", "◑", "◒"] : [...key.frames], intervalMs: typeof key.intervalMs === "number" && Number.isFinite(key.intervalMs) && key.intervalMs > 0 ? key.intervalMs : 80 };
      } else next.unsupported = "扩展工作指示器参数无法读取";
      break;
    }
    case "setHiddenThinkingLabel": next.hiddenThinkingLabel = typeof key === "string" ? key : "思考内容已隐藏"; break;
    case "setTitle": if (typeof key === "string") next.windowTitle = key; break;
    case "setToolsExpanded":
      if (typeof key === "boolean") { next.toolsExpanded = key; next.toolsExpansionSeq = notice.seq; }
      break;
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
