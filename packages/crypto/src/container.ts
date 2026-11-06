// F-16: protected container (scripts/runtime.bin) with CBOR serialization.
// The container holds every protected companion file and every script of one
// skill, plus the index (id/path, kind, sizes, description, usage, notice
// flag, limits), ciphertext blocks, protection metadata, rootKid, and an
// integrity hash. CBOR is only a serialization format, not a security
// mechanism.
//
// F-16b3/F-25: two layouts exist. Format 1 is the fixed legacy layout
// (fixed key order, decoded for backward compatibility). Format 2 derives
// the envelope layout from the release seed: field order is shuffled by a
// seed-driven PRNG, the file carries unpredictable magic prefix bytes, and
// the integrity hash covers the magic plus a canonical (key-sorted)
// encoding so any decoder verifies without knowing the seed. Same seed
// always yields the same bytes; different seeds yield different bytes for
// the same content.

import { createHash, hkdfSync } from "node:crypto";
import { decode, encode } from "cbor-x";

export const CONTAINER_FORMAT = 1;
export const CONTAINER_FORMAT_SEEDED = 2;
/** Unpredictable prefix bytes that start every format-2 container. */
export const CONTAINER_MAGIC_BYTES = 4;

export type ContainerEntryKind = "file" | "script";
export type ContainerProtection = "obfuscated" | "encrypted";

export interface ContainerEntry {
  kind: ContainerEntryKind;
  /** Logical id: companion file logical path or script id. */
  id: string;
  protection: ContainerProtection;
  description?: string;
  usage?: string;
  lines?: number;
  /** F-94: binary companions skip text transforms/codec and are extract-only. */
  binary?: boolean;
  notice: boolean;
  maxLines?: number;
  maxChars?: number;
  /** Script output cap in chars (scripts only). */
  maxOutputChars?: number;
  /** Script timeout in seconds (scripts only). */
  timeoutSeconds?: number;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  tag: Uint8Array;
}

export interface DecodedContainer {
  format: number;
  rootKid: string;
  entries: ContainerEntry[];
}

export interface EncodeContainerOptions {
  /**
   * Release seed for the format-2 layout (field order + magic derived via
   * HKDF). Omit for the fixed format-1 layout.
   */
  seed?: Uint8Array;
}

/** Derive the unpredictable prefix bytes for one release. */
export function deriveContainerMagic(seed: Uint8Array): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(seed), Buffer.alloc(0), "ssf/magic", CONTAINER_MAGIC_BYTES));
}

/** 32-bit PRNG for seed-driven field shuffling (layout only, never keys). */
function layoutRandom(seed: Uint8Array): () => number {
  const key = Buffer.from(hkdfSync("sha256", Buffer.from(seed), Buffer.alloc(0), "ssf/layout", 4));
  let state = key.readUInt32BE(0);
  if (state === 0) {
    state = 0x9e3779b9;
  }
  return () => {
    state ^= (state << 13) >>> 0;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= (state << 5) >>> 0;
    state >>>= 0;
    return state / 0x100000000;
  };
}

/** Rebuild an object with its keys in seed-shuffled order (arrays keep order). */
function reorderValue(value: unknown, rand: () => number): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => reorderValue(entry, rand));
  }
  if (value !== null && typeof value === "object" && !(value instanceof Uint8Array)) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    for (let i = keys.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const current = keys[i] as string;
      keys[i] = keys[j] as string;
      keys[j] = current;
    }
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      out[key] = reorderValue(record[key], rand);
    }
    return out;
  }
  return value;
}

/** Canonical form for the integrity hash: object keys sorted, arrays kept. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object" && !(value instanceof Uint8Array)) {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      out[key] = canonicalize(record[key]);
    }
    return out;
  }
  return value;
}

export class ContainerIntegrityError extends Error {
  constructor(message = "Container integrity check failed.") {
    super(message);
    this.name = "ContainerIntegrityError";
  }
}

/**
 * Remove undefined-valued keys. The CBOR encoder cannot represent
 * undefined, so optional entry fields are omitted instead of encoded.
 */
