import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveContentKey, generateRootSecret, generateSigningKeypair } from "@ssf/crypto";
import {
  issueLicense,
  leaseContentKey,
  requestLease,
  revokeLicenseId,
  verifyLease,
  type RevocationList,
} from "@ssf/license";

import { createRevocationReader, verifyOnlineRequest, type ServiceDeps } from "../src/service.js";
import { startLicenseService } from "../src/server.js";

const rootSecret = generateRootSecret();
const licenseKeys = generateSigningKeypair();
const leaseKeys = generateSigningKeypair();

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "ssf-svc-"));
  const revocationsFile = join(dir, "revoked.json");
  const deps: ServiceDeps = {
    licensePublicKey: licenseKeys.publicKey,
    leasePrivateKey: leaseKeys.privateKey,
    leaseKid: "lease-2026-01",
    rootSecret,
    revocationsFile,
    revocationTtlSeconds: 60,
    leaseTtlSeconds: 3600,
  };
  const token = issueLicense({
    rootSecret,
    licensePrivateKey: licenseKeys.privateKey,
    licenseKid: "prod-2026-11",
    publisher: "acme.example",
    skills: [{ skillId: "demo", version: "1.0.0" }],
    expiresAt: 1900000000,
    licenseId: "lic_online_1",
    nowSeconds: 1700000000,
    mode: "online",
  }).token;
  return { dir, deps, token };
}

describe("verifyOnlineRequest (F-95)", () => {
  test("mints a lease carrying the derived content key", () => {
    const { deps, token } = setup();
    const reader = createRevocationReader(deps.revocationsFile, 60);
    const body = verifyOnlineRequest({ token, skill_id: "demo", skill_version: "1.0.0" }, deps, reader, 1700000100);
    if (body.valid !== true) {
      throw new Error(`Expected an active lease, got ${JSON.stringify(body)}.`);
    }
    const payload = verifyLease(body.lease, { leasePublicKey: leaseKeys.publicKey, nowSeconds: 1700000100 });
    expect(payload.license_id).toBe("lic_online_1");
    expect(payload.skill_id).toBe("demo");
    expect(payload.skill_version).toBe("1.0.0");
    expect(leaseContentKey(payload)).toEqual(Buffer.from(deriveContentKey(rootSecret, "demo", "1.0.0")));
    rmSync(deps.revocationsFile.replace(/revoked\.json$/, ""), { recursive: true, force: true });
  });

  test("revoked licenses are refused; offline tokens are denied", () => {
    const { deps, token, dir } = setup();
    try {
      revokeLicenseId(deps.revocationsFile, "lic_online_1", 1700000000);
      const reader = createRevocationReader(deps.revocationsFile, 60);
      const revoked = verifyOnlineRequest({ token, skill_id: "demo", skill_version: "1.0.0" }, deps, reader, 1700000100);
      expect(revoked).toEqual({ valid: false, status: "revoked", error: "LICENSE_REVOKED" });
      const offline = issueLicense({
        rootSecret,
        licensePrivateKey: licenseKeys.privateKey,
        licenseKid: "prod-2026-11",
        publisher: "acme.example",
        skills: [{ skillId: "demo", version: "1.0.0" }],
        expiresAt: 1900000000,
        nowSeconds: 1700000000,
      }).token;
      const denied = verifyOnlineRequest(
        { token: offline, skill_id: "demo", skill_version: "1.0.0" },
        deps,
        reader,
        1700000100,
      );
      expect(denied.valid).toBe(false);
      const wrongScope = verifyOnlineRequest(
        { token, skill_id: "other", skill_version: "1.0.0" },
        { ...deps, revocationsFile: join(dir, "missing.json") },
        createRevocationReader(join(dir, "missing.json"), 60),
        1700000100,
      );
      expect(wrongScope).toEqual({ valid: false, status: "denied", error: "LICENSE_SCOPE" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("revocation reader caches within the TTL", () => {
    const { deps, dir } = setup();
    try {
      const reader = createRevocationReader(deps.revocationsFile, 60);
      expect(reader.read(1700000000)).toBeNull();
      revokeLicenseId(deps.revocationsFile, "lic_cached", 1700000010);
      expect(reader.read(1700000020)).toBeNull();
      const reloaded: RevocationList | null = reader.read(1700000100);
      expect(reloaded?.revoked).toEqual(["lic_cached"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("license HTTP transport (F-95)", () => {
  test("serves verify over loopback and rejects other routes", async () => {
    const { deps, token, dir } = setup();
    deps.revocationTtlSeconds = 0;
    let service: { url: string; close: () => Promise<void> } | null = null;
    try {
      service = await startLicenseService(deps);
      const lease = await requestLease({
        serviceUrl: service.url,
        token,
        skillId: "demo",
        skillVersion: "1.0.0",
      });
      const payload = verifyLease(lease, { leasePublicKey: leaseKeys.publicKey });
      expect(payload.license_id).toBe("lic_online_1");
      const missing = await fetch(new URL("/v1/unknown", service.url), { method: "POST" });
      expect(missing.status).toBe(404);
      const get = await fetch(new URL("/v1/licenses/verify", service.url));
      expect(get.status).toBe(405);
      const garbage = await fetch(new URL("/v1/licenses/verify", service.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not json",
      });
      expect(garbage.status).toBe(400);
      revokeLicenseId(deps.revocationsFile, "lic_online_1", Math.floor(Date.now() / 1000));
      await expect(
        requestLease({ serviceUrl: service.url, token, skillId: "demo", skillVersion: "1.0.0" }),
      ).rejects.toThrow("revoked");
    } finally {
      await service?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
