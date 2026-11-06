# Authoring Guide: Progressive Disclosure for Agents

`SKILL.md` is the agent's entry point: it is always loaded into context, so
keep it short and push detail into companion files. This guide implements the
progressive-disclosure rules; `ssf validate` warns when a skill breaks them.

## Rules

1. **Keep `SKILL.md` short.** Put details in companion files, never in the
   main instruction file. Warns above 300 lines, fails above 500 lines.
2. **Split large resources.** Break big topics into several files with
   specific `description` text each, so the agent can pick the right file
   from `list` without opening everything. Warns when a file has more than
   500 lines without a search hint in `SKILL.md`.
3. **Write full `usage` for every script.** The agent cannot read script
   source, so `description` plus `usage` is the only thing it knows about a
   script. Missing `description` or `usage` is an error, not a warning.
4. **Prefer `search` before `read`.** Tell the agent to search first, then
   read only the relevant file. The generated `ssf` block says this for you.
5. **Never link to protected files or scripts with relative paths.** The
   agent reaches them through `list`, `read`, and `run`, not through file
   links. Relative links in `SKILL.md` must point at real files that exist
   in the package.
6. **Every protected text file needs a `description`.** Otherwise the agent
   cannot tell whether the file is relevant without opening it.

## What `ssf validate` checks

| Check | Severity |
|---|---|
| Script without `description` or `usage` | Error |
| Protected text file without `description` | Warning |
| File over 500 lines without a search hint in `SKILL.md` | Warning |
| `SKILL.md` over 300 lines (over 500 lines) | Warning (error) |
| Relative link in `SKILL.md` with no matching real file | Warning |

## Confidentiality notice (soft control)

Protected `read` and `search` output carries a confidentiality notice, and
the generated `ssf` block repeats the main rule. This reduces casual leaks
through conversation, but it is not a security boundary: a license holder
can run the runtime directly, tool output appears in transcripts and logs,
and some harnesses treat tool output as plain data. Never place truly
secret content in companion files or local scripts; use remote mode for
that (tier 3).
