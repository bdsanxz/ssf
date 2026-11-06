# Distribution: shipping `dist/` from a separate repo

The publisher source repo stays private. Customers install from a separate
distribution repo that carries only built packages. This is the F-85 flow.

## Layout

- Source repo (private): `ssf.config.ts`, `skills/`, `shared/`, `keys/`.
  Never push `keys/` anywhere: it is gitignored and holds the root secret
  plus the private signing keys.
- Distribution repo (public or customer-gated): the content of `dist/`
  after a release build, i.e. `skills/<id>/` packages plus `releases.jsonl`.
  Each package is self-contained and installable on its own.

## Release procedure

1. `ssf validate` — source must be clean.
2. `ssf build --all` (add `--force` only to rebuild a released version;
   without it an unchanged version is byte-identical and a changed version
   is refused, so releases are immutable by default).
3. `ssf validate --dist` — the built packages must be valid.
4. Copy `dist/skills/<id>` (and the updated `releases.jsonl`) into the
   distribution repo, commit, and push. Old version directories stay in
   place: they remain ciphertext without a matching token, and keeping
   them is what makes `npx skills update` work from an older release.
5. Never copy `skills/`, `shared/`, `keys/`, or `ssf.config.ts` into the
   distribution repo. The `skill.manifest` inside a built package is
   already the public-only manifest (no protected paths, descriptions,
   usage text, or scripts section); the final build scan fails the build
   if any of those leak.

## Customer install

```sh
npx skills add <owner>/<repo-distribusi> --skill <id>
```

`SKILL.md` sits at the skill folder root, so discovery (`--list`),
symlink and `--copy` installs, and updates all work with no extra steps
beyond the license key. The same flow is covered in CI against local
`dist/` output (discovery, multi-agent matrix, space paths, updates,
determinism).

## Online mode (revocation via leases)

Offline tokens cannot be revoked before `expires_at`; keep their lifetime
short for high-risk content. Online mode adds revocation at the cost of a
publisher-run verification service:

1. Issue an online token: `ssf license issue --skills <id@ver> --expires
   <date> --mode online`. The token carries no content keys.
2. Run the verification service next to the key material (see
   `services/license-verification/README.md`): it checks the full token,
   reads the revocation list, and mints short-lived leases (1-24h)
   carrying the per-version content key.
3. Point runtimes at the service with `licenseServiceUrl` (or
   `SSF_LICENSE_SERVICE_URL`) plus the lease public key in the runtime
   keys. Only `https` URLs are accepted, except loopback `http` for local
   development and tests. The first access fetches a lease and caches it
   in the user config dir with `0600`; later access reuses the cache with
   no network call. An expired lease plus an unreachable service fails
   closed (`LEASE_EXPIRED` / `NETWORK_UNAVAILABLE`).
4. Revoke with `ssf license revoke <license-id>` (writes `revoked.json`;
   point the service at the same file). Revocation takes effect no later
   than the next lease expiry; a cached lease stays valid until then.

Trade-offs and privacy: a lease on disk contains a content key, so it
does not protect content from the machine owner (same as 18.3). The
service only ever sees the license id, skill, version, and IP; it stores
nothing per request. Offline tokens stay fully local with no server,
network, or telemetry.

## Protected binary assets (F-94)

Companion files need not be text: `encrypted` and `obfuscated` tiers
also accept binary assets (images, models, data files). Binaries are
GCM-sealed as raw bytes at rest, skip text transforms and the tier-1
codec, and are extract-only at read time — `read` and `search` refuse
them with `NOT_READABLE`:

```sh
node scripts/runtime.js extract assets/logo.png --out ./logo.png
```

`extract` serves raw decrypted bytes with no watermark or pagination
(text stages do not apply to bytes). Declare binaries like any other
companion; the final leak scan treats their bytes as opaque secrets.

## Per-customer builds (F-93)

The default cut shares one root secret across every customer: tokens
differ per customer (`--customer`), but the content keys do not. When one
customer must not decrypt another's package even with a leaked token,
build a separate cut with its own root secret:

```sh
ssf build --customer acme-corp --root-secret-file ./keys-acme-corp.hex
ssf license issue --skills demo@1.0.0 --expires 2027-01-01 \
  --customer acme-corp --root-secret-file ./keys-acme-corp.hex
```

The customer cut lands in `dist/customers/acme-corp/skills/<id>/` with its
own `releases.jsonl`, so version immutability never clashes with the
shared cut. A customer token decrypts only its own cut (cross-use fails
closed); the default token cannot open the customer package.

Trade-off with the single public repo (F-85): each customer needs its own
distribution cut. Use per-customer builds only where key separation is
worth the extra distribution channels; everyone else shares the default
cut.

## Old versions and tokens

A token carries content keys per `skill@version`. An old package stays
decryptable only with a token whose scope covers that exact version; a
token for another skill or version is rejected with `LICENSE_SCOPE`.
Tokens expire on their own clock, and dev/example kids are rejected by
production runtimes, so a leaked old package plus an expired or
out-of-scope token opens nothing.

## Exception in this repo

`examples/acme-skills/dist/` is committed only as a CI fixture for the
example job. Real publishers keep `dist/` out of the source repo and
publish it to the distribution repo instead.
