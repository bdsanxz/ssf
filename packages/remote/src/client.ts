// F-43: thin-client transport for remote mode (tier 3).
// The script stays on the customer machine and carries no secret logic:
// it forwards inputs plus the license key to the publisher server, which
// decides the result from the license. HTTPS is mandatory; plain HTTP is
// accepted only for loopback hosts (local development and tests). The
// token never appears in error messages.

export type RemoteFailureCode = "REMOTE_NETWORK" | "REMOTE_DENIED" | "REMOTE_INVALID";

export class RemoteError extends Error {
  readonly code: RemoteFailureCode;

  constructor(code: RemoteFailureCode, message: string) {
    super(message);
    this.name = "RemoteError";
    this.code = code;
  }
}

export interface RemoteClientOptions {
  /** Publisher endpoint base URL (https; loopback http allowed for tests). */
  endpoint: string;
  /** Returns the license key (token) for the Authorization header. */
  getToken: () => string | Promise<string>;
  /** Request timeout in milliseconds (default 30_000). */
  timeoutMs?: number;
  /** Largest accepted response body in bytes (default 1_048_576). */
  maxBytes?: number;
  /** Transport override for tests (defaults to global fetch). */
  fetchFn?: typeof fetch;
}

export type RemoteResult = { ok: true; result: unknown } | { ok: false; error: string };

function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/** Reject non-HTTPS endpoints (loopback HTTP stays allowed for tests). */
export function assertHttpsEndpoint(endpoint: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new RemoteError("REMOTE_NETWORK", "Remote endpoint URL is invalid.");
  }
  if (parsed.protocol === "https:") {
    return parsed;
  }
  if (parsed.protocol === "http:" && isLoopback(parsed.hostname)) {
    return parsed;
  }
  throw new RemoteError("REMOTE_NETWORK", "Remote mode needs an https endpoint.");
}

/** Thin-client caller: POSTs inputs with the license key, returns the server decision. */
export function createRemoteClient(options: RemoteClientOptions): {
  call: (path: string, body?: unknown) => Promise<unknown>;
} {
  const base = assertHttpsEndpoint(options.endpoint);
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxBytes = options.maxBytes ?? 1_048_576;
  const runFetch = options.fetchFn ?? fetch;

  async function call(path: string, body?: unknown): Promise<unknown> {
    const token = await options.getToken();
    if (typeof token !== "string" || token.length === 0) {
      throw new RemoteError("REMOTE_DENIED", "Remote call needs a license key.");
    }
    const target = new URL(path.replace(/^\//, ""), `${base.toString().replace(/\/?$/, "/")}`).toString();
    if (!target.startsWith(base.toString().replace(/\/?$/, "/"))) {
      throw new RemoteError("REMOTE_INVALID", "Remote path escapes the endpoint.");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await runFetch(target, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ input: body ?? null }),
        signal: controller.signal,
      });
    } catch {
      throw new RemoteError("REMOTE_NETWORK", "Remote server is unreachable.");
    } finally {
      clearTimeout(timer);
    }
    let raw: ArrayBuffer;
    try {
      raw = await response.arrayBuffer();
    } catch {
      throw new RemoteError("REMOTE_NETWORK", "Remote server returned an unreadable response.");
    }
    if (raw.byteLength > maxBytes) {
      throw new RemoteError("REMOTE_INVALID", "Remote response exceeds the size limit.");
    }
    let parsed: RemoteResult;
    try {
      parsed = JSON.parse(Buffer.from(raw).toString("utf8")) as RemoteResult;
    } catch {
      throw new RemoteError("REMOTE_NETWORK", "Remote server returned an unreadable response.");
    }
    if (typeof parsed !== "object" || parsed === null) {
      throw new RemoteError("REMOTE_NETWORK", "Remote server returned an unreadable response.");
    }
    if (parsed.ok === true) {
      return (parsed as { result: unknown }).result;
    }
    if (response.status === 401 || response.status === 403) {
      throw new RemoteError("REMOTE_DENIED", "Remote server refused the license.");
    }
    throw new RemoteError("REMOTE_INVALID", "Remote server returned an error.");
  }

  return { call };
}
