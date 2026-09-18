import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestWorkspace } from "../../scripts/test-workspace.mjs";

const root = resolve(process.cwd());

describe("S01 engineering boundary", () => {
  it("keeps the pi SDK dependency in agent-pi", async () => {
    const agent = JSON.parse(await readFile(resolve(root, "packages/agent-pi/package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    const protocol = JSON.parse(await readFile(resolve(root, "packages/protocol/package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(agent.dependencies?.["@earendil-works/pi-coding-agent"]).toBe("0.85.1");
    expect(protocol.dependencies?.["@earendil-works/pi-coding-agent"]).toBeUndefined();
  });

  it("creates and removes isolated temporary project data", async () => {
    const workspace = await createTestWorkspace("pi-remote-s01-");
    try {
      expect(workspace.project.startsWith(workspace.root)).toBe(true);
    } finally {
      await workspace.cleanup();
    }
  });
});
