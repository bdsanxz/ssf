// F-95: online license verification service.
// Publishers run this next to their key material. It verifies the full
// token (signature, scope, expiry), checks the revocation list, and mints
// short-lived leases carrying per-version content keys. Runtimes call
// POST /v1/licenses/verify over HTTPS; see README for deployment.

export { createRevocationReader, verifyOnlineRequest } from "./service.js";
export type { OnlineVerifyRequest, OnlineVerifyResponse, ServiceDeps } from "./service.js";
export { createLicenseHandler, serviceDepsFromEnv, startLicenseService } from "./server.js";
export type { EnvServiceConfig } from "./server.js";
