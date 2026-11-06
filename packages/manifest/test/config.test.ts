// Config validation for keys.leaseKid (F-42 lease provisioning).

import { describe, expect, test } from "bun:test";
import { validateSsfConfig } from "../src/config.js";

function baseConfig(): Record<string, unknown> {
  return {
    workspace: { publisher: "acme", defaultMode: "offline" },
    license: { env: "ACME_SSF_LICENSE", configFile: "acme/license" },
    keys: { dir: "./keys", licenseKid: "prod-2026", artifactKid: "prod-2026", rootKid: "prod-2026" },
    limits: { defaultMaxLines: 500, defaultMaxChars: 40000, defaultScriptOutputChars: 20000, defaultScriptTimeoutSeconds: 120 },
    skills: ["skills/demo"],
    plugins: [],
  };
}

describe("keys.leaseKid", () => {
  test("is optional and accepts a non-empty kid", () => {
    expect(validateSsfConfig(baseConfig()).ok).toBe(true);
    const withLease = baseConfig();
    (withLease["keys"] as Record<string, unknown>)["leaseKid"] = "lease-2026-01";
    expect(validateSsfConfig(withLease).ok).toBe(true);
  });

  test("rejects an empty lease kid", () => {
    const bad = baseConfig();
    (bad["keys"] as Record<string, unknown>)["leaseKid"] = "";
    const result = validateSsfConfig(bad);
    expect(result.ok).toBe(false);
    if (result.ok) {
      expect.unreachable();
    }
    expect(result.errors.join(";")).toContain("keys.leaseKid");
  });
});
