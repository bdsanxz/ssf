# Docs App (Kryon)

SSF documentation site built with Fumadocs (Next.js + Bun).

- `src/` - site source (routes, layout, MDX components).
- `content/docs/` - documentation content (Overview, Getting Started,
  Guides, Agent Contract, Security, Reference, Roadmap).
- `public/` - static assets.

## Commands (run from `ssf/` root via turbo, or here directly)

- `bun run dev` - documentation dev server.
- `bun run build` - production build.
- `bun run typecheck` - Next.js type generation plus `tsc --noEmit`.

All content is English. Feature status follows `ROADMAP.md`: nothing is
marked available until QA (Gryon) verifies it.
