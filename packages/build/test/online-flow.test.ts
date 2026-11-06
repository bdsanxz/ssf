// F-41: online mode end-to-end. A real build, a real online token, and a
// real verification service over loopback HTTP: first access fetches and
// caches a lease (0600), later access reuses the cache with the service
// down, expiry plus outage fails closed, and revocation is refused.

import { describe, expect, test } from "bun:test";
import { generateRootSecret, generateSigningKeypair, signArtifact } from "@ssf/crypto";
import { runInstalled } from "@ssf/runtime";
import { issueLicense, revokeLicenseId } from "@ssf/license";
import { startLicenseService, type ServiceDeps } from "@ssf/license-verification";
import { buildSkill } from "../src/pipeline.js";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { createRuntime, RuntimeError, type RuntimeConfig } from "@ssf/runtime";
import type { SkillManifest, SsfConfig } from "@ssf/manifest";

const MANIFEST = [
  "skill:",
  "  id: demo",
  "  version: 1.0.0",
  "  description: Demo skill for online flow tests. Use when testing guarantees.",
  "  license: Proprietary",
  "",
  "license:",
  "  mode: offline",
  "",
  "companion_files:",
  "  - path: secrets/notes.md",
  "    protection: encrypted",
  "    description: Notes",
  "",
  "scripts:",
  "  - id: echo-args",
  "    entry: src/echo.ts",
  "    description: Echo arguments back",
  "    usage: <words...>",
  "    max_output_chars: 30",
  "    timeout_seconds: 2",
  "",
].join("\n");

const SOURCE = "console.log(JSON.stringify(process.argv.slice(2)));\n";

function keys() {
  const license = generateSigningKeypair();
  const artifact = generateSigningKeypair();
  const lease = generateSigningKeypair();
  return {
    rootSecret: generateRootSecret(),
    licensePrivateKey: license.privateKey,
    licensePublicKey: license.publicKey,
    artifactPrivateKey: artifact.privateKey,
    artifactPublicKey: artifact.publicKey,
    leasePrivateKey: lease.privateKey,
    leasePublicKey: lease.publicKey,
  };
}

function config(): SsfConfig {
  return {
    workspace: { publisher: "acme", defaultMode: "offline" },
    license: { env: "ACME_SSF_LICENSE", configFile: "acme/license" },
    keys: { dir: "./keys", licenseKid: "prod-2026", artifactKid: "prod-2026", rootKid: "prod-2026" },
    limits: { defaultMaxLines: 500, defaultMaxChars: 40000, defaultScriptOutputChars: 20000, defaultScriptTimeoutSeconds: 120 },
    agent: { confidentialityNotice: { enabled: true } },
    build: { obfuscate: { scripts: true, runtime: true }, diversify: true },
    skills: ["skills/demo"],
    plugins: [],
  };
}

interface Fixture {
  outDir: string;
  token: string;
  keyMaterial: ReturnType<typeof keys>;
  dir: string;
}

let cached: Fixture | null = null;

