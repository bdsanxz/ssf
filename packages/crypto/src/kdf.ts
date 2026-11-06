// F-13: publisher root secret and HKDF key derivation.
// The root secret is a 256-bit random value with a kid. It is not a keypair
// and must be treated like a private key: a leak opens every version.
// Key schedule (proposal 11.2):
//   content_key = HKDF(root_secret, "ssf/content-key" || skill_id || version)
//   file_key    = HKDF(content_key, "ssf/file-key" || logical_id)

import { hkdfSync, randomBytes } from "node:crypto";

export const ROOT_SECRET_BYTES = 32;
export const DERIVED_KEY_BYTES = 32;

function info(...parts: Array<string | Uint8Array>): Buffer {
  const buffers = parts.map((p) => (typeof p === "string" ? Buffer.from(p, "utf8") : Buffer.from(p)));
  return Buffer.concat(buffers);
}

/** Generate a fresh 256-bit publisher root secret. */
export function generateRootSecret(): Buffer {
  return randomBytes(ROOT_SECRET_BYTES);
}

/**
 * Derive the per-skill per-version content key from the root secret.
 * The content key is never stored in a package; the license issuer
 * derives it from the same root secret when issuing tokens.
 */
export function deriveContentKey(rootSecret: Uint8Array, skillId: string, version: string): Buffer {
  if (rootSecret.length !== ROOT_SECRET_BYTES) {
    throw new Error(`Root secret must be ${ROOT_SECRET_BYTES} bytes.`);
  }
  return Buffer.from(
    hkdfSync("sha256", rootSecret, Buffer.alloc(0), info("ssf/content-key", skillId, version), DERIVED_KEY_BYTES),
  );
}

/** Derive the per-file key from a content key and the file logical id. */
export function deriveFileKey(contentKey: Uint8Array, logicalId: string): Buffer {
  if (contentKey.length !== DERIVED_KEY_BYTES) {
    throw new Error(`Content key must be ${DERIVED_KEY_BYTES} bytes.`);
  }
  return Buffer.from(hkdfSync("sha256", contentKey, Buffer.alloc(0), info("ssf/file-key", logicalId), DERIVED_KEY_BYTES));
}
