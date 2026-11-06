// F-62/F-66: manifest validation, apiVersion gate, contract tests.
import { describe, expect, test } from "bun:test";
import { definePlugin, HOOK_WIRING, normalizePlugin, runContractTests, validatePlugin, type SsfPlugin } from "../src/index.js";

const GOOD: SsfPlugin = {
  name: "my-plugin",
  apiVersion: 1,
  capabilities: ["env"],
  runtime: { provideKey: async () => null },
  build: { buildStart: async () => {} },
};

describe("validatePlugin", () => {
  test("accepts a well-formed plugin and a factory returning one", () => {
    expect(validatePlugin(GOOD)).toEqual([]);
    expect(validatePlugin(() => GOOD)).toEqual([]);
  });

  test("rejects bad names, unknown capabilities, and unknown hooks", () => {
    expect(validatePlugin({ name: "Bad_Name", apiVersion: 1 } as SsfPlugin)).toContain('invalid plugin name "Bad_Name"');
    expect(validatePlugin({ name: "ok", apiVersion: 1, capabilities: ["nope"] } as unknown as SsfPlugin)).toContain(
      'unknown capability "nope": expected "network", "fs", or "env"',
    );
    expect(
      validatePlugin({ name: "ok", apiVersion: 1, runtime: { encrypt: async () => {} } } as unknown as SsfPlugin),
    ).toContain('unknown runtime hook "encrypt": plugins cannot add hooks outside the api');
    expect(validatePlugin({ name: "ok", apiVersion: 1, bogus: true } as unknown as SsfPlugin)).toContain(
      'unknown plugin field "bogus": expected name, apiVersion, enforce, apply, capabilities, build, or runtime',
    );
    expect(validatePlugin({ name: "ok", apiVersion: 1, enforce: "middle" } as unknown as SsfPlugin)).toContain(
      'invalid enforce "middle": expected "pre" or "post"',
    );
  });

  test("reads the apiVersion gate from the plugin object itself", () => {
    expect(validatePlugin({ name: "old", apiVersion: 0 } as unknown as SsfPlugin)).toEqual([
      'unsupported plugin apiVersion "0" (framework provides "1")',
    ]);
    expect(validatePlugin({ name: "missing" } as unknown as SsfPlugin)).toEqual([
      'unsupported plugin apiVersion "undefined" (framework provides "1")',
    ]);
    // A caller-supplied gate still works when the object agrees with it.
    expect(validatePlugin(GOOD, 1)).toEqual([]);
  });
});

describe("normalizePlugin", () => {
  test("calls factories and passes objects through", () => {
    expect(normalizePlugin(GOOD)).toBe(GOOD);
    expect(normalizePlugin(() => GOOD)).toBe(GOOD);
  });
});

describe("definePlugin", () => {
  test("passes objects and factories through for third-party authors (F-68)", async () => {
    const defined = definePlugin(GOOD);
    expect(normalizePlugin(defined)).toBe(GOOD);
    expect(validatePlugin(defined)).toEqual([]);
    const factory = definePlugin(() => GOOD);
    expect(normalizePlugin(factory)).toBe(GOOD);
    // The documented third-party flow: define, validate, contract-test.
    const results = await runContractTests(normalizePlugin(defined));
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((result) => result.passed)).toBe(true);
  });
});

describe("runContractTests", () => {
  test("good plugin passes every registered hook", async () => {
    const results = await runContractTests(GOOD);
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((result) => result.passed)).toBe(true);
  });

  test("throwing and mistyped hooks fail their contract test", async () => {
    const throwing: SsfPlugin = {
      name: "thrower",
      apiVersion: 1,
      runtime: { verifyLicense: async () => { throw new Error("nope"); } },
    };
    const first = await runContractTests(throwing);
    expect(first).toHaveLength(1);
    expect(first[0]!.passed).toBe(false);

    const mistyped = {
      name: "mistyped",
      apiVersion: 1,
      runtime: { verifyLicense: (async () => "yes") as unknown as () => Promise<boolean> },
    } as SsfPlugin;
    const second = await runContractTests(mistyped);
    expect(second[0]!.passed).toBe(false);
  });

  test("issueLicense drafts carry ext only", async () => {
    const greedy: SsfPlugin = {
      name: "greedy",
      apiVersion: 1,
      build: { issueLicense: async (draft) => ({ ...draft, skills: ["other"] }) as unknown as typeof draft },
    };
    const results = await runContractTests(greedy);
    expect(results[0]!.passed).toBe(false);
    expect(results[0]!.detail).toContain('only add ext claims');
  });
});

describe("HOOK_WIRING", () => {
  test("documents the F-63/F-64 scope of every hook", () => {
    expect(HOOK_WIRING["runtime.loadLicense"]).toBe("F-63");
    expect(HOOK_WIRING["runtime.verifyLicense"]).toBe("F-63");
    expect(HOOK_WIRING["runtime.provideKey"]).toBe("F-63");
    expect(HOOK_WIRING["runtime.afterRead"]).toBe("F-63");
    expect(HOOK_WIRING["build.transformSource"]).toBe("F-64");
    expect(HOOK_WIRING["build.issueLicense"]).toBe("F-64");
  });
});
