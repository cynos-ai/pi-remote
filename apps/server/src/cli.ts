import { join, resolve } from "node:path";
import { AuthService } from "./auth.js";
import { parseEnv } from "./config.js";
import {
  backupDeployment,
  doctorDeployment,
  enterMaintenance,
  exitMaintenance,
  initializeDeployment,
  restoreDeployment
} from "./deployment.js";
import { assertWritable } from "./maintenance.js";
import { openServerDatabaseSync } from "./storage/database.js";

function optionValue(args: readonly string[], name: string): string | undefined {
  const prefix = name + "=";
  const inline = args.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function hasOption(args: readonly string[], name: string): boolean {
  return args.some((arg) => arg === name || arg.startsWith(name + "="));
}

function assertOnlyOptions(args: readonly string[], names: readonly string[], usage: string): void {
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) throw new Error(usage);
    const name = names.find((candidate) => arg === candidate || arg.startsWith(candidate + "="));
    if (!name || seen.has(name)) throw new Error(usage);
    seen.add(name);
    if (arg === name) {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error(usage);
      index += 1;
    }
  }
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const env = parseEnv();
  switch (command) {
    case "init": {
      if (args.length > 0) throw new Error("usage: node apps/server/dist/cli.js init");
      console.log(JSON.stringify(await initializeDeployment(env)));
      return;
    }
    case "doctor": {
      if (args.length > 0) throw new Error("usage: node apps/server/dist/cli.js doctor");
      const report = await doctorDeployment(env);
      console.log(JSON.stringify(report, null, 2));
      if (report.status === "failed") process.exitCode = 1;
      return;
    }
    case "maintenance": {
      const [action, ...rest] = args;
      if (action === "enter") {
        assertOnlyOptions(rest, ["--reason"], "usage: node apps/server/dist/cli.js maintenance enter [--reason text]");
        const reason = optionValue(args, "--reason") ?? "operator maintenance";
        console.log(JSON.stringify(enterMaintenance(resolve(env.PI_REMOTE_STATE_DIR), reason)));
      } else if (action === "exit" && rest.length === 0) {
        console.log(JSON.stringify({ exited: exitMaintenance(resolve(env.PI_REMOTE_STATE_DIR)) }));
      } else {
        throw new Error("usage: node apps/server/dist/cli.js maintenance enter|exit");
      }
      return;
    }
    case "pair": {
      assertOnlyOptions(args, ["--ttl"], "usage: node apps/server/dist/cli.js pair [--ttl seconds]");
      assertWritable(resolve(env.PI_REMOTE_STATE_DIR));
      const databaseFile = env.PI_REMOTE_DATABASE_FILE ?? join(env.PI_REMOTE_STATE_DIR, "state.sqlite");
      if (databaseFile === ":memory:") throw new Error("PI_REMOTE_DATABASE_FILE=:memory: is not valid for a deployment");
      const database = openServerDatabaseSync({ filename: databaseFile });
      try {
        const auth = new AuthService(database, {
          pairingTtlSeconds: env.PI_REMOTE_PAIRING_TTL_SECONDS
        });
        auth.ensureOwner({ id: env.PI_REMOTE_OWNER_ID, displayName: env.PI_REMOTE_OWNER_NAME });
        const rawTtl = optionValue(args, "--ttl");
        const ttl = rawTtl === undefined ? env.PI_REMOTE_PAIRING_TTL_SECONDS : Number(rawTtl);
        if (!Number.isInteger(ttl)) throw new Error("--ttl must be an integer number of seconds");
        console.log(JSON.stringify(auth.createPairingToken(env.PI_REMOTE_OWNER_ID, ttl)));
      } finally {
        database.close();
      }
      return;
    }
    case "backup": {
      assertOnlyOptions(args, ["--destination"], "usage: node apps/server/dist/cli.js backup --destination <path>");
      if (!hasOption(args, "--destination")) throw new Error("usage: node apps/server/dist/cli.js backup --destination <path>");
      const destination = optionValue(args, "--destination");
      console.log(JSON.stringify(await backupDeployment(env, destination ?? ""), null, 2));
      return;
    }
    case "restore": {
      assertOnlyOptions(args, ["--source"], "usage: node apps/server/dist/cli.js restore --source <path>");
      if (!hasOption(args, "--source")) throw new Error("usage: node apps/server/dist/cli.js restore --source <path>");
      const source = optionValue(args, "--source");
      console.log(JSON.stringify(await restoreDeployment(env, source ?? ""), null, 2));
      return;
    }
    default:
      throw new Error("usage: node apps/server/dist/cli.js init|doctor|pair|maintenance|backup|restore");
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
