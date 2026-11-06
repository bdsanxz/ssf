// F-35: ssf1 multi-skill token format.
// ssf1.<kid>.<payload-base64url>.<signature-base64url>. The signature covers
// the original payload bytes, never a JSON reserialization, so byte-identical
// payloads verify. Offline payloads carry license_id, publisher, mode,
// skills, timestamps, content_keys per skill@version, and signed ext claims.

import { sign, verify, type KeyObject } from "node:crypto";
import { isValidKid } from "@ssf/crypto";

export const TOKEN_FORMAT = "ssf1";

export interface LicensePayload {
  license_id: string;
  publisher: string;
  mode: "offline" | "online";
  skills: string[];
  issued_at: number;
  expires_at: number;
  content_keys: Record<string, string>;
  ext: Record<string, unknown>;
}

export interface ParsedToken {
  kid: string;
  payloadBytes: Buffer;
  payload: LicensePayload;
  signature: Buffer;
}

export class TokenFormatError extends Error {
  constructor(message = "License token has an invalid format.") {
    super(message);
    this.name = "TokenFormatError";
  }
}

/** Serialize a payload with fixed field order for stable signing bytes. */
export function payloadToBytes(payload: LicensePayload): Buffer {
  return Buffer.from(
    JSON.stringify({
      license_id: payload.license_id,
      publisher: payload.publisher,
      mode: payload.mode,
      skills: payload.skills,
      issued_at: payload.issued_at,
      expires_at: payload.expires_at,
      content_keys: payload.content_keys,
      ext: payload.ext,
    }),
    "utf8",
  );
}

function fromBase64Url(part: string, what: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) {
    throw new TokenFormatError(`Token ${what} is not base64url.`);
  }
  try {
    return Buffer.from(part, "base64url");
  } catch {
    throw new TokenFormatError(`Token ${what} is not base64url.`);
  }
}

/** Parse and structurally validate a token string without verifying trust. */
export function parseToken(token: string): ParsedToken {
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== TOKEN_FORMAT) {
    throw new TokenFormatError();
  }
  const kid = parts[1] as string;
  if (!isValidKid(kid)) {
    throw new TokenFormatError("Token kid is invalid.");
  }
  const payloadBytes = fromBase64Url(parts[2] as string, "payload");
  const signature = fromBase64Url(parts[3] as string, "signature");
  let payload: LicensePayload;
  try {
    payload = JSON.parse(payloadBytes.toString("utf8")) as LicensePayload;
  } catch {
    throw new TokenFormatError("Token payload is not JSON.");
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new TokenFormatError("Token payload must be an object.");
  }
  return { kid, payloadBytes, payload, signature };
}

/** Sign payload bytes with a license signing key. */
export function signTokenPayload(privateKey: KeyObject, payloadBytes: Buffer, kid: string): string {
  if (!isValidKid(kid)) {
    throw new TokenFormatError("Token kid is invalid.");
  }
  const signature = sign(null, payloadBytes, privateKey);
  return `${TOKEN_FORMAT}.${kid}.${payloadBytes.toString("base64url")}.${signature.toString("base64url")}`;
}

/** Verify a token signature against the original payload bytes. */
export function verifyTokenSignature(publicKey: KeyObject, parsed: ParsedToken): boolean {
  try {
    return verify(null, parsed.payloadBytes, publicKey, parsed.signature);
  } catch {
    return false;
  }
}
