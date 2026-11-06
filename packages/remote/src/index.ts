// @ssf/remote - thin-client tooling for remote mode (tier 3, F-43).
// Scripts on the customer machine forward inputs plus the license key to
// the publisher server; the server re-verifies the token per call and
// decides the result. This is the only way to keep secret logic off the
// customer machine (proposal 6, 14.5).

export { assertHttpsEndpoint, createRemoteClient, RemoteError } from "./client.js";
export type { RemoteClientOptions, RemoteFailureCode, RemoteResult } from "./client.js";
export { authorizeRemoteCall, bearerToken } from "./server.js";
export type { RemoteCallAuth } from "./server.js";

export const PACKAGE_NAME = "@ssf/remote";
