import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    reporters: ["default"],
    // Keep parallel SDK/module loads bounded on CI and mounted workspaces.
    maxWorkers: 4
  }
});