async function fixture(): Promise<Fixture> {
  if (cached) {
    return cached;
  }
  const dir = join(tmpdir(), `ssf-online-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  const skill = join(dir, "skills", "demo");
  mkdirSync(join(skill, "src"), { recursive: true });
  mkdirSync(join(skill, "secrets"), { recursive: true });
  writeFileSync(join(skill, "skill.manifest"), MANIFEST);
  writeFileSync(join(skill, "SKILL.md"), "# Demo\n\nAuthor text.\n");
  writeFileSync(join(skill, "src", "echo.ts"), SOURCE);
  writeFileSync(join(skill, "secrets", "notes.md"), "alpha\n");
  const keyMaterial = keys();
  const result = await buildSkill({
    workspaceDir: dir,
    skillDir: join("skills", "demo"),
    manifest: parseYaml(MANIFEST) as SkillManifest,
    config: config(),
    keys: {
      rootSecret: keyMaterial.rootSecret,
      rootKid: "prod-2026",
      artifactPrivateKey: keyMaterial.artifactPrivateKey,
      artifactKid: "prod-2026",
      licensePublicKey: keyMaterial.licensePublicKey,
      leasePublicKey: keyMaterial.leasePublicKey,
    },
  });
  const { token } = issueLicense({
    rootSecret: keyMaterial.rootSecret,
    licensePrivateKey: keyMaterial.licensePrivateKey,
    licenseKid: "prod-2026",
    publisher: "acme",
    skills: [{ skillId: "demo", version: "1.0.0" }],
    expiresAt: Math.floor(Date.now() / 1000) + 86400,
    licenseId: "lic_online_e2e",
    nowSeconds: Math.floor(Date.now() / 1000),
    mode: "online",
  });
  cached = { outDir: result.outDir, token, keyMaterial, dir };
  return cached;
}

/** Fresh service deps per test: each test gets its own revocation file. */
function serviceDeps(fx: Fixture): ServiceDeps {
  return {
    licensePublicKey: fx.keyMaterial.licensePublicKey,
    leasePrivateKey: fx.keyMaterial.leasePrivateKey,
    leaseKid: "lease-2026-01",
    rootSecret: fx.keyMaterial.rootSecret,
    revocationsFile: join(
      tmpdir(),
      `ssf-onrev-${Date.now()}-${Math.floor(Math.random() * 1e6)}.json`,
    ),
    revocationTtlSeconds: 0,
    leaseTtlSeconds: 3600,
  };
}

function runtimeConfig(
  fx: Fixture,
  serviceUrl: string,
  overrides: Partial<RuntimeConfig> = {},
): RuntimeConfig {
  const containerBytes = readFileSync(join(fx.outDir, "scripts", "runtime.bin"));
  const { signature } = signArtifact(fx.keyMaterial.artifactPrivateKey, containerBytes, "prod-2026");
  return {
    skillDir: fx.outDir,
    publisher: "acme",
    skillId: "demo",
    version: "1.0.0",
    keys: {
      licensePublicKey: fx.keyMaterial.licensePublicKey,
      artifactPublicKey: fx.keyMaterial.artifactPublicKey,
      artifactKid: "prod-2026",
      artifactSignature: signature,
      leasePublicKey: fx.keyMaterial.leasePublicKey,
    },
    licenseEnvVar: "ACME_SSF_LICENSE",
    licenseConfigDir: join(tmpdir(), `ssf-oncfg-${Date.now()}-${Math.floor(Math.random() * 1e6)}`),
    stateDir: join(tmpdir(), `ssf-onstate-${Date.now()}-${Math.floor(Math.random() * 1e6)}`),
    token: fx.token,
    licenseServiceUrl: serviceUrl,
    ...overrides,
  };
}

async function expectCode(promise: Promise<unknown>, code: RuntimeError["code"]): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(RuntimeError);
    expect((error as RuntimeError).code).toBe(code);
    return;
  }
  throw new Error(`Expected ${code} but the call succeeded.`);
}

describe("online verify + lease + runtime flow (F-41)", () => {
  test("fetches a lease, caches it, and reuses it with the service down", async () => {
    const fx = await fixture();
    const service = await startLicenseService(serviceDeps(fx));
    try {
      const first = createRuntime(runtimeConfig(fx, service.url));
      const read = await first.read("secrets/notes.md");
      expect(read.content).toContain("alpha");
    } finally {
      await service.close();
    }
  }, 120_000);

  test("cached lease survives a service outage; expiry plus outage fails closed", async () => {
    const fx = await fixture();
    const stateDir = join(tmpdir(), `ssf-onstate-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    const service = await startLicenseService(serviceDeps(fx));
    try {
      const online = createRuntime(runtimeConfig(fx, service.url, { stateDir }));
      const read = await online.read("secrets/notes.md");
      expect(read.content).toContain("alpha");
      expect(existsSync(join(stateDir, "lease"))).toBe(true);
      expect(statSync(join(stateDir, "lease")).mode & 0o777).toBe(0o600);
    } finally {
      await service.close();
    }
    const cached = createRuntime(runtimeConfig(fx, "http://127.0.0.1:1", { stateDir }));
    const read = await cached.read("secrets/notes.md");
    expect(read.content).toContain("alpha");
    const expired = createRuntime(
      runtimeConfig(fx, "http://127.0.0.1:1", {
        stateDir,
        nowSeconds: Math.floor(Date.now() / 1000) + 7200,
      }),
    );
    await expectCode(expired.read("secrets/notes.md"), "LEASE_EXPIRED");
  }, 120_000);

  test("revoked licenses are refused after the lease expires", async () => {
    const fx = await fixture();
    const deps = serviceDeps(fx);
    const service = await startLicenseService(deps);
    try {
      revokeLicenseId(deps.revocationsFile, "lic_online_e2e", Math.floor(Date.now() / 1000));
      const runtime = createRuntime(runtimeConfig(fx, service.url));
      await expectCode(runtime.read("secrets/notes.md"), "LICENSE_REVOKED");
    } finally {
      await service.close();
    }
  });

  test("installed runtime uses the embedded lease key and env service URL", async () => {
    const fx = await fixture();
    const service = await startLicenseService(serviceDeps(fx));
    // In-process service plus in-process installed runtime: a child process
    // cannot be used here because execFileSync blocks the event loop the
    // service needs to answer on.
    const runInstalledLocal = async (
      argv: string[],
      env: NodeJS.ProcessEnv,
      stateDir: string,
    ): Promise<{ stdout: string; exitCode: number }> => {
      const containerBytes = readFileSync(join(fx.outDir, "scripts", "runtime.bin"));
      const { signature } = signArtifact(fx.keyMaterial.artifactPrivateKey, containerBytes, "prod-2026");
      const chunks: string[] = [];
      const originalWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = ((chunk: unknown): boolean => {
        chunks.push(String(chunk));
        return true;
      }) as typeof process.stdout.write;
      try {
        const exitCode = await runInstalled({
          runtimeJsPath: join(fx.outDir, "scripts", "runtime.js"),
          meta: {
            skillId: "demo",
            version: "1.0.0",
            publisher: "acme",
            licenseEnvVar: "ACME_SSF_LICENSE",
            licensePublicKeyPem: fx.keyMaterial.licensePublicKey.export({ format: "pem", type: "spki" }).toString(),
            leasePublicKeyPem: fx.keyMaterial.leasePublicKey.export({ format: "pem", type: "spki" }).toString(),
            artifactPublicKeyPem: fx.keyMaterial.artifactPublicKey.export({ format: "pem", type: "spki" }).toString(),
            artifactKid: "prod-2026",
            artifactSignatureHex: signature.toString("hex"),
            seedHex: "00".repeat(32),
          },
          argv,
          env,
          stateDir,
        });
        return { stdout: chunks.join(""), exitCode };
      } finally {
        process.stdout.write = originalWrite;
      }
    };
    const stateDir = join(tmpdir(), `ssf-onstate-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    const previousToken = process.env["ACME_SSF_LICENSE"];
    process.env["ACME_SSF_LICENSE"] = fx.token;
    try {
      const authed = await runInstalledLocal(["read", "secrets/notes.md"], { SSF_LICENSE_SERVICE_URL: service.url }, stateDir);
      expect(authed.exitCode).toBe(0);
      expect(authed.stdout).toContain("alpha");
      const noService = await runInstalledLocal(
        ["read", "secrets/notes.md"],
        { SSF_LICENSE_SERVICE_URL: "" },
        `${stateDir}-no-service`,
      );
      expect(noService.exitCode).toBe(5);
      expect(noService.stdout).toContain("ERROR NETWORK_UNAVAILABLE");
    } finally {
      if (previousToken === undefined) {
        delete process.env["ACME_SSF_LICENSE"];
      } else {
        process.env["ACME_SSF_LICENSE"] = previousToken;
      }
      await service.close();
    }
  }, 120_000);

  test("missing service URL fails closed without a network call", async () => {
    const fx = await fixture();
    const { licenseServiceUrl: _drop, ...withoutUrl } = runtimeConfig(fx, "http://127.0.0.1:1");
    void _drop;
    delete process.env["SSF_LICENSE_SERVICE_URL"];
    const runtime = createRuntime(withoutUrl);
    await expectCode(runtime.read("secrets/notes.md"), "NETWORK_UNAVAILABLE");
  });
});
