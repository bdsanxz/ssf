// F-15: AES-256-GCM authenticated encryption using node:crypto only.
// The algorithm is fixed and cannot be replaced by plugins. The GCM auth tag
// validates the key, so content obtained through provideKey plugins is still
// authenticated here. No custom cryptography is implemented in this file.

import { createCipheriv, createDecipheriv } from "node:crypto";
import { NONCE_BYTES } from "./nonce.js";

/** The single AEAD algorithm used for all protected content. */
export const AEAD_ALGORITHM = "aes-256-gcm" as const;
export const AEAD_KEY_BYTES = 32;
export const AEAD_TAG_BYTES = 16;

export interface SealedBlock {
  nonce: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
}

export class DecryptionError extends Error {
  constructor(message = "Decryption failed: authentication error.") {
    super(message);
    this.name = "DecryptionError";
  }
}

/** Encrypt plaintext with an explicit nonce and AAD. */
export function seal(fileKey: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): SealedBlock {
  if (fileKey.length !== AEAD_KEY_BYTES) {
    throw new Error(`File key must be ${AEAD_KEY_BYTES} bytes.`);
  }
  if (nonce.length !== NONCE_BYTES) {
    throw new Error(`Nonce must be ${NONCE_BYTES} bytes.`);
  }
  const cipher = createCipheriv(AEAD_ALGORITHM, fileKey, nonce, { authTagLength: AEAD_TAG_BYTES });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { nonce: Buffer.from(nonce), ciphertext, tag: cipher.getAuthTag() };
}

/** Decrypt and authenticate. Throws DecryptionError on any tampering. */
export function open(
  fileKey: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
  tag: Uint8Array,
  aad: Uint8Array,
): Buffer {
  try {
    const decipher = createDecipheriv(AEAD_ALGORITHM, fileKey, nonce, { authTagLength: AEAD_TAG_BYTES });
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new DecryptionError();
  }
}
