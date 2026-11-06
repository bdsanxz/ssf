// F-36: offline license verification (fully local).
// Checks signature, kid, expiry, and scope with no server, no network, and
// no telemetry. Expiry is cooperative and bound to the local clock; high
// risk skills should use short lifetimes because offline tokens cannot be
// revoked before expires_at. Token size grows about 45 chars per key.

import type { KeyObject } from "node:crypto";
import { assertProductionKid } from "@ssf/crypto";
import { parseToken, verifyTokenSignature, TokenFormatError, type LicensePayload } from "./token.js";

export type LicenseFailureCode =
  | "LICENSE_MISSING"
  | "LICENSE_INVALID"
  | "LICENSE_EXPIRED"
  | "LICENSE_SCOPE"
  | "LICENSE_DEV_KEY"
  | "LICENSE_REVOKED"
  | "LEASE_EXPIRED"
  | "NETWORK_UNAVAILABLE";

export class LicenseError extends Error {
  readonly code: LicenseFailureCode;

  constructor(code: LicenseFailureCode, message: string) {
    super(message);
    this.name = "LicenseError";
    this.code = code;
  }
}

export interface VerifyOptions {
  licensePublicKey: KeyObject;
  expectedPublisher?: string;
  nowSeconds?: number;
  /** Dev runtimes accept kid "dev" (never "example"); production rejects both. */
  dev?: boolean;
}

export interface ScopeRequest {
  skillId: string;
  version: string;
}

/** Verify token trust and return the payload. Scope is checked separately. */
export function verifyLicenseToken(token: string, options: VerifyOptions): LicensePayload {
  let parsed;
  try {
    parsed = parseToken(token);
  } catch (error) {
    if (error instanceof TokenFormatError) {
      throw new LicenseError("LICENSE_INVALID", error.message);
    }
    throw new LicenseError("LICENSE_INVALID", error instanceof Error ? error.message : "Invalid token.");
  }
  if (!(options.dev === true && parsed.kid === "dev")) {
    try {
      assertProductionKid(parsed.kid);
    } catch {
      throw new LicenseError("LICENSE_DEV_KEY", `Test key material (kid "${parsed.kid}") is rejected in production.`);
    }
  }
  if (!verifyTokenSignature(options.licensePublicKey, parsed)) {
    throw new LicenseError("LICENSE_INVALID", "Token signature is invalid.");
  }
  const payload = parsed.payload;
  if (options.expectedPublisher !== undefined && payload.publisher !== options.expectedPublisher) {
    throw new LicenseError("LICENSE_INVALID", "Token publisher does not match this skill.");
  }
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (typeof payload.expires_at !== "number" || payload.expires_at <= now) {
    throw new LicenseError("LICENSE_EXPIRED", "License has expired.");
  }
  if (payload.mode !== "offline" && payload.mode !== "online") {
    throw new LicenseError("LICENSE_INVALID", "Token mode must be offline or online.");
  }
  if (!Array.isArray(payload.skills) || typeof payload.content_keys !== "object" || payload.content_keys === null) {
    throw new LicenseError("LICENSE_INVALID", "Token payload is missing skills or content keys.");
  }
  return payload;
}

/** Check that a verified payload covers one skill version. */
export function checkScope(payload: LicensePayload, request: ScopeRequest): void {
  if (!payload.skills.includes(request.skillId)) {
    throw new LicenseError("LICENSE_SCOPE", `License does not cover skill "${request.skillId}".`);
  }
  if (payload.content_keys[`${request.skillId}@${request.version}`] === undefined) {
    throw new LicenseError(
      "LICENSE_SCOPE",
      `License does not cover ${request.skillId} version ${request.version}. A renewed token carries newer version keys.`,
    );
  }
}

/**
 * F-35/F-41: scope check for online tokens, which carry no content_keys.
 * The token authorizes skill ids; the requested version is recorded in the
 * lease the service issues (versions float under the token's expiry).
 */
export function checkOnlineScope(payload: LicensePayload, request: ScopeRequest): void {
  if (payload.mode !== "online") {
    throw new LicenseError("LICENSE_INVALID", "Online scope needs an online token.");
  }
  if (!payload.skills.includes(request.skillId)) {
    throw new LicenseError("LICENSE_SCOPE", `License does not cover skill "${request.skillId}".`);
  }
  if (typeof request.version !== "string" || request.version.length === 0) {
    throw new LicenseError("LICENSE_SCOPE", "A skill version is required.");
  }
}

/** F-37: fetch the content key for one skill version from a verified payload. */
export function contentKeyFor(payload: LicensePayload, request: ScopeRequest): Buffer {
  checkScope(payload, request);
  const encoded = payload.content_keys[`${request.skillId}@${request.version}`] as string;
  return Buffer.from(encoded, "base64url");
}
