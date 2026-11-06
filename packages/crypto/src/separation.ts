// F-19: key separation and kid rotation (proposal 14.8).
// Four independent key purposes exist. A leak of one purpose never implies
// another: signing keys are Ed25519 keypairs, the content root is an HKDF
// secret. Every key and secret carries a kid so rotation means minting a new
// kid and verifying against the matching public material.

export type KeyPurpose = "license-sign" | "artifact-sign" | "lease-sign" | "content-root";

export interface KeySeparationEntry {
  purpose: KeyPurpose;
  algorithm: "ed25519" | "hkdf-sha256";
  /** True when the material itself must stay secret (private key / root secret). */
  holdsSecret: boolean;
  /** True when only public material ships inside packages or runtimes. */
  publicMaterialOnly: boolean;
}

export const KEY_SEPARATION: Record<KeyPurpose, KeySeparationEntry> = {
  "license-sign": { purpose: "license-sign", algorithm: "ed25519", holdsSecret: true, publicMaterialOnly: true },
  "artifact-sign": { purpose: "artifact-sign", algorithm: "ed25519", holdsSecret: true, publicMaterialOnly: true },
  "lease-sign": { purpose: "lease-sign", algorithm: "ed25519", holdsSecret: true, publicMaterialOnly: true },
  "content-root": { purpose: "content-root", algorithm: "hkdf-sha256", holdsSecret: true, publicMaterialOnly: true },
};

/** kid rule: 1-64 chars of lowercase letters, digits, and hyphens. */
export function isValidKid(kid: string): boolean {
  return kid.length >= 1 && kid.length <= 64 && /^[a-z0-9-]+$/.test(kid) && !kid.startsWith("-") && !kid.endsWith("-");
}
