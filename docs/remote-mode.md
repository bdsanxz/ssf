# Remote mode: keeping secret logic off the customer machine

Offline and online modes ship sealed content to the customer machine, so a
determined owner can always read what runs there (see 18.3). Remote mode
(tier 3) is the only way to keep an implementation truly secret: the skill
ships a thin client, and the secret logic runs on the publisher server,
which decides every result from the license.

## Thin-client pattern

```ts
// src/classify.ts (thin client: no secret logic, safe to ship)
import { createRemoteClient } from "@ssf/remote";

const client = createRemoteClient({
  endpoint: "https://api.publisher.example/skills/pdf-helper",
  getToken: () => process.env["ACME_SSF_LICENSE"] ?? "",
});

export async function run(input: { text: string }): Promise<void> {
  const verdict = await client.call("classify", input);
  console.log(JSON.stringify(verdict));
}
```

Scripts run as child processes with full user rights, so `fetch` is
available; `@ssf/remote` bundles into skill scripts with the normal build.
The client only forwards inputs plus the license key and returns the
server decision. It enforces HTTPS (loopback HTTP is allowed for local
development and tests), aborts past the timeout, caps response sizes, and
never includes the token in error messages.

## Server side

Re-verify the full token on every call and decide from the verified
payload. Never trust client claims:

```ts
import { authorizeRemoteCall } from "@ssf/remote";

const payload = authorizeRemoteCall({
  authorization: request.headers["authorization"],
  licensePublicKey,
  skillId: "pdf-helper",
  version: "1.0.0", // omit when the server negotiates versions itself
});
// payload.license_id, payload.skills, payload.ext carry the decision facts.
```

## Hardening checklist

- HTTPS only, no HTTP fallback; consider certificate pinning for high risk.
- Re-verify signature, scope, and expiry per call; expired tokens fail
  closed like everywhere else.
- Time out Hung calls on both ends; cap request and response sizes.
- Never log tokens, request bodies, or decisions tied to a license id.
- Keep responses least-privilege: return the decision, not the reason,
  and never echo key material.
- Revocation is the service's own check (deny-list or short token
  lifetimes); a stolen token works until the server says otherwise.
- Rate-limit per license id; treat the endpoint as a public login form.