function clean<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(clean) as T;
  }
  if (value !== null && typeof value === "object" && !Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry !== undefined) {
        out[key] = clean(entry);
      }
    }
    return out as T;
  }
  return value;
}

/**
 * Serialize entries plus rootKid into runtime.bin bytes. Without a seed
 * the fixed format-1 layout is used; with a seed the format-2 layout is
 * used (shuffled field order, magic prefix, canonical integrity hash).
 */
export function encodeContainer(rootKid: string, entries: ContainerEntry[], options: EncodeContainerOptions = {}): Buffer {
  if (options.seed === undefined) {
    const encodedEntries = Buffer.from(encode(clean(entries)));
    const integrity = createHash("sha256").update(encodedEntries).digest();
    return Buffer.from(encode({ format: CONTAINER_FORMAT, rootKid, entries: clean(entries), integrity }));
  }
  const rand = layoutRandom(options.seed);
  const body = { format: CONTAINER_FORMAT_SEEDED, rootKid, entries: clean(entries) };
  const magic = deriveContainerMagic(options.seed);
  // The integrity hash covers the magic prefix too, so a swapped or edited
  // prefix fails exactly like edited content: no seed needed to verify.
  const integrity = createHash("sha256")
    .update(Buffer.concat([magic, Buffer.from(encode(canonicalize(body)))]))
    .digest();
  const envelope = reorderValue({ ...body, integrity }, rand);
  return Buffer.concat([magic, Buffer.from(encode(envelope))]);
}

function checkIntegrity(expected: Buffer, actual: Uint8Array | undefined): void {
  const seen = Buffer.from(actual ?? Buffer.alloc(0));
  if (seen.length !== expected.length || !expected.equals(seen)) {
    throw new ContainerIntegrityError();
  }
}

/** Parse and integrity-check runtime.bin bytes. Throws on any modification. */
export function decodeContainer(bytes: Uint8Array): DecodedContainer {
  const input = Buffer.from(bytes);
  if (input.length > CONTAINER_MAGIC_BYTES) {
    try {
      const outer = decode(input.subarray(CONTAINER_MAGIC_BYTES)) as {
        format: number;
        rootKid: string;
        entries: ContainerEntry[];
        integrity: Uint8Array;
      };
      if (outer && outer.format === CONTAINER_FORMAT_SEEDED && typeof outer.rootKid === "string" && Array.isArray(outer.entries)) {
        const body = { format: outer.format, rootKid: outer.rootKid, entries: outer.entries };
        const expected = createHash("sha256")
          .update(Buffer.concat([input.subarray(0, CONTAINER_MAGIC_BYTES), Buffer.from(encode(canonicalize(body)))]))
          .digest();
        checkIntegrity(expected, outer.integrity);
        return { format: outer.format, rootKid: outer.rootKid, entries: outer.entries as ContainerEntry[] };
      }
    } catch (error) {
      if (error instanceof ContainerIntegrityError) {
        throw error;
      }
      // Not a format-2 container: fall through to the legacy layout.
    }
  }
  let outer: { format: number; rootKid: string; entries: ContainerEntry[]; integrity: Uint8Array };
  try {
    outer = decode(input) as typeof outer;
  } catch {
    throw new ContainerIntegrityError("Container is not valid CBOR.");
  }
  if (!outer || outer.format !== CONTAINER_FORMAT || typeof outer.rootKid !== "string" || !Array.isArray(outer.entries)) {
    throw new ContainerIntegrityError("Container has an unsupported layout.");
  }
  const expected = createHash("sha256").update(Buffer.from(encode(clean(outer.entries)))).digest();
  checkIntegrity(expected, outer.integrity);
  return { format: outer.format, rootKid: outer.rootKid, entries: outer.entries };
}
