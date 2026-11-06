// F-95: HTTP transport for the verification service.
// Only POST /v1/licenses/verify exists. HTTPS termination (and optional
// certificate pinning) belongs to the deployment; the handler itself is
// protocol-agnostic so tests can run it over loopback HTTP.

import { createServer, type IncomingMessage, type RequestListener, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import {
  createRevocationReader,
  verifyOnlineRequest,
  type OnlineVerifyRequest,
  type OnlineVerifyResponse,
  type ServiceDeps,
} from "./service.js";

/** Maximum verify-request body: tokens are small, leases stay server-side. */
export const MAX_BODY_BYTES = 64 * 1024;

function sendJson(response: ServerResponse, status: number, body: OnlineVerifyResponse): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  response.end(text);
}

/** Build the request listener; the caller owns listen/close. */
export function createLicenseHandler(
  deps: ServiceDeps,
  reader?: { read: (nowSeconds?: number) => { updated_at: number; revoked: string[] } | null },
): RequestListener {
  const revocations = reader ?? createRevocationReader(deps.revocationsFile, deps.revocationTtlSeconds ?? 60);
  return (request: IncomingMessage, response: ServerResponse): void => {
    if (request.method !== "POST" || request.url?.split("?")[0] !== "/v1/licenses/verify") {
      response.writeHead(request.method === "POST" ? 404 : 405, { "content-type": "application/json" });
      response.end(JSON.stringify({ valid: false, status: "denied", error: "NOT_FOUND" }));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) {
        chunks.push(chunk);
      }
    });
    request.on("end", () => {
      if (size > MAX_BODY_BYTES) {
        sendJson(response, 400, { valid: false, status: "denied", error: "LICENSE_INVALID" });
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
      } catch {
        sendJson(response, 400, { valid: false, status: "denied", error: "LICENSE_INVALID" });
        return;
      }
      const body = verifyOnlineRequest((parsed ?? {}) as OnlineVerifyRequest, deps, revocations);
      if (body.valid) {
        sendJson(response, 200, body);
      } else if (body.status === "revoked") {
        sendJson(response, 403, body);
      } else {
        sendJson(response, 403, body);
      }
    });
  };
}

/** Start the service on an ephemeral or fixed port; returns the base URL. */
export async function startLicenseService(
  deps: ServiceDeps,
  options?: { port?: number; host?: string },
): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer(createLicenseHandler(deps));
  const host = options?.host ?? "127.0.0.1";
  await new Promise<void>((resolve) => server.listen(options?.port ?? 0, host, resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : options?.port ?? 0;
  return {
    url: `http://${host}:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      }),
  };
}

export interface EnvServiceConfig {
  port: number;
  licensePublicKey: KeyObject;
  leasePrivateKey: KeyObject;
  leaseKid: string;
  rootSecret: Buffer;
  revocationsFile: string;
  leaseTtlSeconds?: number;
}

/** Build service dependencies from environment (deployment entry point). */
export function serviceDepsFromEnv(env: NodeJS.ProcessEnv = process.env): EnvServiceConfig {
  const publicKeyFile = env["SSF_LICENSE_PUBLIC_KEY_FILE"];
  const leaseKeyFile = env["SSF_LEASE_PRIVATE_KEY_FILE"];
  const rootSecretFile = env["SSF_ROOT_SECRET_FILE"];
  const revocationsFile = env["SSF_REVOCATIONS_FILE"];
  const leaseKid = env["SSF_LEASE_KID"];
  if (!publicKeyFile || !leaseKeyFile || !rootSecretFile || !revocationsFile || !leaseKid) {
    throw new Error(
      "License service needs SSF_LICENSE_PUBLIC_KEY_FILE, SSF_LEASE_PRIVATE_KEY_FILE, SSF_ROOT_SECRET_FILE, SSF_REVOCATIONS_FILE, and SSF_LEASE_KID.",
    );
  }
  const rootSecret = Buffer.from(readFileSync(rootSecretFile, "utf8").trim(), "hex");
  if (rootSecret.length !== 32) {
    throw new Error("License service root secret must be 32 bytes of hex.");
  }
  const leaseTtl = env["SSF_LEASE_TTL_SECONDS"];
  return {
    port: Number(env["SSF_LICENSE_PORT"] ?? "8443"),
    licensePublicKey: createPublicKey(readFileSync(publicKeyFile, "utf8")),
    leasePrivateKey: createPrivateKey(readFileSync(leaseKeyFile, "utf8")),
    leaseKid,
    rootSecret,
    revocationsFile,
    leaseTtlSeconds: leaseTtl === undefined ? undefined : Number(leaseTtl),
  };
}
