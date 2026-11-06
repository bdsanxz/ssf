// F-43 tests: thin client plus server-side license checks.

import { describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { join } from "node:path";
import { generateRootSecret, generateSigningKeypair } from "@ssf/crypto";
import { issueLicense, LicenseError } from "@ssf/license";

import { authorizeRemoteCall, createRemoteClient, RemoteError } from "../src/index.js";
import { bundleEntryFile } from "@ssf/build";

const rootSecret = generateRootSecret();
const licenseKeys = generateSigningKeypair();

function callToken(mode: "offline" | "online" = "offline"): string {
  return issueLicense({
    rootSecret,
    licensePrivateKey: licenseKeys.privateKey,
    licenseKid: "prod-2026-11",
    publisher: "acme.example",
    skills: [{ skillId: "demo", version: "1.0.0" }],
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    mode,
  }).token;
}

describe("authorizeRemoteCall (F-43 server side)", () => {
  test("accepts licensed skills and refuses the rest", () => {
    const payload = authorizeRemoteCall({
      authorization: `Bearer ${callToken()}`,
      licensePublicKey: licenseKeys.publicKey,
      skillId: "demo",
      version: "1.0.0",
    });
    expect(payload.skills).toContain("demo");
    expect(() =>
      authorizeRemoteCall({
        authorization: callToken(),
        licensePublicKey: licenseKeys.publicKey,
        skillId: "other",
        version: "1.0.0",
      }),
    ).toThrow(LicenseError);
    expect(() => authorizeRemoteCall({ authorization: null, licensePublicKey: licenseKeys.publicKey, skillId: "demo" })).toThrow(
      "needs a license key",
    );
  });
});

describe("createRemoteClient (F-43 thin client)", () => {
  test("round-trips a server decision over loopback HTTP", async () => {
    const token = callToken("online");
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
      });
      request.on("end", () => {
        try {
          const payload = authorizeRemoteCall({
            authorization: request.headers["authorization"],
            licensePublicKey: licenseKeys.publicKey,
            skillId: "demo",
          });
          const input = (JSON.parse(body) as { input: { n: number } }).input;
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ ok: true, result: { doubled: input.n * 2, licensed: payload.license_id.length > 0 } }));
        } catch {
          response.writeHead(403, { "content-type": "application/json" });
          response.end(JSON.stringify({ ok: false, error: "LICENSE_SCOPE" }));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      const client = createRemoteClient({ endpoint: `http://127.0.0.1:${port}`, getToken: () => token });
      expect(await client.call("double", { n: 21 })).toEqual({ doubled: 42, licensed: true });
      const denied = createRemoteClient({ endpoint: `http://127.0.0.1:${port}`, getToken: () => "bogus" });
      await expect(denied.call("double", { n: 1 })).rejects.toThrow(RemoteError);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("requires https outside loopback and redacts tokens", async () => {
    expect(() => createRemoteClient({ endpoint: "http://licenses.example.com", getToken: () => "tok" })).toThrow(
      "https",
    );
    const slow = createRemoteClient({
      endpoint: "http://127.0.0.1:1",
      getToken: () => "tok",
      timeoutMs: 500,
    });
    try {
      await slow.call("x");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RemoteError);
      expect((error as RemoteError).code).toBe("REMOTE_NETWORK");
      expect((error as Error).message).not.toContain("tok");
    }
  });

  test("bundles into skill scripts", async () => {
    // Fixture lives in the repo so bare @ssf/* imports resolve through the
    // workspace node_modules like they do for real skill scripts.
    const bundled = await bundleEntryFile(join(import.meta.dir, "fixtures", "entry.ts"), {
      resolveDir: join(import.meta.dir, "fixtures"),
    });
    expect(bundled.code).toContain("createRemoteClient");
  });
});
