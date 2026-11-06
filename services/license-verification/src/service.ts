// F-95: online verification service core (pure, transport-free).
// Verifies the full token (signature, scope, expiry), consults the
// revocation list with a short-TTL cache, and mints a short-lived lease
// carrying the content key derived from the publisher root secret.
// The service only ever sees license_id, skill, version, and IP; it
// stores nothing per request.

import type { KeyObject } from "node:crypto";
import { deriveContentKey } from "@ssf/crypto";
import {
  LicenseError,
  checkOnlineScope,
  isRevoked,
  mintLease,
  readRevocationListFile,
  verifyLicenseToken,
  type LeasePayload,
  type RevocationList,
} from "@ssf/license";

export interface OnlineVerifyRequest {
  token: string;
  skill_id: string;
  skill_version: string;
}

export interface ServiceDeps {
  licensePublicKey: KeyObject;
  leasePrivateKey: KeyObject;
  leaseKid: string;
  /** Publisher root secret (32 bytes); the service derives content keys from it. */
  rootSecret: Buffer;
  revocationsFile: string;
  /** Revocation cache TTL in seconds (default 60). */
  revocationTtlSeconds?: number;
  /** Lease lifetime in seconds (default 6h, within the 1-24h window). */
  leaseTtlSeconds?: number;
}

export type OnlineVerifyResponse =
  | { valid: true; status: "active"; lease: string }
  | { valid: false; status: "revoked"; error: "LICENSE_REVOKED" }
  | { valid: false; status: "denied"; error: string };

/** Cached revocation-list reader: reloads at most once per TTL. */
export function createRevocationReader(file: string, ttlSeconds = 60): {
  read: (nowSeconds?: number) => RevocationList | null;
} {
  let cached: RevocationList | null = null;
  let loadedAt = -Infinity;
  return {
    read: (nowSeconds?: number): RevocationList | null => {
      const now = nowSeconds ?? Math.floor(Date.now() / 1000);
      if (now - loadedAt < ttlSeconds && loadedAt !== -Infinity) {
        return cached;
      }
      cached = readRevocationListFile(file);
      loadedAt = now;
      return cached;
    },
  };
}

function denied(error: unknown): OnlineVerifyResponse {
  const code = error instanceof LicenseError ? error.code : "LICENSE_INVALID";
  return { valid: false, status: "denied", error: code };
}

/**
 * Verify one online request and mint a lease (or refuse). Never throws
 * for request problems; unexpected failures also become denials so the
 * service never leaks internals to callers.
 */
export function verifyOnlineRequest(
  request: OnlineVerifyRequest,
  deps: ServiceDeps,
  reader: { read: (nowSeconds?: number) => RevocationList | null },
  nowSeconds?: number,
): OnlineVerifyResponse {
  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  if (
    typeof request.token !== "string" ||
    request.token.length === 0 ||
    typeof request.skill_id !== "string" ||
    request.skill_id.length === 0 ||
    typeof request.skill_version !== "string" ||
    request.skill_version.length === 0
  ) {
    return { valid: false, status: "denied", error: "LICENSE_INVALID" };
  }
  if (deps.rootSecret.length !== 32) {
    return { valid: false, status: "denied", error: "LICENSE_INVALID" };
  }
  let payload;
  try {
    payload = verifyLicenseToken(request.token, { licensePublicKey: deps.licensePublicKey, nowSeconds: now });
  } catch (error) {
    return denied(error);
  }
  if (payload.mode !== "online") {
    return { valid: false, status: "denied", error: "LICENSE_INVALID" };
  }
  try {
    checkOnlineScope(payload, { skillId: request.skill_id, version: request.skill_version });
  } catch (error) {
    return denied(error);
  }
  let list: RevocationList | null;
  try {
    list = reader.read(now);
  } catch {
    return { valid: false, status: "denied", error: "LICENSE_INVALID" };
  }
  if (list !== null && isRevoked(list, payload.license_id)) {
    return { valid: false, status: "revoked", error: "LICENSE_REVOKED" };
  }
  try {
    const contentKey = deriveContentKey(deps.rootSecret, request.skill_id, request.skill_version);
    const { lease } = mintLease({
      contentKey,
      leasePrivateKey: deps.leasePrivateKey,
      leaseKid: deps.leaseKid,
      licenseId: payload.license_id,
      skillId: request.skill_id,
      skillVersion: request.skill_version,
      ttlSeconds: deps.leaseTtlSeconds ?? 6 * 3600,
      nowSeconds: now,
    });
    return { valid: true, status: "active", lease };
  } catch {
    return { valid: false, status: "denied", error: "LICENSE_INVALID" };
  }
}

export type { LeasePayload };
