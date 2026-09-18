import { mkdir, readdir, copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "apps/server/src/storage/migrations");
const destination = join(root, "apps/server/dist/storage/migrations");
await mkdir(destination, { recursive: true });
for (const name of await readdir(source)) {
  if (name.endsWith(".sql")) await copyFile(join(source, name), join(destination, name));
}

