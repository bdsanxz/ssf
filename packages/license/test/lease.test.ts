import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveContentKey, generateRootSecret, generateSigningKeypair } from "@ssf/crypto";

import {
  LicenseError,
  isRevoked,
  leaseContentKey,
  mintLease,
  parseRevocationList,
  readRevocationListFile,
  requestLease,
  revokeLicenseId,
  verifyLease,
} from "../src/index.js";

const rootSecret = generateRootSecret();
const leaseKeys = generateSigningKeypair();

function mintFor(content = new TextEncoder().encode("x".repeat(32))) {
  return mintLease({
    contentKey: content,
    leasePrivateKey: leaseKeys.privateKey,
    leaseKid: "lease-2026-01",
    licenseId: "lic_test",
    skillId: "demo",
    skillVersion: "1.0.0",
    ttlSeconds: 3600,
    nowSeconds: 1700000000,
  });
}

describe("lease mint/verify (F-41/F-95)", () => {
  test("round-trips one skill version with a short expiry", () => {
    const key = deriveContentKey(rootSecret, "demo", "1.0.0");
    const { lease, payload } = mintLease({
      contentKey: key,
      leasePrivateKey: leaseKeys.privateKey,
      leaseKid: "lease-2026-01",
      licenseId: "lic_test",
      skillId: "demo",
      skillVersion: "1.0.0",
      ttlSeconds: 3600,
      nowSeconds: 1700000000,
    });
    expect(lease.split(".").length).toBe(4);
    expect(lease.startsWith("lease1.lease-2026-01.")).toBe(true);
    expect(payload.expires_at).toBe(1700003600);
    const verified = verifyLease(lease, { leasePublicKey: leaseKeys.publicKey, nowSeconds: 1700000100 });
    expect(verified.license_id).toBe("lic_test");
    expect(leaseContentKey(verified)).toEqual(Buffer.from(key));
  });

  test("rejects expired leases, bad signatures, and bad TTLs", () => {
    const { lease } = mintFor();
    expect(() => verifyLease(lease, { leasePublicKey: leaseKeys.publicKey, nowSeconds: 1700000000 + 7200 })).toThrow(
      LicenseError,
    );
    try {
      verifyLease(lease, { leasePublicKey: leaseKeys.publicKey, nowSeconds: 1700000000 + 7200 });
      expect.unreachable();
    } catch (error) {
      expect((error as LicenseError).code).toBe("LEASE_EXPIRED");
    }
    const tampered = `${lease.slice(0, -4)}aaaa`;
    expect(() => verifyLease(tampered, { leasePublicKey: leaseKeys.publicKey })).toThrow(LicenseError);
    const other = generateSigningKeypair();
    expect(() =>
      mintLease({
        contentKey: new TextEncoder().encode("x".repeat(32)),
        leasePrivateKey: other.privateKey,
        leaseKid: "lease-2026-01",
        licenseId: "lic_test",
        skillId: "demo",
        skillVersion: "1.0.0",
        ttlSeconds: 30,
        nowSeconds: 1700000000,
      }),
    ).toThrow(LicenseError);
  });
});

describe("revocation list (F-42)", () => {
  test("appends ids idempotently and detects membership", () => {
    const dir = mkdtempSync(join(tmpdir(), "ssf-rev-"));
    try {
      const path = join(dir, "revoked.json");
      expect(readRevocationListFile(path)).toBeNull();
      const first = revokeLicenseId(path, "lic_1", 1700000000);
      expect(first.revoked).toEqual(["lic_1"]);
      expect(isRevoked(first, "lic_1")).toBe(true);
      expect(isRevoked(first, "lic_2")).toBe(false);
      const second = revokeLicenseId(path, "lic_1", 1700000100);
      expect(second.revoked).toEqual(["lic_1"]);
      revokeLicenseId(path, "lic_2", 1700000200);
      expect(readRevocationListFile(path)?.revoked).toEqual(["lic_1", "lic_2"]);
      expect(() => parseRevocationList({ updated_at: 1, revoked: [""] })).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("service client (F-41)", () => {
  function stubFetch(respond: () => Promise<Response>): typeof fetch {
    return (async () => respond()) as unknown as typeof fetch;
  }

  test("returns the lease on active responses", async () => {
    const { lease } = mintFor();
    const fetchFn = stubFetch(
      async () =>
        new Response(JSON.stringify({ valid: true, status: "active", lease }), { status: 200 }),
    );
    const seen = await requestLease({
      serviceUrl: "https://licenses.example.com",
      token: "tok",
      skillId: "demo",
      skillVersion: "1.0.0",
      fetchFn,
    });
    expect(seen).toBe(lease);
  });

  test("maps revoked, refused, and network failures", async () => {
    const revokedFetch = stubFetch(
      async () =>
        new Response(JSON.stringify({ valid: false, status: "revoked", error: "LICENSE_REVOKED" }), {
          status: 403,
        }),
    );
    await expect(
      requestLease({ serviceUrl: "https://licenses.example.com", token: "t", skillId: "s", skillVersion: "v", fetchFn: revokedFetch }),
    ).rejects.toThrow("revoked");
    const deniedFetch = stubFetch(
      async () =>
        new Response(JSON.stringify({ valid: false, status: "denied", error: "LICENSE_SCOPE" }), {
          status: 403,
        }),
    );
    await expect(
      requestLease({ serviceUrl: "https://licenses.example.com", token: "t", skillId: "s", skillVersion: "v", fetchFn: deniedFetch }),
    ).rejects.toThrow("LICENSE_SCOPE");
    const downFetch = stubFetch(async () => {
      throw new Error("down");
    });
    await expect(
      requestLease({ serviceUrl: "https://licenses.example.com", token: "t", skillId: "s", skillVersion: "v", fetchFn: downFetch }),
    ).rejects.toThrow("unreachable");
  });

  test("requires https outside loopback", async () => {
    const { lease } = mintFor();
    const fetchFn = stubFetch(
      async () =>
        new Response(JSON.stringify({ valid: true, status: "active", lease }), { status: 200 }),
    );
    await expect(
      requestLease({ serviceUrl: "http://licenses.example.com", token: "t", skillId: "s", skillVersion: "v", fetchFn }),
    ).rejects.toThrow("https");
    await expect(
      requestLease({ serviceUrl: "http://127.0.0.1:9", token: "t", skillId: "s", skillVersion: "v", fetchFn }),
    ).resolves.toBe(lease);
  });
});
