# License Verification Service (F-95)

Online-mode verification service for publishers. It verifies the full
online token (signature, scope, expiry), checks the revocation list
(F-42), and mints short-lived signed leases carrying the per-version
content key (F-41).

## Contract

```http
POST /v1/licenses/verify
Content-Type: application/json

{ "token": "ssf1....", "skill_id": "pdf-helper", "skill_version": "1.0.0" }
```

Active response (`200`):

```json
{ "valid": true, "status": "active", "lease": "<signed-lease>" }
```

Revoked response (`403`):

```json
{ "valid": false, "status": "revoked", "error": "LICENSE_REVOKED" }
```

Denied response (`400`/`403`):

```json
{ "valid": false, "status": "denied", "error": "<code>" }
```

## Running

Keep the key material next to the service, never in the repo.
Provision keys with `ssf keys generate --kid <kid>` (mints
`<kid>.lease.pem` / `<kid>.lease.pub.pem` alongside the other keys;
older key dirs backfill with `ssf keys lease --kid <kid>`). Copy the
lease private PEM and root secret to the service host:

```sh
SSF_LICENSE_PORT=8443 \
SSF_LICENSE_PUBLIC_KEY_FILE=/secure/license.pub.pem \
SSF_LEASE_PRIVATE_KEY_FILE=/secure/lease.pem \
SSF_LEASE_KID=prod-2026 \
SSF_ROOT_SECRET_FILE=/secure/root.hex \
SSF_REVOCATIONS_FILE=/secure/revoked.json \
SSF_LEASE_TTL_SECONDS=21600 \
bun services/license-verification/src/serve.ts
```

Terminate TLS in front (reverse proxy with optional certificate
pinning). The handler only accepts `POST /v1/licenses/verify`; request
bodies over 64 KiB are refused.

## Revocation list

A JSON document in private or object storage:

```json
{ "updated_at": 1793923200, "revoked": ["lic_123"] }
```

Publishers append with `ssf license revoke <license-id>` (F-42). The
service caches the file for `revocationTtlSeconds` (default 60s).
Revocation takes effect no later than the next lease expiry.

## Privacy

The service only ever sees the license id, skill, version, and IP. It
stores nothing per request and never logs tokens, leases, or keys.
Leases on disk contain a content key: they do not protect content from
the machine owner.
