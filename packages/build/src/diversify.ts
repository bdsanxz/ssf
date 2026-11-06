// F-25: release seed diversification.
// The release seed is HKDF(root_secret, "ssf/seed" || skill_id || version),
// so obfuscation and layout differ per publisher and per version without any
// stored state. The seed only feeds renaming and ordering; behavior stays
// identical. Documented limit: this raises the cost of generic cracking
// tools, it does not stop targeted manual analysis of one build.

import { hkdfSync, randomBytes } from "node:crypto";

export const SEED_INFO_PREFIX = "ssf/seed";
export const SEED_BYTES = 32;

/** Derive the 32-byte release seed for one skill version. */
export function deriveReleaseSeed(rootSecret: Uint8Array, skillId: string, version: string): Buffer {
  if (rootSecret.length !== 32) {
    throw new Error("Root secret must be 32 bytes.");
  }
  return Buffer.from(
    hkdfSync(
      "sha256",
      rootSecret,
      Buffer.alloc(0),
      Buffer.concat([Buffer.from(SEED_INFO_PREFIX, "utf8"), Buffer.from(skillId, "utf8"), Buffer.from(version, "utf8")]),
      SEED_BYTES,
    ),
  );
}

/** Fold a 32-byte seed into the uint32 obfuscator seed. */
export function seedToUint32(seed: Uint8Array): number {
  return Buffer.from(seed).readUInt32BE(0);
}

/** Random seed for dev builds, which must never be released. */
export function devSeed(): number {
  return randomBytes(4).readUInt32BE(0);
}

export interface SeedSelection {
  releaseSeed: Buffer;
  obfuscatorSeed: number;
  dev: boolean;
}

/**
 * Pick seeds for a build. An explicit override (for example --seed) wins;
 * dev builds use a random seed; otherwise the release seed is derived.
 */
export function pickSeeds(
  rootSecret: Uint8Array,
  skillId: string,
  version: string,
  options: { seedOverride?: number; dev?: boolean } = {},
): SeedSelection {
  const dev = options.dev ?? false;
  if (options.seedOverride !== undefined) {
    return { releaseSeed: deriveReleaseSeed(rootSecret, skillId, version), obfuscatorSeed: options.seedOverride, dev };
  }
  if (dev) {
    return { releaseSeed: deriveReleaseSeed(rootSecret, skillId, version), obfuscatorSeed: devSeed(), dev };
  }
  const releaseSeed = deriveReleaseSeed(rootSecret, skillId, version);
  return { releaseSeed, obfuscatorSeed: seedToUint32(releaseSeed), dev };
}
