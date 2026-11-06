# @ssf/runtime

Skill runtime: fail-closed license checks, protected content access, and
in-memory script execution (Sprint 5: F-26, F-45–F-56).

## Flow (F-45)

Every protected command runs the same sequence: load the license key
(env var first, then the user config file) → verify signature, kid,
expiry, and scope fully offline → load the container → verify the
artifact signature **before** decrypting → decrypt per-file keys →
serve. No cached "authorized" flag exists: each command re-verifies, so
bypassing one checkpoint never opens the others (F-26). Public files
serve without any license and keep working after license errors (F-56).

## Commands (F-46–F-52)

- `list [path] [--scripts]` — public files always; protected files and
  scripts only with a license (F-48).
- `read <path> [--start N] [--limit N]` — paged reads, at most 500
  lines per call, with `next_start` (F-49, F-52).
- `search <path> "<query>" [--max-results N]` — per-file hits as
  `L<line> <snippet>`, max 20 results by default (F-50, F-52).
- `run <id> [-- <args>]` — registered scripts only, by id; sources and
  entry paths never print (F-51).

Protected read/search output carries a confidentiality notice header
unless disabled. Script output is capped with a follow-up hint; text is
cut on code-point boundaries, never inside surrogate pairs.

## Execution (F-53)

Scripts run from memory: decrypted code is piped to a child Node
process over stdin, never written to disk, with a timeout that kills the
process (SCRIPT_TIMEOUT) and capped output. Debug and loader flags are
stripped from script arguments, and error traces shrink to kind plus
message. Scripts run with full user rights: this is not a sandbox, and
trust rests on the artifact signature.

## Artifacts and state (F-54, F-55)

`scripts/runtime.bin` is integrity-checked and signature-verified before
any decryption; the runtime file itself resolves the container path, so
installs work from any working directory. State (leases, last_seen)
lives in the user config dir keyed by publisher/skill-id; the skill
folder is never written to. Clock rollback past `last_seen` raises a
warning callback (best effort).

## Errors

`ERROR <CODE>` plus one short line plus an agent instruction. License
and artifact failures name LICENSE_*/ARTIFACT_INVALID with exit codes
2 and 3; unknown paths and script reads are PATH_NOT_FOUND (4);
timeouts are SCRIPT_TIMEOUT (7). Keys, tokens, and sources never appear
in errors: secrets are redacted first.
