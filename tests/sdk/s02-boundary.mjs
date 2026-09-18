import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { setImmediate } from "node:timers";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NO_RESOURCE_DISCOVERY = {
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true
};

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function fixture(prefix = "pi-remote-s02-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const project = join(root, "project");
  const agentDir = join(root, "agent");
  const sessionDir = join(root, "sessions");
  await Promise.all([mkdir(project), mkdir(agentDir), mkdir(sessionDir)]);
  return {
    root,
    project,
    agentDir,
    sessionDir,
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    }
  };
}

function baseOptions(input) {
  return {
    cwd: input.project,
    agentDir: input.agentDir,
    sessionDir: input.sessionDir,
    noTools: "all",
    resourceLoaderOptions: NO_RESOURCE_DISCOVERY
  };
}

async function withSession(api, callback, options = {}) {
  const input = await fixture();
  let handle;
  try {
    handle = await api.createPiAgentSession({ ...baseOptions(input), ...options });
    return await callback(handle, input);
  } finally {
    handle?.dispose();
    await input.cleanup();
  }
}

async function checkUnflushedAndPreflight(api) {
  return withSession(api, async (handle) => {
    const file = handle.session.sessionFile;
    assert.ok(file);
    assert.equal(await exists(file), false, "new SessionManager path is not proof of a JSONL file");
    assert.ok(handle.sessionManager.getEntries().some((entry) => entry.type === "thinking_level_change"));

    const preflight = [];
    const events = [];
    const unsubscribe = handle.onEvent((event) => events.push(event.type));
    await assert.rejects(
      handle.session.prompt("s02 no-model preflight", { preflightResult: (accepted) => preflight.push(accepted) }),
      /No API key found/
    );
    unsubscribe();
    assert.deepEqual(preflight, [false]);
    assert.deepEqual(events, []);
    assert.equal((await api.inspectPiSessionFile(file)).kind, "missing");
  });
}

async function checkNativeBash(api) {
  return withSession(api, async (handle) => {
    const chunks = [];
    const result = await handle.session.executeBash("printf 's02-bash-marker\\n'", (chunk) => chunks.push(chunk));
    assert.equal(result.output, "s02-bash-marker\n");
    assert.equal(result.exitCode, 0);
    assert.equal(result.cancelled, false);
    assert.deepEqual(chunks, ["s02-bash-marker\n"]);
    const bashEntry = handle.sessionManager.getEntries().find(
      (entry) => entry.type === "message" && entry.message.role === "bashExecution"
    );
    assert.ok(bashEntry, "native executeBash result is recorded as a bashExecution message");
    assert.equal(await exists(handle.session.sessionFile), false, "Bash alone does not trigger first-assistant flush");
  });
}

