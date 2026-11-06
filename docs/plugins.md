# Writing SSF Plugins

Plugins replace policy, never cryptographic primitives. A plugin can decide
*which* license source wins or *how* companion text is shaped, but it cannot
change the algorithms, the key derivation, the protection modes, or the core
claims of a token. Every hook runs fail-closed through the same runner:
a throw, a timeout, or an invalid return denies the operation.

## Shape

A plugin is an object, or a zero-argument factory returning one. TypeScript
authors use `definePlugin` from `@ssf/plugin-api` for full type checking;
plain JavaScript packages export the object directly — both load the same
way.

```ts
import { definePlugin } from "@ssf/plugin-api";

export default definePlugin({
  name: "ssf-plugin-toc",
  apiVersion: 1,
  capabilities: ["fs"],
  enforce: "pre",      // optional: "pre" | "post"
  apply: "prod",       // optional: "dev" | "prod"
  build: {
    transformCompanion: async (context, content) =>
      context.protection === "obfuscated" ? content : content,
  },
  runtime: {
    verifyLicense: async () => {},
  },
});
```

Rules enforced at load, at build, and again at the final scan:

- `name` is lowercase letters, digits, and dashes (1–64 chars). Packages
  distributed on npm use the `ssf-plugin-*` convention; `ssf validate`
  warns on bare package names outside it. Local paths are exempt.
- `apiVersion` must be `1`. Anything else is rejected before the plugin
  runs anywhere.
- `capabilities` is a declaration for review, not a sandbox: a plugin
  that touches the network must claim `"network"`, files `"fs"`,
  environment variables `"env"`. The build summary prints every plugin
  with its capabilities so reviewers see the access at a glance.
- Unknown hooks, unknown fields, and unknown capabilities are rejected.
  There is no hook for algorithms, key derivation, or encryption: those
  do not exist and cannot be added.

## Build hooks

| Hook | Mode | What it may do |
|---|---|---|
| `configResolved` | sequential | Observe the resolved config and workspace dir. |
| `buildStart` / `buildEnd` | sequential | Observe lifecycle stages. |
| `transformSource` | waterfall | Rewrite bundled source text before bundling (scripts included). |
| `transformCompanion` | waterfall | Rewrite protected companion text only; must not change the protection mode. |
| `issueLicense` | waterfall | Add `ext` claims only; cannot change `license_id`, `skills`, `expires_at`, or content keys. |
| `packageReady` | sequential | Read-only view of the finished package metadata. |

Hooks run in `enforce` order (`pre`, default, `post`), filtered by `apply`.
A custom name colliding with a builtin (`codec-default`,
`license-source-env`, `license-source-file`, `key-provider-lease`) is
rejected: the framework defaults always run and cannot be shadowed.

## Runtime hooks

| Hook | Mode | What it may do |
|---|---|---|
| `loadLicense` | first wins | Supply a license key string from a keychain, secret manager, or SSO. |
| `verifyLicense` | all must allow | Extra policy after the core issuance checks; `deny()` or `false` refuses with `PLUGIN_DENIED`. |
| `provideKey` | first wins | Supply key material; the core still verifies it (a wrong key fails closed). |
| `afterRead` | waterfall | Transform protected companion text (for example a watermark). Never applies to scripts. |

Hook contexts carry identity and paths only: publisher, skill id, version,
language, env var *names*, config paths, and the license *view* (ids,
scope, expiry, `ext`). They never carry key material, and the framework
never logs keys. The key loading order is fixed: explicit caller token,
then `loadLicense` sources (customs plus the `license-source-*` builtins),
then `provideKey` providers (customs plus the `key-provider-lease` slot).

Custom runtime hooks apply to direct `SkillRuntime` use. Installed
`dist/` packages embed the builtin runtime plugins by name and resolve
them inside the bundle; unknown embedded names fail the install.

## Watermark builtin (F-92)

`createWatermarkPlugin({ secret })` from `@ssf/plugins` appends a
`[ssf-watermark <license_id>:<fingerprint>]` trailer to every protected
companion read. The fingerprint is an HMAC of the license id, so a leaked
file traces to the issuing license (`issued.jsonl` maps it to the
customer) without letting holders forge marks. Watermarks ride the
`afterRead` waterfall, so they count against read budgets and never touch
scripts or public files. They are tracing and deterrent, not access
control: anyone holding the plaintext can strip the line. Verify a leak
with `extractWatermark(text)` plus `verifyWatermark(text, secret,
licenseId)`.

## Contract tests

Every registered hook must pass its contract test before the plugin is
accepted — at build time, and again at the final scan. Run the same
utilities while developing:

```ts
import { runContractTests, validatePlugin } from "@ssf/plugin-api";

const problems = validatePlugin(plugin);          // [] means the shape is valid
const results = await runContractTests(plugin);   // every entry must pass
```

A plugin whose hook throws, times out, or returns a mistyped value fails
its contract test and is refused with `PLUGIN_ERROR`. The build also
prints each plugin's contract results in its summary.

## Loading and review

List plugin modules in `ssf.config.ts` as relative paths, absolute paths,
or package names. Each module's default export (or `plugin` named export)
is normalized, validated, and contract-tested before any hook runs.

Because plugins run with full process access, every third-party or
workspace-external plugin must pass the review checklist in
`SECURITY.md` (read the source, match `capabilities` to behavior, confirm
the hook allowlist, confirm no protection/algorithm/claims changes, check
the build summary, re-verify on every version bump) before use.
