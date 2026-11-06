// F-17 tests: Ed25519 artifact signatures.

import { describe, expect, test } from "bun:test";
import { encodeContainer } from "../src/container.js";
import {
  ArtifactSignatureError,
  assertArtifactSignature,
  generateSigningKeypair,
  signArtifact,
  verifyArtifact,
} from "../src/sign.js";

function containerBytes() {
  return encodeContainer("prod-2026", []);
}

describe("artifact signatures", () => {
  test("verifies a fresh signature", () => {
    const { publicKey, privateKey } = generateSigningKeypair();
    const bytes = containerBytes();
    const { kid, signature } = signArtifact(privateKey, bytes, "prod-2026");
    expect(kid).toBe("prod-2026");
    expect(verifyArtifact(publicKey, bytes, signature)).toBe(true);
  });

  test("is deterministic across rebuilds", () => {
    const { privateKey } = generateSigningKeypair();
    const bytes = containerBytes();
    const a = signArtifact(privateKey, bytes, "prod-2026");
    const b = signArtifact(privateKey, bytes, "prod-2026");
    expect(a.signature.equals(b.signature)).toBe(true);
  });

  test("rejects tampered artifacts before decryption", () => {
    const { publicKey, privateKey } = generateSigningKeypair();
    const bytes = containerBytes();
    const { signature } = signArtifact(privateKey, bytes, "prod-2026");
    const tampered = Buffer.from(bytes);
    const last = tampered.length - 1;
    tampered[last] = ((tampered[last] ?? 0) ^ 0x01);
    expect(verifyArtifact(publicKey, tampered, signature)).toBe(false);
    expect(() => assertArtifactSignature(publicKey, tampered, signature)).toThrow(ArtifactSignatureError);
  });

  test("rejects signatures from another key", () => {
    const first = generateSigningKeypair();
    const second = generateSigningKeypair();
    const bytes = containerBytes();
    const { signature } = signArtifact(first.privateKey, bytes, "prod-2026");
    expect(verifyArtifact(second.publicKey, bytes, signature)).toBe(false);
  });
});
