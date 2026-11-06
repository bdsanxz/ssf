// F-14: deterministic nonce derivation and AAD binding.
// Nonce: first 12 bytes of HKDF(file_key, "ssf/nonce" || SHA-256(plaintext)).
// The same content yields the same nonce (deterministic builds); different
// content yields a different nonce, so a nonce is never reused with different
// plaintext under the same key. AAD binds skill_id, version, and logical_id
// so encrypted blocks cannot be swapped across files or versions.

import { createHash, hkdfSync } from "node:crypto";

export const NONCE_BYTES = 12;

function field(value: string): Buffer {
  const body = Buffer.from(value, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  return Buffer.concat([length, body]);
}

/** Derive the 12-byte GCM nonce deterministically from the file content. */
export function deriveNonce(fileKey: Uint8Array, plaintext: Uint8Array): Buffer {
  const digest = createHash("sha256").update(plaintext).digest();
  const info = Buffer.concat([Buffer.from("ssf/nonce", "utf8"), digest]);
  return Buffer.from(hkdfSync("sha256", fileKey, Buffer.alloc(0), info, NONCE_BYTES));
}

/**
 * Build AAD binding skill, version, and logical id.
 * Format: "ssf-aad-v1" followed by length-prefixed UTF-8 fields, so no
 * concatenation of distinct triples can collide.
 */
export function buildAad(skillId: string, version: string, logicalId: string): Buffer {
  return Buffer.concat([Buffer.from("ssf-aad-v1", "utf8"), field(skillId), field(version), field(logicalId)]);
}
