// F-41/F-95: online lease minting and verification.
// A lease is a short-lived signed document from the license service. It
// carries the content key for one skill version, so an online token stays
// small while key delivery still requires a fresh server decision. Lease
// format mirrors the token layout: lease1.<kid>.<payload-base64url>.
// <signature-base64url>, signed over the original payload bytes.

import { sign, verify, type KeyObject } from "node:crypto";
import { isValidKid } from "@ssf/crypto";
import { LicenseError } from "./verify.js";

export const LEASE_FORMAT = "lease1";

/** Smallest and largest lease lifetimes the minter accepts (seconds). */
export const MIN_LEASE_TTL_SECONDS = 60;
export const MAX_LEASE_TTL_SECONDS = 24 * 3600;

export interface LeasePayload {
  license_id: string;
  skill_id: string;
  skill_version: string;
  content_key: string;
  issued_at: number;
  expires_at: number;
}

export interface MintLeaseOptions {
  contentKey: Uint8Array;
  leasePrivateKey: KeyObject;
  leaseKid: string;
  licenseId: string;
  skillId: string;
  skillVersion: string;
  /** Lease lifetime in seconds (60s to 24h). */
  ttlSeconds: number;
  nowSeconds?: number;
}

export interface VerifyLeaseOptions {
  leasePublicKey: KeyObject;
  nowSeconds?: number;
}

/** Serialize a lease payload with fixed field order for stable signing bytes. */
export function leaseToBytes(payload: LeasePayload): Buffer {
  return Buffer.from(
    JSON.stringify({
      license_id: payload.license_id,
      skill_id: payload.skill_id,
      skill_version: payload.skill_version,
      content_key: payload.content_key,
      issued_at: payload.issued_at,
      expires_at: payload.expires_at,
    }),
    "utf8",
  );
}

function fromBase64Url(part: string, what: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) {
    throw new LicenseError("LICENSE_INVALID", `Lease ${what} is not base64url.`);
  }
  try {
    return Buffer.from(part, "base64url");
  } catch {
    throw new LicenseError("LICENSE_INVALID", `Lease ${what} is not base64url.`);
  }
}

/** Mint a signed lease for one skill version. */
export function mintLease(options: MintLeaseOptions): { lease: string; payload: LeasePayload } {
  if (!isValidKid(options.leaseKid)) {
    throw new LicenseError("LICENSE_INVALID", "Lease kid is invalid.");
  }
  if (options.licenseId.length === 0 || options.skillId.length === 0 || options.skillVersion.length === 0) {
    throw new LicenseError("LICENSE_INVALID", "Lease needs a license id, skill id, and skill version.");
  }
  if (!Number.isInteger(options.ttlSeconds) || options.ttlSeconds < MIN_LEASE_TTL_SECONDS || options.ttlSeconds > MAX_LEASE_TTL_SECONDS) {
    throw new LicenseError(
      "LICENSE_INVALID",
      `Lease TTL must be ${MIN_LEASE_TTL_SECONDS} to ${MAX_LEASE_TTL_SECONDS} seconds.`,
    );
  }
  if (options.contentKey.length === 0) {
    throw new LicenseError("LICENSE_INVALID", "Lease needs a content key.");
  }
  const issuedAt = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const payload: LeasePayload = {
    license_id: options.licenseId,
    skill_id: options.skillId,
    skill_version: options.skillVersion,
    content_key: Buffer.from(options.contentKey).toString("base64url"),
    issued_at: issuedAt,
    expires_at: issuedAt + options.ttlSeconds,
  };
  const payloadBytes = leaseToBytes(payload);
  const signature = sign(null, payloadBytes, options.leasePrivateKey);
  const lease = `${LEASE_FORMAT}.${options.leaseKid}.${payloadBytes.toString("base64url")}.${signature.toString("base64url")}`;
  return { lease, payload };
}

/** Verify a lease signature and expiry, then return its payload. */
export function verifyLease(lease: string, options: VerifyLeaseOptions): LeasePayload {
  const parts = lease.split(".");
  if (parts.length !== 4 || parts[0] !== LEASE_FORMAT) {
    throw new LicenseError("LICENSE_INVALID", "Lease has an invalid format.");
  }
  const kid = parts[1] as string;
  if (!isValidKid(kid)) {
    throw new LicenseError("LICENSE_INVALID", "Lease kid is invalid.");
  }
  const payloadBytes = fromBase64Url(parts[2] as string, "payload");
  const signature = fromBase64Url(parts[3] as string, "signature");
  let payload: LeasePayload;
  try {
    payload = JSON.parse(payloadBytes.toString("utf8")) as LeasePayload;
  } catch {
    throw new LicenseError("LICENSE_INVALID", "Lease payload is not JSON.");
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new LicenseError("LICENSE_INVALID", "Lease payload must be an object.");
  }
  let valid = false;
  try {
    valid = verify(null, payloadBytes, options.leasePublicKey, signature);
  } catch {
    valid = false;
  }
  if (!valid) {
    throw new LicenseError("LICENSE_INVALID", "Lease signature is invalid.");
  }
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (typeof payload.expires_at !== "number" || payload.expires_at <= now) {
    throw new LicenseError("LEASE_EXPIRED", "Lease has expired.");
  }
  if (
    typeof payload.license_id !== "string" ||
    typeof payload.skill_id !== "string" ||
    typeof payload.skill_version !== "string" ||
    typeof payload.content_key !== "string"
  ) {
    throw new LicenseError("LICENSE_INVALID", "Lease payload is missing required fields.");
  }
  return payload;
}

/** Decode the content key carried by a verified lease payload. */
export function leaseContentKey(payload: LeasePayload): Buffer {
  return Buffer.from(payload.content_key, "base64url");
}

