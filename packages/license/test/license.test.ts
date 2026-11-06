// F-34, F-35, F-36 tests: sources, token format, offline verification.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSigningKeypair, generateRootSecret } from "@ssf/crypto";
import { issueLicense } from "../src/issue.js";
import { loadLicenseKey } from "../src/sources.js";
import { parseToken, TOKEN_FORMAT } from "../src/token.js";
import { checkScope, contentKeyFor, LicenseError, verifyLicenseToken } from "../src/verify.js";

function keys() {
  const pair = generateSigningKeypair();
  return { privateKey: pair.privateKey, publicKey: pair.publicKey };
}

function issued() {
  const rootSecret = generateRootSecret();
  const { privateKey, publicKey } = keys();
  const { token, payload } = issueLicense({
    rootSecret,
    licensePrivateKey: privateKey,
    licenseKid: "prod-2026",
    publisher: "acme",
    skills: [
      { skillId: "pdf-helper", version: "1.0.0" },
      { skillId: "report-writer", version: "1.2.0" },
    ],
    expiresAt: Math.floor(Date.now() / 1000) + 86400,
    licenseId: "lic_test",
    customer: "ref-123",
    ext: { tenant: "acme-corp" },
  });
  return { token, payload, publicKey };
}

describe("loadLicenseKey", () => {
  test("prefers the env var over the config file", () => {
    const dir = mkdtempSync(join(tmpdir(), "ssf-lic-"));
    mkdirSync(join(dir, "acme"), { recursive: true });
    writeFileSync(join(dir, "acme/license"), "file-provided-token");
    process.env["TEST_SSF_LICENSE"] = "env-provided-token";
    try {
      const loaded = loadLicenseKey({ envVar: "TEST_SSF_LICENSE", configFile: "acme/license", configDir: dir });
      expect(loaded).toEqual({ token: "env-provided-token", source: "env" });
    } finally {
      delete process.env["TEST_SSF_LICENSE"];
    }
    const fallback = loadLicenseKey({ envVar: "TEST_SSF_LICENSE", configFile: "acme/license", configDir: dir });
    expect(fallback).toEqual({ token: "file-provided-token", source: "file" });
    expect(loadLicenseKey({ envVar: "TEST_SSF_LICENSE", configFile: "missing", configDir: dir })).toBeNull();
  });
});

describe("token format", () => {
  test("parses ssf1 tokens and signs the original payload bytes", () => {
    const { token, payload } = issued();
    expect(token.startsWith(`${TOKEN_FORMAT}.prod-2026.`)).toBe(true);
    expect(token.split(".").length).toBe(4);
    const parsed = parseToken(token);
    expect(parsed.kid).toBe("prod-2026");
    expect(parsed.payload).toEqual(payload);
    expect(payload.content_keys["pdf-helper@1.0.0"]?.length).toBeGreaterThan(40);
    expect(payload.ext).toEqual({ tenant: "acme-corp" });
  });

  test("rejects malformed tokens", () => {
    for (const bad of ["", "ssf1.only.two", "v2.prod-2026.a.b", "ssf1.Bad_Kid!.a.b"]) {
      expect(() => parseToken(bad)).toThrow();
    }
  });
});

describe("verifyLicenseToken", () => {
  test("accepts a valid token offline", () => {
    const { token, publicKey } = issued();
    const payload = verifyLicenseToken(token, { licensePublicKey: publicKey, expectedPublisher: "acme" });
    expect(payload.license_id).toBe("lic_test");
    expect(() => checkScope(payload, { skillId: "pdf-helper", version: "1.0.0" })).not.toThrow();
    expect(contentKeyFor(payload, { skillId: "report-writer", version: "1.2.0" }).length).toBe(32);
  });

  test("rejects bad signatures, expiry, scope, and test kids", () => {
    const { token, publicKey } = issued();
    const other = keys();
    try {
      verifyLicenseToken(token, { licensePublicKey: other.publicKey });
      expect.unreachable();
    } catch (error) {
      expect((error as LicenseError).code).toBe("LICENSE_INVALID");
    }
    const issuerKeys = keys();
    const expired = issueLicense({
      rootSecret: generateRootSecret(),
      licensePrivateKey: issuerKeys.privateKey,
      licenseKid: "prod-2026",
      publisher: "acme",
      skills: [{ skillId: "pdf-helper", version: "1.0.0" }],
      expiresAt: 1,
    });
    try {
      verifyLicenseToken(expired.token, { licensePublicKey: issuerKeys.publicKey });
      expect.unreachable();
    } catch (error) {
      expect((error as LicenseError).code).toBe("LICENSE_EXPIRED");
    }
    const payload = verifyLicenseToken(token, { licensePublicKey: publicKey });
    expect(() => checkScope(payload, { skillId: "unknown", version: "1.0.0" })).toThrow(LicenseError);
    expect(() => checkScope(payload, { skillId: "pdf-helper", version: "9.9.9" })).toThrow(LicenseError);
    const devKeys = keys();
    const dev = issueLicense({
      rootSecret: generateRootSecret(),
      licensePrivateKey: devKeys.privateKey,
      licenseKid: "dev",
      publisher: "acme",
      skills: [{ skillId: "pdf-helper", version: "1.0.0" }],
      expiresAt: Math.floor(Date.now() / 1000) + 86400,
    });
    try {
      verifyLicenseToken(dev.token, { licensePublicKey: devKeys.publicKey });
      expect.unreachable();
    } catch (error) {
      expect((error as LicenseError).code).toBe("LICENSE_DEV_KEY");
    }
  });
});
