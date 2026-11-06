# Secure Skill Framework

Open source framework for building, protecting, distributing, and running AI agent skills.

## Status

Sprint 1 foundation only. Crypto, build pipeline, runtime, and license flows arrive in later sprints per [proposal](mvp/proposal.md) and [roadmap](ROADMAP.md).

## Layout

- `packages/` - framework packages (`runtime`, `build`, `manifest`, `license`, `crypto`, `cli`, `agent-contract`, `skills-compat`, `plugin-api`, `plugins`, `templates`)
- `apps/docs` - documentation site skeleton (owned by Kryon)
- `examples/acme-skills` - example multi-skill publisher workspace
- `docs/` - publisher guides
- `services/license-verification` - online verification service skeleton (post-MVP)
- `qa/` - QA plans and reports (owned by Gryon)
- `scripts/` - repo tooling including secret scanning
- `mvp/` - frozen proposal documents

## Commands

- `bun install` - install dependencies
- `bun run build` - build all packages
- `bun run typecheck` - typecheck all packages
- `bun run test` - run all tests
- `bun run scan-secrets` - run local secret scan

## Rules

- All codebase text pushed to remote must be English (code, comments, repo docs, commits).
- No private key, root secret, token, or secret of any kind in this repo.
- Publisher source skills stay in private publisher workspaces, never in this framework repo.
