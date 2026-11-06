// F-67: builtin provider behavior and registry resolution. Every builtin is
// written against the same public plugin interface (proposal 15.6): each
// one passes validatePlugin and its contract tests, exactly like a
// third-party plugin must after MVP (F-68).
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeTier1Text } from "@ssf/crypto";
import { runContractTests, validatePlugin, type LicenseRequestContext, type SsfPlugin } from "@ssf/plugin-api";
import {
  codecDefaultPlugin,
  createTokenKeyProvider,
  createWatermarkPlugin,
  defaultBuildPlugins,
  defaultRuntimePluginNames,
  extractWatermark,
  keyProviderLease,
  licenseSourceEnv,
  licenseSourceFile,
  resolveEmbeddedPlugins,
  verifyWatermark,
} from "../src/index.js";

const ENV_VAR = "SSF_TEST_PLUGIN_ENV";

afterEach(() => {
  delete process.env[ENV_VAR];
});

function licenseContext(extra: Partial<LicenseRequestContext> = {}): LicenseRequestContext {
  return { publisher: "p", skillId: "s", version: "1", lang: "en", hasProvidedToken: false, ...extra };
}

/** Builtins use only the public interface: valid shape plus passing contract tests. */
async function expectPublicInterface(plugin: SsfPlugin): Promise<void> {
  expect(validatePlugin(plugin)).toEqual([]);
  const results = await runContractTests(plugin);
  expect(results.length).toBeGreaterThan(0);
  for (const result of results) {
    expect(`${result.hook}: ${result.detail}`).toBe(`${result.hook}: ok`);
  }
}

describe("license sources", () => {
  test("env source reads the configured variable only", async () => {
    expect(await licenseSourceEnv.runtime!.loadLicense!(licenseContext())).toBeNull();
    process.env[ENV_VAR] = "  tok-123  ";
    expect(await licenseSourceEnv.runtime!.loadLicense!(licenseContext({ envVar: ENV_VAR }))).toBe("tok-123");
    await expectPublicInterface(licenseSourceEnv);
  });

  test("file source reads the configured file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ssf-plugin-"));
    try {
      writeFileSync(join(dir, "license"), "file-token\n", "utf8");
      expect(
        await licenseSourceFile.runtime!.loadLicense!(licenseContext({ configFile: "license", configDir: dir })),
      ).toBe("file-token");
      expect(
        await licenseSourceFile.runtime!.loadLicense!(licenseContext({ configFile: "missing", configDir: dir })),
      ).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    await expectPublicInterface(licenseSourceFile);
  });

  test("token provider supplies the caller token", async () => {
    const provider = createTokenKeyProvider("caller-token");
    expect(await provider.runtime!.provideKey!(licenseContext({ hasProvidedToken: true }))).toBe("caller-token");
    await expectPublicInterface(provider);
  });

  test("lease provider yields offline (online mode arrives with F-41)", async () => {
    expect(await keyProviderLease.runtime!.provideKey!(licenseContext())).toBeNull();
    await expectPublicInterface(keyProviderLease);
  });
});

describe("codec-default", () => {
  test("encodes obfuscated text with the tier-1 codec, passes the rest through", async () => {
    const base = { publisher: "p", skillId: "s", version: "1", lang: "en" as const };
    const encoded = await codecDefaultPlugin.build!.transformCompanion!(
      { ...base, fileId: "a.md", protection: "obfuscated" },
      "hello",
    );
    expect(decodeTier1Text(encoded)).toBe("hello");
    const plain = await codecDefaultPlugin.build!.transformCompanion!(
      { ...base, fileId: "b.md", protection: "encrypted" },
      "hello",
    );
    expect(plain).toBe("hello");
    expect(await codecDefaultPlugin.build!.transformSource!({ ...base, path: "src/a.ts" }, "src")).toBe("src");
    await expectPublicInterface(codecDefaultPlugin);
  });
});

describe("watermark", () => {
  const license = { license_id: "lic_9", publisher: "p", mode: "offline" as const, skills: ["s"], issued_at: 0, expires_at: 1, ext: {} };
  const base = { publisher: "p", skillId: "s", version: "1", lang: "en" as const, fileId: "secrets/notes.md", license };

  test("marks protected text per license and verifies leaks", async () => {
    const key = ["sixteen-chars", "secret"].join("-");
    const plugin = createWatermarkPlugin({ secret: key });
    const marked = await plugin.runtime!.afterRead!({ ...base }, "alpha\n");
    expect(marked).toContain("[ssf-watermark lic_9:");
    expect(extractWatermark(marked)).toMatchObject({ licenseId: "lic_9" });
    expect(verifyWatermark(marked, key, "lic_9")).toBe(true);
    expect(verifyWatermark(marked, key, "lic_other")).toBe(false);
    expect(verifyWatermark(marked, ["wrong-secret", "12345"].join("-"), "lic_9")).toBe(false);
    expect(extractWatermark("plain text")).toBeNull();
    const other = await plugin.runtime!.afterRead!({ ...base, license: { ...license, license_id: "lic_7" } }, "alpha\n");
    expect(other).toContain("[ssf-watermark lic_7:");
    await runContractTests(plugin);
  });

  test("rejects short secrets", () => {
    expect(() => createWatermarkPlugin({ secret: "short" })).toThrow("at least 16");
  });
});

describe("registry", () => {
  test("default names resolve; unknown and token names are rejected", () => {
    expect(defaultRuntimePluginNames()).toEqual(["license-source-env", "license-source-file"]);
    expect(defaultBuildPlugins()).toHaveLength(1);
    expect(resolveEmbeddedPlugins(["license-source-env", "codec-default"])).toHaveLength(2);
    expect(() => resolveEmbeddedPlugins(["custom-thing"])).toThrow("unknown embedded plugin");
    expect(() => resolveEmbeddedPlugins(["key-provider-token"])).toThrow("per call");
  });
});
