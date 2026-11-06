// F-17: Ed25519 artifact signatures using node:crypto only.
// The whole container is signed with a kid. Ed25519 is deterministic, so a
// rebuild of the same release yields identical signature bytes. Runtimes
// verify the signature BEFORE decryption. The signature provides integrity
// and publisher origin, not confidentiality; the trust anchor is the runtime.

import { generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";

export interface ArtifactSignature {
  kid: string;
  signature: Buffer;
}

export class ArtifactSignatureError extends Error {
  constructor(message = "Artifact signature verification failed.") {
    super(message);
    this.name = "ArtifactSignatureError";
  }
}

/** Generate an Ed25519 signing keypair (license, artifact, or lease use). */
export function generateSigningKeypair(): { publicKey: KeyObject; privateKey: KeyObject } {
  return generateKeyPairSync("ed25519");
}

/** Sign container bytes. Returns the kid alongside the raw signature. */
export function signArtifact(privateKey: KeyObject, containerBytes: Uint8Array, kid: string): ArtifactSignature {
  if (kid.length === 0) {
    throw new Error("Signing requires a non-empty kid.");
  }
  const signature = sign(null, containerBytes, privateKey);
  return { kid, signature };
}

/** Verify container bytes against a signature. Returns false on any mismatch. */
export function verifyArtifact(publicKey: KeyObject, containerBytes: Uint8Array, signature: Uint8Array): boolean {
  try {
    return verify(null, containerBytes, publicKey, signature);
  } catch {
    return false;
  }
}

/** Verify container bytes, throwing ArtifactSignatureError when invalid. */
export function assertArtifactSignature(
  publicKey: KeyObject,
  containerBytes: Uint8Array,
  signature: Uint8Array,
): void {
  if (!verifyArtifact(publicKey, containerBytes, signature)) {
    throw new ArtifactSignatureError();
  }
}
