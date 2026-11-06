import { describe, expect, test } from "bun:test";
import { generateRootSecret, generateSigningKeypair } from "@ssf/crypto";

import { LicenseError, checkOnlineScope, issueLicense, verifyLicenseToken } from "../src/index.js";
import { parseToken, TOKEN_FORMAT } from "../src/token.js";

const rootSecret = generateRootSecret();
const pair = generateSigningKeypair();

function issueOnline() {
  return issueLicense({
    rootSecret,
    licensePrivateKey: pair.privateKey,
    licenseKid: "prod-2026-11",
    publisher: "acme.example",
    skills: [{ skillId: "demo", version: "1.0.0" }],
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    mode: "online",
  });
}

describe("online token payload (F-35)", () => {
  test("mode is online and no content keys are embedded", () => {
    const { token, payload } = issueOnline();
    expect(payload.mode).toBe("online");
    expect(payload.content_keys).toEqual({});
    expect(token.startsWith(`${TOKEN_FORMAT}.prod-2026-11.`)).toBe(true);
    const parsed = parseToken(token);
    expect(parsed.payload.mode).toBe("online");
    expect(parsed.payload.content_keys).toEqual({});
    expect(JSON.stringify(parsed.payload)).not.toContain("demo@");
  });

  test("verifier accepts online token and can scope-check skill ids", () => {
    const { token } = issueOnline();
    const payload = verifyLicenseToken(token, {
      licensePublicKey: pair.publicKey,
      expectedPublisher: "acme.example",
    });
    expect(payload.mode).toBe("online");
    checkOnlineScope(payload, { skillId: "demo", version: "1.0.0" });
    expect(() => checkOnlineScope(payload, { skillId: "other", version: "1.0.0" })).toThrow(LicenseError);
  });

  test("default issuance stays offline with embedded content keys", () => {
    const { payload } = issueLicense({
      rootSecret,
      licensePrivateKey: pair.privateKey,
      licenseKid: "prod-2026-11",
      publisher: "acme.example",
      skills: [{ skillId: "demo", version: "1.0.0" }],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });
    expect(payload.mode).toBe("offline");
    expect(typeof payload.content_keys["demo@1.0.0"]).toBe("string");
    expect(() => checkOnlineScope(payload, { skillId: "demo", version: "1.0.0" })).toThrow(LicenseError);
  });
});
