import { z } from "zod";

const optionalText = () => z.preprocess(
  (value) => value === "" ? undefined : value,
  z.string().min(1).optional()
);

const envSchema = z.object({
  PI_REMOTE_HOST: z.string().min(1).default("0.0.0.0"),
  PI_REMOTE_PORT: z.coerce.number().int().min(0).max(65535).default(8080),
  PI_REMOTE_STATE_DIR: z.string().min(1).default("/state"),
  PI_REMOTE_PI_DIR: z.string().min(1).default("/state/pi"),
  PI_REMOTE_WORKSPACE_ROOT: z.string().min(1).default("/workspaces"),
  PI_REMOTE_DATABASE_FILE: optionalText(),
  PI_REMOTE_OWNER_ID: z.string().min(1).max(128).default("owner"),
  PI_REMOTE_OWNER_NAME: z.string().min(1).max(120).default("Owner"),
  PI_REMOTE_PAIRING_TTL_SECONDS: z.coerce.number().int().min(30).max(86400).default(600),
  PI_REMOTE_CURSOR_SECRET: z.string().min(16).default("development-only-cursor-secret"),
  PI_REMOTE_LIVE_TESTS: z.enum(["0", "1"]).default("0"),
  // Zero and an omitted value both mean unlimited. These limits are opt-in so
  // a deployment does not silently change the native pi concurrency model.
  PI_REMOTE_MAX_ACTIVE_RUNS: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  PI_REMOTE_MAX_LOADED_WORKERS: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  PI_REMOTE_MAX_QUEUED_COMMANDS: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  PI_REMOTE_WORKER_IDLE_SECONDS: z.coerce.number().int().min(0).max(86400).default(0),
  PI_REMOTE_SERIALIZE_WORKSPACE: z.enum(["0", "1"]).default("0"),
  PI_REMOTE_ALLOWED_ORIGINS: z.string().optional(),
  PI_REMOTE_DEFAULT_PROVIDER: optionalText(),
  PI_REMOTE_DEFAULT_MODEL: optionalText(),
  PI_REMOTE_MODEL_HEALTH_URL: z.preprocess(
    (value) => value === "" ? undefined : value,
    z.string().url().optional()
  ),
  PI_REMOTE_MODEL_TIMEOUT_MS: z.coerce.number().int().min(100).max(120000).default(15000)
});

export type ServerEnv = z.infer<typeof envSchema>;

export function parseEnv(input: Record<string, string | undefined> = process.env): ServerEnv {
  const result = envSchema.safeParse(input);
  if (!result.success) {
    throw new Error(`Invalid server environment: ${result.error.message}`);
  }
  return result.data;
}
