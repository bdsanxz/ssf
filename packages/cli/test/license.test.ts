// F-40 tests: license issue/verify/list commands (Sprint 1 example flow).

import { describe, expect, test } from "bun:test";
import { generateRootSecret, generateSigningKeypair } from "@ssf/crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { licenseIssue, licenseList, licenseRevoke, licenseVerify, parseExpiry } from "../src/license.js";

function keyFiles() {
  const dir = mkdtempSync(join(tmpdir(), "ssf-keys-"));
  const rootSecret = generateRootSecret();
  const license = generateSigningKeypair();
  writeFileSync(join(dir, "root.hex"), rootSecret.toString("hex"));
  writeFileSync(join(dir, "license.pem"), license.privateKey.export({ format: "pem", type: "pkcs8" }).toString());
  writeFileSync(join(dir, "license.pub.pem"), license.publicKey.export({ format: "pem", type: "spki" }).toString());
  return { dir, publicKeyFile: join(dir, "license.pub.pem") };
}

function context() {
  return {
    workspaceDir: mkdtempSync(join(tmpdir(), "ssf-work-")),
    config: {
      workspace: { publisher: "acme", defaultMode: "offline" as const },
      license: { env: "ACME_SSF_LICENSE", configFile: "acme/license" },
      keys: { dir: "./keys", licenseKid: "prod-2026", artifactKid: "prod-2026", rootKid: "prod-2026" },
      limits: {
        defaultMaxLines: 500,
        defaultMaxChars: 40000,
        defaultScriptOutputChars: 20000,
        defaultScriptTimeoutSeconds: 120,
      },
      agent: { confidentialityNotice: { enabled: true } },
      build: { obfuscate: { scripts: true, runtime: true }, diversify: true },
      skills: ["skills/pdf-helper", "skills/report-writer"],
      plugins: [],
    },
  };
}

describe("parseExpiry", () => {
  test("accepts ISO dates and day counts", () => {
    expect(parseExpiry("2027-01-01", 1000)).toBe(Date.parse("2027-01-01T00:00:00.000Z") / 1000);
    expect(parseExpiry("30d", 1000)).toBe(1000 + 30 * 86400);
  });

  test("rejects garbage", () => {
    expect(() => parseExpiry("someday", 1000)).toThrow();
  });
});

describe("license commands", () => {
  test("issues two skills at once, verifies, and lists (proposal flow)", async () => {
    const { dir, publicKeyFile } = keyFiles();
    const ctx = context();
    const { text, token } = await licenseIssue(
      {
        skills: ["pdf-helper@1.0.0", "report-writer@1.2.0"],
        expires: "2027-01-01",
        customer: "ref-123",
        rootSecretFile: join(dir, "root.hex"),
        licenseKeyFile: join(dir, "license.pem"),
        licenseKid: "prod-2026",
      },
      ctx,
      1700000000,
    );
    expect(token.split(".").length).toBe(4);
    expect(text).toContain("license_id:");
    const verified = licenseVerify(token, { publicKeyFile });
    expect(verified.text).toContain("valid: true");
    expect(verified.text).toContain("pdf-helper, report-writer");
    expect(verified.text).not.toContain("eyJ");
    const listed = licenseList(join(ctx.workspaceDir, "issued.jsonl"));
    expect(listed.text).toContain("ref-123");
    expect(listed.text).toContain("pdf-helper");
  });

  test("issues an online token with no embedded content keys", async () => {
    const { dir, publicKeyFile } = keyFiles();
    const { text, token } = await licenseIssue(
      {
        skills: ["pdf-helper@1.0.0"],
        expires: "2027-01-01",
        mode: "online",
        rootSecretFile: join(dir, "root.hex"),
        licenseKeyFile: join(dir, "license.pem"),
        licenseKid: "prod-2026",
      },
      context(),
      1700000000,
    );
    expect(text).toContain("mode: online");
    const verified = licenseVerify(token, { publicKeyFile });
    expect(verified.text).toContain("mode: online");
    expect(verified.text).toContain("content_keys: 0 keys");
  });

  test("rejects an unknown mode", async () => {
    const { dir } = keyFiles();
    await expect(
      licenseIssue(
        {
          skills: ["pdf-helper@1.0.0"],
          expires: "30d",
          mode: "leased",
          rootSecretFile: join(dir, "root.hex"),
          licenseKeyFile: join(dir, "license.pem"),
          licenseKid: "prod-2026",
        },
        context(),
        1700000000,
      ),
    ).rejects.toThrow("--mode");
  });

  test("revokes a license id into revoked.json", async () => {
    const ctx = context();
    const first = licenseRevoke("lic_123", {}, ctx);
    expect(first.text).toContain("revoked: lic_123 (1 total)");
    const parsed = JSON.parse(readFileSync(join(ctx.workspaceDir, "revoked.json"), "utf8")) as {
      revoked: string[];
    };
    expect(parsed.revoked).toEqual(["lic_123"]);
    const second = licenseRevoke("lic_123", {}, ctx);
    expect(second.text).toContain("(1 total)");
    const custom = licenseRevoke("lic_456", { revocationsFile: join(ctx.workspaceDir, "custom.json") }, ctx);
    expect(custom.text).toContain("custom.json");
    expect(() => licenseRevoke("  ", {}, ctx)).toThrow("needs a license id");
  });

  test("requires id@version entries", async () => {
    const { dir } = keyFiles();
    await expect(
      licenseIssue(
        {
          skills: ["pdf-helper"],
          expires: "30d",
          rootSecretFile: join(dir, "root.hex"),
          licenseKeyFile: join(dir, "license.pem"),
          licenseKid: "prod-2026",
        },
        context(),
        1700000000,
      ),
    ).rejects.toThrow();
  });
});