async function checkSessionFilePolicy(api) {
  const input = await fixture();
  let seed;
  try {
    seed = await api.createPiAgentSession({ ...baseOptions(input) });
    const header = {
      type: "session",
      version: 3,
      id: seed.session.sessionId,
      timestamp: new Date().toISOString(),
      cwd: input.project
    };
    seed.dispose();

    const missingPath = join(input.sessionDir, "missing.jsonl");
    assert.equal((await api.inspectPiSessionFile(missingPath, input.project)).kind, "missing");
    const missing = await api.createPiAgentSession({ ...baseOptions(input), sessionFile: missingPath });
    assert.equal(missing.sessionFileState.kind, "missing");
    assert.equal(await exists(missingPath), false, "SDK missing-path initialization remains unflushed");
    missing.dispose();

    const emptyPath = join(input.sessionDir, "empty.jsonl");
    await writeFile(emptyPath, "", "utf8");
    assert.equal((await api.inspectPiSessionFile(emptyPath, input.project)).kind, "empty");
    const empty = await api.createPiAgentSession({ ...baseOptions(input), sessionFile: emptyPath });
    assert.equal(empty.sessionFileState.kind, "empty");
    assert.ok(await exists(emptyPath), "SDK open(empty) writes an initialized header");
    empty.dispose();

    const headerPath = join(input.sessionDir, "header-only.jsonl");
    await writeFile(headerPath, `${JSON.stringify(header)}\n`, "utf8");
    const headerState = await api.inspectPiSessionFile(headerPath, input.project);
    assert.equal(headerState.kind, "persisted");
    assert.equal(headerState.entryCount, 0);
    assert.equal(headerState.hasAssistantMessage, false);
    const headerOnly = await api.createPiAgentSession({ ...baseOptions(input), sessionFile: headerPath });
    assert.equal(headerOnly.session.sessionId, header.id);
    assert.ok(headerOnly.sessionManager.getEntries().length >= 1);
    assert.ok(headerOnly.sessionManager.getEntries().every((entry) => entry.type === "thinking_level_change"));
    headerOnly.dispose();

    const nonAssistantPath = join(input.sessionDir, "non-assistant.jsonl");
    await writeFile(
      nonAssistantPath,
      `${JSON.stringify({ ...header, id: `${header.id.slice(0, -1)}1` })}\n${JSON.stringify({
        type: "session_info",
        id: "a1b2c3d4",
        parentId: null,
        timestamp: new Date().toISOString(),
        name: "header-only import"
      })}\n`,
      "utf8"
    );
    const nonAssistantState = await api.inspectPiSessionFile(nonAssistantPath, input.project);
    assert.equal(nonAssistantState.kind, "persisted");
    assert.equal(nonAssistantState.hasAssistantMessage, false);
    assert.equal(nonAssistantState.hasNonAssistantEntry, true);
    const nonAssistant = await api.createPiAgentSession({ ...baseOptions(input), sessionFile: nonAssistantPath });
    assert.equal(nonAssistant.session.sessionName, "header-only import");
    nonAssistant.dispose();

    const invalidPath = join(input.sessionDir, "invalid.jsonl");
    await writeFile(invalidPath, "not json\n", "utf8");
    assert.equal((await api.inspectPiSessionFile(invalidPath, input.project)).kind, "invalid");
    await assert.rejects(
      api.createPiAgentSession({ ...baseOptions(input), sessionFile: invalidPath }),
      (error) => error?.name === "PiSessionHistoryError"
    );

    const foreignPath = join(input.sessionDir, "foreign.jsonl");
    await writeFile(foreignPath, `${JSON.stringify({ ...header, cwd: join(input.root, "other-project") })}\n`, "utf8");
    assert.equal((await api.inspectPiSessionFile(foreignPath, input.project)).kind, "identity_mismatch");
    await assert.rejects(
      api.createPiAgentSession({ ...baseOptions(input), sessionFile: foreignPath }),
      (error) => error?.name === "PiSessionHistoryError"
    );
  } finally {
    seed?.dispose();
    await input.cleanup();
  }
}

function rpcUi(observations) {
  return {
    select: async (_title, options) => options[0],
    confirm: async () => true,
    input: async (title) => {
      observations.push(`ui.input:${title}`);
      return "s02-answer";
    },
    notify: (message) => observations.push(`ui.notify:${message}`),
    onTerminalInput: () => () => {},
    setStatus: () => {},
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
    setWidget: () => {},
    setFooter: () => {},
    setHeader: () => {},
    setTitle: () => {},
    custom: async () => undefined,
    pasteToEditor: () => {},
    setEditorText: () => {},
    getEditorText: () => "",
    editor: async () => undefined,
    addAutocompleteProvider: () => {},
    setEditorComponent: () => {},
    getEditorComponent: () => undefined,
    theme: {}
  };
}

