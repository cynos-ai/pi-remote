import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

if (process.argv.includes("--help")) {
  console.log("usage: pnpm test:serve -- --tls-cert <path> --tls-key <path>");
  process.exit(0);
}

const certificatePath = argument("--tls-cert");
const privateKeyPath = argument("--tls-key");
if (!certificatePath || !privateKeyPath) {
  console.error("test:serve requires --tls-cert and --tls-key; it never falls back to cleartext HTTP");
  process.exitCode = 2;
} else {
  const [{ startServer }, { parseEnv }] = await Promise.all([
    import(join(root, "apps/server/dist/index.js")),
    import(join(root, "apps/server/dist/config.js"))
  ]);
  const env = parseEnv(process.env);
  const [cert, key] = await Promise.all([readFile(resolve(certificatePath)), readFile(resolve(privateKeyPath))]);
  const app = await startServer({
    env,
    logger: true,
    https: { cert, key }
  });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("test HTTPS server did not expose a TCP address");
  console.log(`PI_REMOTE_TEST_SERVE_URL=https://${env.PI_REMOTE_HOST}:${address.port}`);
  console.log("PI_REMOTE_TEST_SERVE_WSS_PATH=/v1/ws");

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await app.close();
  };
  process.once("SIGTERM", () => { void stop(); });
  process.once("SIGINT", () => { void stop(); });
}
