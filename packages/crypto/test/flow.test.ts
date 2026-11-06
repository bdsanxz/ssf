// End-to-end flow: derive, seal, pack, sign, verify, unpack, open.
// Also proves cross-file block swaps are rejected (F-91 direction).

import { describe, expect, test } from "bun:test";
import { open, seal } from "../src/aead.js";
import { decodeContainer, encodeContainer, type ContainerEntry } from "../src/container.js";
import { deriveContentKey, deriveFileKey, generateRootSecret } from "../src/kdf.js";
import { buildAad, deriveNonce } from "../src/nonce.js";
import { assertArtifactSignature, generateSigningKeypair, signArtifact, verifyArtifact } from "../src/sign.js";

function protect(
  contentKey: Buffer,
  skillId: string,
  version: string,
  logicalId: string,
  text: string,
): ContainerEntry {
  const fileKey = deriveFileKey(contentKey, logicalId);
  const plaintext = Buffer.from(text, "utf8");
  const aad = buildAad(skillId, version, logicalId);
  const nonce = deriveNonce(fileKey, plaintext);
  const block = seal(fileKey, nonce, plaintext, aad);
  return {
    kind: "file",
    id: logicalId,
    protection: "encrypted",
    description: logicalId,
    notice: true,
    nonce: block.nonce,
    ciphertext: block.ciphertext,
    tag: block.tag,
  };
}

describe("protect round trip", () => {
  test("packs, signs, verifies, unpacks, and decrypts", () => {
    const root = generateRootSecret();
    const rootKid = "prod-2026";
    const contentKey = deriveContentKey(root, "pdf-helper", "1.0.0");
    const entry = protect(contentKey, "pdf-helper", "1.0.0", "references/a.md", "secret know-how");
    const bytes = encodeContainer(rootKid, [entry]);
    const { publicKey, privateKey } = generateSigningKeypair();
    const { signature } = signArtifact(privateKey, bytes, rootKid);

    // Runtime order: verify signature BEFORE decryption.
    expect(verifyArtifact(publicKey, bytes, signature)).toBe(true);
    assertArtifactSignature(publicKey, bytes, signature);
    const decoded = decodeContainer(bytes);
    const stored = decoded.entries[0];
    if (!stored) throw new Error("Entry missing after decode.");
    const fileKey = deriveFileKey(deriveContentKey(root, "pdf-helper", "1.0.0"), "references/a.md");
    const aad = buildAad("pdf-helper", "1.0.0", "references/a.md");
    expect(open(fileKey, stored.nonce, stored.ciphertext, stored.tag, aad).toString("utf8")).toBe("secret know-how");
  });

  test("rejects a block swapped from another file", () => {
    const root = generateRootSecret();
    const contentKey = deriveContentKey(root, "pdf-helper", "1.0.0");
    const entry = protect(contentKey, "pdf-helper", "1.0.0", "references/a.md", "secret know-how");
    const bytes = encodeContainer("prod-2026", [entry]);
    const decoded = decodeContainer(bytes);
    const stored = decoded.entries[0];
    if (!stored) throw new Error("Entry missing after decode.");
    const fileKey = deriveFileKey(contentKey, "references/b.md");
    const wrongAad = buildAad("pdf-helper", "1.0.0", "references/b.md");
    expect(() => open(fileKey, stored.nonce, stored.ciphertext, stored.tag, wrongAad)).toThrow();
  });
});
