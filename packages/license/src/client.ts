// F-41: online verification service client (used by the runtime).
// POSTs the full token plus skill id/version to /v1/licenses/verify and
// returns the signed lease. HTTPS is mandatory; plain HTTP is accepted
// only for loopback hosts (local development and tests).

import { LicenseError } from "./verify.js";

export interface LeaseRequest {
  serviceUrl: string;
  token: string;
  skillId: string;
  skillVersion: string;
  /** Override for tests and custom transports (defaults to global fetch). */
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

export interface VerifyServiceResponse {
  valid: boolean;
  status: string;
  lease?: unknown;
  error?: unknown;
}

function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/** Reject non-HTTPS service URLs (loopback HTTP stays allowed for tests). */
export function assertHttpsServiceUrl(serviceUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(serviceUrl);
  } catch {
    throw new LicenseError("NETWORK_UNAVAILABLE", "License service URL is invalid.");
  }
  if (parsed.protocol === "https:") {
    return parsed;
  }
  if (parsed.protocol === "http:" && isLoopback(parsed.hostname)) {
    return parsed;
  }
  throw new LicenseError("NETWORK_UNAVAILABLE", "License service needs an https URL.");
}

/**
 * Ask the verification service for a lease. Network failures surface as
 * NETWORK_UNAVAILABLE (fail-closed); service refusals keep their code
 * (LICENSE_REVOKED or LICENSE_INVALID).
 */
export async function requestLease(request: LeaseRequest): Promise<string> {
  const base = assertHttpsServiceUrl(request.serviceUrl);
  const endpoint = new URL("/v1/licenses/verify", base).toString();
  const runFetch = request.fetchFn ?? fetch;
  const timeoutMs = request.timeoutMs ?? 10_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await runFetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: request.token,
        skill_id: request.skillId,
        skill_version: request.skillVersion,
      }),
      signal: controller.signal,
    });
  } catch {
    throw new LicenseError("NETWORK_UNAVAILABLE", "License service is unreachable.");
  } finally {
    clearTimeout(timer);
  }
  let body: VerifyServiceResponse;
  try {
    body = (await response.json()) as VerifyServiceResponse;
  } catch {
    throw new LicenseError("NETWORK_UNAVAILABLE", "License service returned an unreadable response.");
  }
  if (typeof body !== "object" || body === null) {
    throw new LicenseError("NETWORK_UNAVAILABLE", "License service returned an unreadable response.");
  }
  if (body.valid === true && typeof body.lease === "string" && body.lease.length > 0) {
    return body.lease;
  }
  if (body.status === "revoked" || body.error === "LICENSE_REVOKED") {
    throw new LicenseError("LICENSE_REVOKED", "License has been revoked.");
  }
  const detail = typeof body.error === "string" && body.error.length > 0 ? `: ${body.error}` : ".";
  throw new LicenseError("LICENSE_INVALID", `License service refused the token${detail}`);
}
