// F-41: online content-key resolution (runtime core, fail-closed).
// For online tokens the token carries no content_keys, so the key arrives
// inside a short-lived signed lease. Resolution order: a valid cached lease
// (config dir, 0600, no network call) wins; otherwise the runtime calls the
// verification service, stores the fresh lease, and uses its key. Every
// failure denies access: expired leases and unreachable servers never fall
// back to an offline path.

import { readFileSync } from "node:fs";
import type { KeyObject } from "node:crypto";
import {
  leaseContentKey,
  LicenseError,
  requestLease,
  verifyLease,
  type LicensePayload,
} from "@ssf/license";
import { leasePath, writePrivateFile } from "./state.js";

export interface OnlineKeyOptions {
  payload: LicensePayload;
  token: string;
  skillId: string;
  version: string;
  serviceUrl: string;
  leasePublicKey: KeyObject;
  stateDir: string;
  nowSeconds: number;
  fetchFn?: typeof fetch;
}

/** Read the cached lease file; null when missing or unreadable. */
function readCachedLeaseText(stateDir: string): string | null {
  try {
    const text = readFileSync(leasePath(stateDir), "utf8").trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

/**
 * Verify that a lease belongs to this license, skill, and version. A lease
 * minted for another skill or license never unlocks this one.
 */
export function checkLeaseBinding(
  payload: LicensePayload,
  lease: { license_id: string; skill_id: string; skill_version: string },
  skillId: string,
  version: string,
): void {
  if (lease.license_id !== payload.license_id || lease.skill_id !== skillId || lease.skill_version !== version) {
    throw new LicenseError("LICENSE_INVALID", "Lease does not cover this license, skill, and version.");
  }
}

/** Verify a lease and decode its content key (throws LEASE_EXPIRED when stale). */
function keyFromLease(
  payload: LicensePayload,
  lease: string,
  options: OnlineKeyOptions,
): Buffer {
  const verified = verifyLease(lease, { leasePublicKey: options.leasePublicKey, nowSeconds: options.nowSeconds });
  checkLeaseBinding(payload, verified, options.skillId, options.version);
  return leaseContentKey(verified);
}

/**
 * Resolve the content key for an online token. Throws LICENSE_REVOKED
 * when the service reports revocation, LEASE_EXPIRED when the cached
 * lease is stale and renewal fails, NETWORK_UNAVAILABLE when the
 * service cannot be reached, and LICENSE_INVALID for refusals.
 */
export async function resolveOnlineContentKey(options: OnlineKeyOptions): Promise<Buffer> {
  const cached = readCachedLeaseText(options.stateDir);
  if (cached !== null) {
    try {
      return keyFromLease(options.payload, cached, options);
    } catch (error) {
      if (!(error instanceof LicenseError)) {
        throw error;
      }
      // Stale, corrupt, or mismatched cache: fall through to renewal. The
      // service re-verifies the token and revocation state, so a bad cache
      // file can neither grant access nor brick the runtime by itself.
    }
  }
  let lease: string;
  try {
    lease = await requestLease({
      serviceUrl: options.serviceUrl,
      token: options.token,
      skillId: options.skillId,
      skillVersion: options.version,
      fetchFn: options.fetchFn,
    });
  } catch (error) {
    if (error instanceof LicenseError && error.code === "NETWORK_UNAVAILABLE" && cached !== null) {
      throw new LicenseError(
        "LEASE_EXPIRED",
        "Lease has expired and the license service is unreachable. Reconnect to renew the license.",
      );
    }
    throw error;
  }
  const key = keyFromLease(options.payload, lease, options);
  writePrivateFile(leasePath(options.stateDir), lease);
  return key;
}
