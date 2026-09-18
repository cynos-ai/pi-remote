import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function createTestWorkspace(prefix = "pi-remote-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(root, "project"), { recursive: true });
  return {
    root,
    project: join(root, "project"),
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    }
  };
}
