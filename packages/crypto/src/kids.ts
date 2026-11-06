// F-20: rejection of dev and example kids in production.
// Test material uses kid "dev" (local keys) or "example" (shipped example
// workspace). Production runtimes embed only production public keys and must
// reject both test kids with LICENSE_DEV_KEY before any further checks.
// Dev runtimes may accept the dev kid with a clear warning; that behavior
// lives in the runtime (F-54), not here.

export const DEV_KID = "dev";
export const EXAMPLE_KID = "example";

/** License error code used when test material reaches production. */
export const LICENSE_DEV_KEY = "LICENSE_DEV_KEY" as const;

export class LicenseKeyError extends Error {
  readonly code: typeof LICENSE_DEV_KEY = LICENSE_DEV_KEY;

  constructor(kid: string) {
    super(`Test key material (kid "${kid}") is rejected in production.`);
    this.name = "LicenseKeyError";
  }
}

/** True for kids that must never validate in production. */
export function isTestKid(kid: string): boolean {
  return kid === DEV_KID || kid === EXAMPLE_KID;
}

/** Throw LicenseKeyError (code LICENSE_DEV_KEY) for dev/example kids. */
export function assertProductionKid(kid: string): void {
  if (isTestKid(kid)) {
    throw new LicenseKeyError(kid);
  }
}
