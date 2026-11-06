// F-43: server-side license check for remote mode.
// The publisher server re-verifies the full token on every call (signature,
// scope, expiry) and decides the result from the verified payload. Client
// claims are never trusted: the token in the Authorization header is the
// only license evidence.

import type { KeyObject } from "node:crypto";
import {
  LicenseError,
  checkOnlineScope,
  checkScope,
  verifyLicenseToken,
  type LicensePayload,
} from "@ssf/license";

export interface RemoteCallAuth {
  /** Raw Authorization header value ("Bearer <token>" or the bare token). */
  authorization: string | null | undefined;
  licensePublicKey: KeyObject;
  skillId: string;
  /** Required version; omit when the server negotiates versions itself. */
  version?: string;
  expectedPublisher?: string;
  nowSeconds?: number;
  /** Accept kid "dev" (tests only, never "example"). */
  dev?: boolean;
}

/** Extract the bearer token without ever logging it. */
export function bearerToken(authorization: string | null | undefined): string {
  if (!authorization) {
    throw new LicenseError("LICENSE_MISSING", "Remote call needs a license key.");
  }
  const trimmed = authorization.trim();
  const bare = trimmed.toLowerCase().startsWith("bearer ") ? trimmed.slice(7).trim() : trimmed;
  if (bare.length === 0) {
    throw new LicenseError("LICENSE_MISSING", "Remote call needs a license key.");
  }
  return bare;
}

/**
 * Verify one remote call against the license and return the payload the
 * server decides from. Online tokens scope by skill id; offline tokens
 * additionally pin the exact version (use the version parameter or serve
 * the versions the token covers).
 */
export function authorizeRemoteCall(auth: RemoteCallAuth): LicensePayload {
  const token = bearerToken(auth.authorization);
  const payload = verifyLicenseToken(token, {
    licensePublicKey: auth.licensePublicKey,
    expectedPublisher: auth.expectedPublisher,
    nowSeconds: auth.nowSeconds,
    dev: auth.dev,
  });
  if (auth.version === undefined) {
    if (!payload.skills.includes(auth.skillId)) {
      throw new LicenseError("LICENSE_SCOPE", `License does not cover skill "${auth.skillId}".`);
    }
    return payload;
  }
  if (payload.mode === "online") {
    checkOnlineScope(payload, { skillId: auth.skillId, version: auth.version });
  } else {
    checkScope(payload, { skillId: auth.skillId, version: auth.version });
  }
  return payload;
}
