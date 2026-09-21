export type NativeCapabilityStatus =
  | "available"
  | "needs_adapter"
  | "disabled_by_owner"
  | "upstream_unavailable";

export type NativeCapabilityEvidence = "sdk_api" | "contract_smoke" | "live_not_run";

export interface NativeCapability {
  id: string;
  area:
    | "session"
    | "streaming"
    | "model"
    | "input"
    | "extension"
    | "resources"
    | "bash"
    | "ui";
  status: NativeCapabilityStatus;
  evidence: NativeCapabilityEvidence;
  sdkEntryPoints: string[];
  adapterPlan: string;
  notes: string;
}

/**
 * The S02 inventory is intentionally data, not a feature gate. A
 * needs_adapter item remains an implementation task and is not silently
 * disabled by the server.
 */
export const NATIVE_CAPABILITIES: readonly NativeCapability[] = [
  {
    id: "session.prompt",
    area: "session",
    status: "available",
    evidence: "sdk_api",
    sdkEntryPoints: ["createAgentSession", "AgentSession.prompt"],
    adapterPlan: "S07/S10 map prompt lifecycle to Operation/Run events and mobile input.",
    notes: "The SDK preflight callback and prompt Promise represent different boundaries."
  },
  {
    id: "session.runtime-replacement",
    area: "session",
    status: "available",
    evidence: "sdk_api",
    sdkEntryPoints: ["createAgentSessionRuntime", "newSession", "switchSession", "fork", "importFromJsonl"],
    adapterPlan: "S06/S07 confirm mapping and rebind ordering before forwarding events.",
    notes: "Runtime replacement owns cwd-bound services and requires re-subscription."
  },
  {
    id: "session.legal-empty-history",
    area: "session",
    status: "available",
    evidence: "contract_smoke",
    sdkEntryPoints: ["SessionManager.open", "parseSessionEntries"],
    adapterPlan: "S04/S06 persist and validate application identity before opening persisted history.",
    notes: "Header-only and non-assistant histories are valid; zero-byte and malformed files need policy checks."
  },
  {
    id: "streaming.events",
    area: "streaming",
    status: "available",
    evidence: "sdk_api",
    sdkEntryPoints: ["AgentSession.subscribe", "message_update", "tool_execution_update", "agent_end", "agent_settled"],
    adapterPlan: "S03/S04 normalize events into ordered persisted envelopes.",
    notes: "agent_end is not the final product success signal; agent_settled and terminal messages are separate."
  },
  {
    id: "model.selection",
    area: "model",
    status: "available",
    evidence: "sdk_api",
    sdkEntryPoints: ["ModelRuntime", "AgentSession.setModel", "AgentSession.getAvailableThinkingLevels"],
    adapterPlan: "S07 exposes native model and thinking mutations with actual hook errors.",
    notes: "Authentication and provider availability remain runtime conditions."
  },
  {
    id: "model.compaction",
    area: "model",
    status: "available",
    evidence: "sdk_api",
    sdkEntryPoints: ["AgentSession.compact", "AgentSession.abortCompaction"],
    adapterPlan: "S07 records the native stop-before-compact sequence separately from stop queue clearing.",
    notes: "Compact is not implemented by applying the model-stop adapter."
  },
  {
    id: "input.steer-follow-up",
    area: "input",
    status: "available",
    evidence: "sdk_api",
    sdkEntryPoints: ["AgentSession.steer", "AgentSession.followUp", "AgentSession.clearQueue"],
    adapterPlan: "S07 persists complete input records and restores returned/unknown drafts without replay.",
    notes: "SDK queue state is distinct from the application's later-Run queue."
  },
  {
    id: "input.attachments",
    area: "input",
    status: "available",
    evidence: "sdk_api",
    sdkEntryPoints: ["PromptOptions.images", "ImageContent"],
    adapterPlan: "S03/S07 add artifact-backed attachment DTOs and preserve content through stop/recovery.",
    notes: "The SDK receives verified PNG/JPEG/GIF/WebP ImageContent resolved from Session-bound artifacts; device validation remains pending."
  },
  {
    id: "extension.commands",
    area: "extension",
    status: "available",
    evidence: "sdk_api",
    sdkEntryPoints: ["DefaultResourceLoader", "ExtensionAPI.registerCommand", "AgentSession.prompt"],
    adapterPlan: "S07/S10 expose commands as structured actions while preserving immediate streaming behavior.",
    notes: "Extension commands are not ordinary queued model prompts."
  },
  {
    id: "extension.interactions",
    area: "extension",
    status: "available",
    evidence: "sdk_api",
    sdkEntryPoints: ["ExtensionUIContext.select", "confirm", "input", "editor", "ui_prompt_start/end"],
    adapterPlan: "S07/S10 bridge each prompt to an operationId and resumable mobile form.",
    notes: "Forms may exist during initialization/configuration and must not be cancelled by a parent Promise return."
  },
  {
    id: "resources.native-discovery",
    area: "resources",
    status: "available",
    evidence: "sdk_api",
    sdkEntryPoints: ["DefaultResourceLoader", "reload", "getExtensions", "getSkills", "getPrompts", "getAgentsFiles"],
    adapterPlan: "S06/S12 retain the native loader, trust flow, and explicit deployment paths.",
    notes: "No application-level default disable switch is added."
  },
  {
    id: "bash.native-executor",
    area: "bash",
    status: "available",
    evidence: "sdk_api",
    sdkEntryPoints: ["AgentSession.executeBash", "recordBashResult", "abortBash", "user_bash"],
    adapterPlan: "S06/S07/S10/S12 pass through native Bash and report output/lifecycle without filtering.",
    notes: "Default no-timeout, background-service, and process-group behavior requires Linux parity evidence."
  },
  {
    id: "extension.custom-renderers",
    area: "ui",
    status: "available",
    evidence: "contract_smoke",
    sdkEntryPoints: ["registerMessageRenderer", "registerEntryRenderer", "ExtensionUIContext.setWidget", "setFooter", "setHeader"],
    adapterPlan: "S07 renders native components to bounded 80-column text; S10 persists and labels the mobile projection.",
    notes: "Message fallback and entry failure semantics follow SDK 0.85.1; terminal pixels, colors, and device parity remain separate evidence."
  },
  {
    id: "tui.terminal-components",
    area: "ui",
    status: "needs_adapter",
    evidence: "sdk_api",
    sdkEntryPoints: ["ExtensionUIContext.custom", "setEditorComponent", "setWidget"],
    adapterPlan: "S02 records component ownership; S07/S10 implement touch equivalents where semantics are observable.",
    notes: "Terminal pixel layout and keyboard shortcuts are not copied into the mobile protocol."
  }
] as const;

export function getNativeCapabilities(): readonly NativeCapability[] {
  return NATIVE_CAPABILITIES.map((capability) => ({
    ...capability,
    sdkEntryPoints: [...capability.sdkEntryPoints]
  }));
}
