// F-14 tests: deterministic nonces and AAD binding.

import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { deriveContentKey, deriveFileKey, generateRootSecret } from "../src/kdf.js";
import { buildAad, deriveNonce } from "../src/nonce.js";

function fileKey() {
  return deriveFileKey(deriveContentKey(generateRootSecret(), "pdf-helper", "1.0.0"), "references/a.md");
}

describe("deriveNonce", () => {
  test("same content yields the same nonce", () => {
    const key = fileKey();
    const body = Buffer.from("hello world", "utf8");
    expect(deriveNonce(key, body).equals(deriveNonce(key, body))).toBe(true);
    expect(deriveNonce(key, body).length).toBe(12);
  });

  test("different content yields a different nonce", () => {
    const key = fileKey();
    expect(
      deriveNonce(key, Buffer.from("alpha", "utf8")).equals(deriveNonce(key, Buffer.from("beta", "utf8"))),
    ).toBe(false);
  });

  test("never reuses a nonce across many plaintexts on one key", () => {
    const key = fileKey();
    const seen = new Set<string>();
    for (let i = 0; i < 256; i += 1) {
      const nonce = deriveNonce(key, randomBytes(48)).toString("hex");
      expect(seen.has(nonce)).toBe(false);
      seen.add(nonce);
    }
    expect(seen.size).toBe(256);
  });
});

describe("buildAad", () => {
  test("is deterministic and binds every field", () => {
    const a = buildAad("pdf-helper", "1.0.0", "references/a.md");
    expect(a.equals(buildAad("pdf-helper", "1.0.0", "references/a.md"))).toBe(true);
    expect(a.equals(buildAad("other", "1.0.0", "references/a.md"))).toBe(false);
    expect(a.equals(buildAad("pdf-helper", "2.0.0", "references/a.md"))).toBe(false);
    expect(a.equals(buildAad("pdf-helper", "1.0.0", "references/b.md"))).toBe(false);
  });
});
