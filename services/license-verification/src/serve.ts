// Deployment entry point: bun services/license-verification/src/serve.ts
// with SSF_LICENSE_PUBLIC_KEY_FILE, SSF_LEASE_PRIVATE_KEY_FILE,
// SSF_ROOT_SECRET_FILE, SSF_REVOCATIONS_FILE, SSF_LEASE_KID, and
// SSF_LICENSE_PORT set. Terminate TLS in front (reverse proxy); the
// handler only accepts POST /v1/licenses/verify.

import { createServer } from "node:http";
import { createLicenseHandler, serviceDepsFromEnv } from "./server.js";

const deps = serviceDepsFromEnv();
const server = createServer(createLicenseHandler(deps));
server.listen(deps.port, "127.0.0.1", () => {
  console.log(`ssf license service listening on 127.0.0.1:${deps.port}`);
});
