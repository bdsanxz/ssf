// F-16 tests: container packing, determinism, and tamper rejection.

import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  CONTAINER_FORMAT,
  CONTAINER_FORMAT_SEEDED,
  CONTAINER_MAGIC_BYTES,
  ContainerIntegrityError,
  decodeContainer,
  deriveContainerMagic,
  encodeContainer,
  type ContainerEntry,
} from "../src/container.js";

const SEED_A = randomBytes(32);
const SEED_B = randomBytes(32);

function entries(): ContainerEntry[] {
  return [
    {
      kind: "file",
      id: "references/a.md",
      protection: "encrypted",
      description: "Example file",
      notice: true,
      maxLines: 500,
      nonce: Buffer.from("0123456789ab", "utf8"),
      ciphertext: Buffer.from("ciphertext-a"),
      tag: Buffer.from("0123456789abcdef", "utf8"),
    },
    {
      kind: "script",
      id: "extract-table",
      protection: "encrypted",
      description: "Extract tables",
      usage: "<file.pdf>",
      notice: false,
      nonce: Buffer.from("abcdef012345", "utf8"),
      ciphertext: Buffer.from("ciphertext-b"),
      tag: Buffer.from("fedcba9876543210", "utf8"),
    },
  ];
}

describe("container", () => {
  test("round-trips the index and rootKid", () => {
    const bytes = encodeContainer("prod-2026", entries());
    const decoded = decodeContainer(bytes);
    expect(decoded.rootKid).toBe("prod-2026");
    expect(decoded.entries.map((e) => e.id)).toEqual(["references/a.md", "extract-table"]);
    expect(decoded.entries[1]?.usage).toBe("<file.pdf>");
  });

  test("encodes deterministically", () => {
    expect(encodeContainer("prod-2026", entries()).equals(encodeContainer("prod-2026", entries()))).toBe(true);
  });

  test("rejects any flipped byte", () => {
    const bytes = encodeContainer("prod-2026", entries());
    const tampered = Buffer.from(bytes);
    const middle = Math.floor(tampered.length / 2);
    tampered[middle] = ((tampered[middle] ?? 0) ^ 0x01);
    expect(() => decodeContainer(tampered)).toThrow(ContainerIntegrityError);
  });

  test("rejects truncated and non-CBOR input", () => {
    const bytes = encodeContainer("prod-2026", entries());
    expect(() => decodeContainer(bytes.subarray(0, 8))).toThrow(ContainerIntegrityError);
    expect(() => decodeContainer(Buffer.from("not a container", "utf8"))).toThrow(ContainerIntegrityError);
  });
});

describe("seeded container layout (F-16b3)", () => {
  test("round-trips with format 2 and the seed magic prefix", () => {
    const bytes = encodeContainer("prod-2026", entries(), { seed: SEED_A });
    expect(bytes.subarray(0, CONTAINER_MAGIC_BYTES).equals(deriveContainerMagic(SEED_A))).toBe(true);
    const decoded = decodeContainer(bytes);
    expect(decoded.format).toBe(CONTAINER_FORMAT_SEEDED);
    expect(decoded.rootKid).toBe("prod-2026");
    expect(decoded.entries.map((entry) => entry.id)).toEqual(["references/a.md", "extract-table"]);
    expect(decoded.entries[1]?.usage).toBe("<file.pdf>");
  });

  test("same seed is byte-identical; different seeds rearrange the bytes", () => {
    const first = encodeContainer("prod-2026", entries(), { seed: SEED_A });
    expect(encodeContainer("prod-2026", entries(), { seed: SEED_A }).equals(first)).toBe(true);
    const other = encodeContainer("prod-2026", entries(), { seed: SEED_B });
    expect(other.equals(first)).toBe(false);
    expect(decodeContainer(other).format).toBe(CONTAINER_FORMAT_SEEDED);
  });

  test("seedless encoding stays on the fixed format 1", () => {
    expect(decodeContainer(encodeContainer("prod-2026", entries())).format).toBe(CONTAINER_FORMAT);
  });

  test("rejects flipped bytes and swapped magic", () => {
    const bytes = encodeContainer("prod-2026", entries(), { seed: SEED_A });
    const tampered = Buffer.from(bytes);
    const middle = Math.floor(tampered.length / 2);
    tampered[middle] = ((tampered[middle] ?? 0) ^ 0x01);
    expect(() => decodeContainer(tampered)).toThrow(ContainerIntegrityError);
    const swapped = Buffer.from(bytes);
    deriveContainerMagic(SEED_B).copy(swapped, 0);
    expect(() => decodeContainer(swapped)).toThrow(ContainerIntegrityError);
  });
});
