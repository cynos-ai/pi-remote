import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { loadSecretFingerprintKey } from "../../apps/server/src/secret-fingerprint.js";

it("persists a private random fingerprint key and refuses silent replacement of corruption", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-secret-fingerprint-"));
  try {
    const first = loadSecretFingerprintKey(root);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(loadSecretFingerprintKey(root)).toBe(first);
    if (process.platform !== "win32") expect(statSync(join(root, "secret-response.key")).mode & 0o777).toBe(0o600);
    writeFileSync(join(root, "secret-response.key"), "invalid");
    expect(() => loadSecretFingerprintKey(root)).toThrow("Invalid secret response fingerprint key");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
