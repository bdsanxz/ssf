# @ssf/crypto

Cryptographic core for Sprint 2 (F-13 through F-20). Only `node:crypto`
primitives plus CBOR serialization and JS obfuscation. No custom
cryptography and no native dependencies.

## Key schedule (F-13)

- Publisher root secret: 256 random bits with a `kid`, stored in `keys/`
  or a secret manager. Treat it like a private key: a leak opens every
  skill version derived from it.
- `content_key = HKDF(root_secret, "ssf/content-key" || skill_id || version)`
- `file_key = HKDF(content_key, "ssf/file-key" || logical_id)`
- Content keys are never stored in packages.

## Nonce and AAD (F-14)

- Nonce: first 12 bytes of `HKDF(file_key, "ssf/nonce" || SHA-256(plaintext))`.
- AAD binds `skill_id`, `version`, and `logical_id` with length-prefixed
  fields, so blocks cannot be swapped across files or versions.

## Encryption (F-15)

- Fixed `aes-256-gcm` from `node:crypto`. Not replaceable by plugins.

## Container (F-16)

- `encodeContainer` packs the index, ciphertext blocks, protection
  metadata, `rootKid`, and a SHA-256 integrity hash with canonical CBOR.
- `decodeContainer` rejects any modification before decryption material
  is used. Layout diversification by release seed arrives with F-25.

## Signatures (F-17)

- Ed25519 over the whole container, deterministic per release. Verify
  before decrypting. Signatures prove integrity and publisher origin,
  never confidentiality; the runtime is the trust anchor.

## Obfuscation (F-18)

- `javascript-obfuscator` with the release seed for scripts and runtime.
- Tier-1 text is base64 with an `ssf1:` prefix: reversible by anyone,
  a deterrent for casual reading only. Obfuscation is never a boundary.

## Key separation (F-19)

| Purpose        | Algorithm    | Secret held back | Ships in package |
| -------------- | ------------ | ---------------- | ---------------- |
| license-sign   | Ed25519      | private key      | public key only  |
| artifact-sign  | Ed25519      | private key      | public key only  |
| lease-sign     | Ed25519      | private key      | public key only  |
| content-root   | HKDF-SHA-256 | root secret      | nothing          |

Every key carries a `kid`; rotation mints a new `kid`.

## Test kids (F-20)

- `dev` and `example` kids are rejected in production with
  `LICENSE_DEV_KEY`. Dev runtimes may accept `dev` with a warning.
