import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Stored beside native auth so the existing pi-directory backup includes it. */
export function loadSecretFingerprintKey(piDir: string): string {
  mkdirSync(piDir, { recursive: true });
  const file = join(piDir, "secret-response.key");
  try { writeFileSync(file, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const key = readFileSync(file, "utf8");
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Invalid secret response fingerprint key");
  return key;
}
