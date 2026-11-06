# Security Policy

## Supported Versions

Only the latest `0.1.x` prerelease is supported during Sprint 1. Security fixes land on the default branch and are noted in release notes.

## Reporting a Vulnerability

- Email the maintainer listed in `package.json` with: affected version, steps to reproduce, impact, and any proof of concept.
- Do not open a public issue for a suspected vulnerability.
- Expect an acknowledgement within 3 business days and a remediation plan within 14 days.
- Do not disclose the issue publicly until a fix is released and an advisory is published.

## What This Policy Covers

- The framework repository: build tooling, runtime source, container format handling, license verification logic, and CI secret scanning.
- The example workspace uses only `kid: example` keys. Development keys use `kid: dev`. Both are rejected by production runtimes and must never sign production artifacts.

## What Is Out of Scope

- Publisher workspaces, private publisher keys, root secrets, issued license tokens, and distribution repositories are the publisher's responsibility.
- Cracking a single skill on a machine owned by a license holder is out of scope (see threat model). This framework provides license enforcement and deterrence, not absolute confidentiality against the holder.

## Release Process

- Releases are cut from the default branch after `bun run build`, `bun run typecheck`, `bun run test`, and `bun run scan-secrets` all pass.
- Release notes list security-relevant changes, rotated key identifiers (`kid`), and any required publisher actions.
- Verification artifacts (`releases.jsonl` in publisher workspaces) are append-only and must never be rewritten.

## Supply Chain Risk (Third-Party Plugins)

- Third-party plugins run inside the build and runtime trust boundary. A malicious or buggy plugin can weaken protection, leak content, or widen the attack surface.
- Mitigations: plugins are bundled and signed with the artifact, run fail-closed, cannot change cryptographic primitives or core token claims, and must pass contract tests before use.
- Publishers should pin plugin versions, review plugin source, and prefer internal plugins for high-value skills.

### Dependency pinning and integrity

- `bun.lock` is committed at the repo root. CI installs with `bun install --frozen-lockfile`, so a build fails instead of silently resolving new or tampered dependencies.
- Workspace packages pin each other with `workspace:*`; the only third-party runtime/build inputs are the locked registry dependencies. No native dependencies are allowed: everything builds and runs on plain Node.js plus `node:crypto`.

### Plugin review checklist

In MVP only internal plugins ship, but any third-party or workspace-external plugin must pass this review before use, because plugins run with full process access:

1. Read the source end to end; `capabilities` (`network`, `fs`, `env`) must match what the code actually touches.
2. Confirm every hook is on the allowlist (build: `configResolved`, `buildStart`/`buildEnd`, `transformSource`, `transformCompanion`, `issueLicense`, `packageReady`; runtime: `loadLicense`, `verifyLicense`, `provideKey`, `afterRead`).
3. Confirm the plugin cannot change the protection mode, the algorithm set, or core token claims (`license_id`, `skills`, `expires_at`, content keys).
4. Run `ssf build` and check the plugin summary: the plugin appears with its capabilities, and its contract tests pass.
5. Re-verify on every version bump; a lockfile or version change without a matching review is a finding, not a routine update.

## Secret Hygiene

- No private key, root secret, token, or secret of any kind is allowed in this repository.
- Publisher keys live in `keys/` (gitignored) or a secret manager, never in git.
- CI runs secret scanning on every push and pull request and fails the build when a pattern matches.
