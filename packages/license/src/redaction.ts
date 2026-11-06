// F-44: license key protection helpers.
// Tokens are bearer secrets: the payload is only signed, never encrypted, so
// anyone holding a token can extract its content keys. The runtime therefore
// never prints keys, leases, or tokens; errors and logs pass through
// redaction first. Publisher private keys and root secrets stay outside the
// repo and are readable only by admin and CI environments.

export const REDACTED = "[REDACTED]";

/** Replace every occurrence of each secret with [REDACTED]. */
export function redactSecrets(text: string, secrets: Array<string | null | undefined>): string {
  let out = text;
  const ordered = secrets.filter((secret): secret is string => typeof secret === "string" && secret.length >= 8);
  ordered.sort((a, b) => b.length - a.length);
  for (const secret of ordered) {
    out = out.split(secret).join(REDACTED);
  }
  return out;
}
