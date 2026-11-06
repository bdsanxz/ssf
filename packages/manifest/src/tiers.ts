// F-12: protection tiers for companion files (MVP tiers 0-2, F-94 binaries).
// Tier 0 "none" ships the file as plaintext. Tier 1 "obfuscated" only hides
// content from casual reading. Tier 2 "encrypted" seals the file with
// AES-256-GCM for readers without a license. Tiers 1 and 2 apply to UTF-8
// text and (F-94) to binary assets, which are always GCM-sealed at rest,
// skip text transforms and the tier-1 codec, and read back only through
// the extract command. Tier 3 "remote" (logic runs on the publisher
// server) is post-MVP and is rejected here with a pointer to remote mode.

import type { Protection } from "./types.js";

export const MVP_TIERS: Protection[] = ["none", "obfuscated", "encrypted"];

export class TierError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TierError";
  }
}

/** Normalize a tier value; unknown tiers (including remote) are rejected. */
export function normalizeProtectionTier(value: unknown, path: string): Protection {
  const tier = (value ?? "none") as string;
  if (tier === "remote") {
    throw new TierError(
      `remote protection is post-MVP and not supported in this release: ${path}. ` +
        `Keep truly secret logic on the publisher server instead of shipping it.`,
    );
  }
  if (tier !== "none" && tier !== "obfuscated" && tier !== "encrypted") {
    throw new TierError(`Unknown protection tier "${tier}": ${path}. Use none, obfuscated, or encrypted.`);
  }
  return tier;
}

/** True when every byte sequence is valid UTF-8 text. */
export function isUtf8Text(content: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(content);
    return true;
  } catch {
    return false;
  }
}

/**
 * Enforce the tier rule (F-94): text runs under every tier, and binary
 * assets run under protected tiers. Binary entries are GCM-sealed at rest
 * and extract-only at read time; text transforms and the tier-1 codec
 * never see raw binary bytes.
 */
export function assertTierAllowsContent(protection: Protection, content: Uint8Array, path: string): void {
  if (protection === "none" || isUtf8Text(content)) {
    return;
  }
  if (protection !== "obfuscated" && protection !== "encrypted") {
    throw new TierError(`Binary asset "${path}" needs a protected tier: use obfuscated or encrypted.`);
  }
}

/** True for tiers that hide content from unlicensed readers. */
export function isProtectedTier(protection: Protection): boolean {
  return protection !== "none";
}
