// F-15 tests: AES-256-GCM round trip, determinism, and tamper rejection.

import { describe, expect, test } from "bun:test";
import { deriveContentKey, deriveFileKey, generateRootSecret } from "../src/kdf.js";
import { buildAad, deriveNonce } from "../src/nonce.js";
import { DecryptionError, open, seal } from "../src/aead.js";

function setup() {
  const fileKey = deriveFileKey(deriveContentKey(generateRootSecret(), "pdf-helper", "1.0.0"), "references/a.md");
  const plaintext = Buffer.from("protected content", "utf8");
  const aad = buildAad("pdf-helper", "1.0.0", "references/a.md");
  const nonce = deriveNonce(fileKey, plaintext);
  return { fileKey, plaintext, aad, nonce };
}

describe("seal/open", () => {
  test("round-trips authenticated content", () => {
    const { fileKey, plaintext, aad, nonce } = setup();
    const block = seal(fileKey, nonce, plaintext, aad);
    expect(open(fileKey, block.nonce, block.ciphertext, block.tag, aad).toString("utf8")).toBe("protected content");
  });

  test("is deterministic for the same inputs", () => {
    const { fileKey, plaintext, aad, nonce } = setup();
    const a = seal(fileKey, nonce, plaintext, aad);
    const b = seal(fileKey, nonce, plaintext, aad);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(true);
    expect(a.tag.equals(b.tag)).toBe(true);
  });

  test("rejects swapped AAD across files and versions", () => {
    const { fileKey, plaintext, aad, nonce } = setup();
    const block = seal(fileKey, nonce, plaintext, aad);
    const otherFile = buildAad("pdf-helper", "1.0.0", "references/b.md");
    const otherVersion = buildAad("pdf-helper", "2.0.0", "references/a.md");
    expect(() => open(fileKey, block.nonce, block.ciphertext, block.tag, otherFile)).toThrow(DecryptionError);
    expect(() => open(fileKey, block.nonce, block.ciphertext, block.tag, otherVersion)).toThrow(DecryptionError);
  });

  test("rejects tampered ciphertext, tag, nonce, and wrong keys", () => {
    const { fileKey, plaintext, aad, nonce } = setup();
    const block = seal(fileKey, nonce, plaintext, aad);
    const flipped = Buffer.from(block.ciphertext);
    flipped[0] = ((flipped[0] ?? 0) ^ 0xff);
    expect(() => open(fileKey, block.nonce, flipped, block.tag, aad)).toThrow(DecryptionError);
    const badTag = Buffer.from(block.tag);
    badTag[0] = ((badTag[0] ?? 0) ^ 0x01);
    expect(() => open(fileKey, block.nonce, block.ciphertext, badTag, aad)).toThrow(DecryptionError);
    const badNonce = Buffer.from(block.nonce);
    badNonce[0] = ((badNonce[0] ?? 0) ^ 0x01);
    expect(() => open(fileKey, badNonce, block.ciphertext, block.tag, aad)).toThrow(DecryptionError);
    const otherKey = deriveFileKey(
      deriveContentKey(generateRootSecret(), "pdf-helper", "1.0.0"),
      "references/a.md",
    );
    expect(() => open(otherKey, block.nonce, block.ciphertext, block.tag, aad)).toThrow(DecryptionError);
  });
});
