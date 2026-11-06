# Acme Skills (example publisher workspace)

Example multi-skill workspace used for Sprint 1 foundation checks (F-04).
Publisher source stays private; this example ships with the framework repo
using only `kid: example` keys that production runtimes reject.

Layout:
- `ssf.config.ts` - workspace config (F-05)
- `skills/pdf-helper` - first example skill
- `skills/report-writer` - second example skill
- `shared/lib` - shared code included only when declared
- `keys/` - gitignored; holds publisher keys (never committed)
- `issued.jsonl`, `releases.jsonl` - append-only logs
- `dist/skills/` - build output (F-30, later sprint)