async function checkResourcesAndInteractions(api) {
  const input = await fixture();
  let seed;
  let handle;
  try {
    const observations = [];
    const errors = [];
    seed = await api.createPiAgentSession({ ...baseOptions(input) });
    const modelRuntime = seed.services.modelRuntime;
    modelRuntime.registerProvider("s02-contract-provider", {
      name: "S02 contract provider",
      baseUrl: "http://127.0.0.1:1",
      api: "openai-completions",
      apiKey: "s02-contract-only",
      models: [{
        id: "contract-thinking",
        name: "S02 contract thinking model",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 4096,
        maxTokens: 512
      }]
    });
    const contractModel = modelRuntime.getModel("s02-contract-provider", "contract-thinking");
    assert.ok(contractModel);
    seed.dispose();
    const extension = {
      name: "s02-boundary-extension",
      factory: (pi) => {
        pi.on("session_start", (event) => observations.push(`session_start:${event.reason}`));
        pi.on("session_info_changed", (event) => observations.push(`session_info_changed:${event.name ?? ""}`));
        pi.on("thinking_level_select", async (event, ctx) => {
          observations.push(`thinking_level_select:${event.level}`);
          await ctx.ui.input("S02 thinking hook");
          observations.push("thinking_hook_answered");
        });
        pi.on("user_bash", (event) => observations.push(`user_bash:${event.excludeFromContext}`));
        pi.registerCommand("s02-probe", {
          description: "S02 extension command probe",
          handler: async (_args, ctx) => {
            observations.push("command_started");
            await ctx.ui.confirm("S02 command", "answer");
            observations.push("command_answered");
          }
        });
        pi.registerMessageRenderer("s02-message", () => undefined);
        pi.registerEntryRenderer("s02-entry", () => undefined);
      }
    };
    handle = await api.createPiAgentSession({
      ...baseOptions(input),
      modelRuntime,
      model: contractModel,
      resourceLoaderOptions: {
        ...NO_RESOURCE_DISCOVERY,
        noExtensions: false,
        extensionFactories: [extension]
      }
    });
    assert.equal(handle.extensionsResult.extensions.length, 1);
    assert.ok(handle.extensionsResult.extensions[0].commands.has("s02-probe"));
    await handle.bindExtensions({ mode: "rpc", uiContext: rpcUi(observations), onError: (error) => errors.push(error) });
    assert.ok(observations.includes("session_start:startup"));

    handle.session.setSessionName("S02 title");
    handle.session.setThinkingLevel("high");
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(observations.includes("session_info_changed:S02 title"));
    assert.ok(observations.includes("thinking_level_select:high"));
    assert.ok(observations.includes("ui.input:S02 thinking hook"));
    assert.ok(observations.includes("thinking_hook_answered"));
    assert.deepEqual(errors, []);
  } finally {
    handle?.dispose();
    await input.cleanup();
  }
}

async function checkRuntimeReplacement(api) {
  const input = await fixture();
  let handle;
  try {
    handle = await api.createPiAgentRuntime({
      ...baseOptions(input),
      resourceLoaderOptions: NO_RESOURCE_DISCOVERY
    });
    const first = handle.runtime.session;
    const firstId = first.sessionId;
    const replacement = await handle.runtime.newSession();
    assert.equal(replacement.cancelled, false);
    assert.notEqual(handle.runtime.session.sessionId, firstId);
    assert.notEqual(handle.runtime.session, first);
  } finally {
    await handle?.dispose();
    await input.cleanup();
  }
}

export async function runSdkBoundarySuite(api) {
  const checks = [
    ["S02-01 unflushed lifecycle and preflight", checkUnflushedAndPreflight],
    ["S02-02 native Bash result boundary", checkNativeBash],
    ["S02-03 JSONL persisted-state policy", checkSessionFilePolicy],
    ["S02-04 resources and asynchronous interaction hooks", checkResourcesAndInteractions],
    ["S02-05 AgentSessionRuntime replacement", checkRuntimeReplacement]
  ];
  const results = [];
  for (const [name, check] of checks) {
    try {
      await check(api);
      results.push({ name, status: "passed" });
    } catch (error) {
      results.push({
        name,
        status: "failed",
        details: error instanceof Error ? error.stack ?? error.message : String(error)
      });
    }
  }
  return results;
}
