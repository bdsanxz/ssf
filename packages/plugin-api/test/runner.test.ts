// F-62/F-66: hook runner composition, timeouts, and fail-closed wrapping.
import { describe, expect, test } from "bun:test";
import { RuntimeError } from "@ssf/agent-contract";
import {
  DeniedByPlugin,
  orderPlugins,
  pluginsForMode,
  redactPluginText,
  runAllAllow,
  runFirstWins,
  runSequential,
  runWaterfall,
  type SsfPlugin,
} from "../src/index.js";

function plugin(name: string, hooks: Partial<SsfPlugin> = {}): SsfPlugin {
  return { name, apiVersion: 1, ...hooks };
}

const CTX = undefined as never;

describe("runFirstWins", () => {
  test("first non-null key wins; all-null resolves null", async () => {
    const plugins = [
      plugin("a", { runtime: { provideKey: async () => null } }),
      plugin("b", { runtime: { provideKey: async () => "key-b" } }),
      plugin("c", { runtime: { provideKey: async () => "key-c" } }),
    ];
    const hit = await runFirstWins(plugins, "runtime.provideKey", CTX, (candidate, context) => candidate.runtime!.provideKey!(context));
    expect(hit).toEqual({ plugin: "b", value: "key-b" });
    const miss = await runFirstWins([plugins[0]!], "runtime.provideKey", CTX, (candidate, context) => candidate.runtime!.provideKey!(context));
    expect(miss).toBeNull();
  });
});

describe("runWaterfall", () => {
  test("output flows through every hook in order", async () => {
    const plugins = [
      plugin("a", { build: { transformSource: async (_context, text) => `${text}+a` } }),
      plugin("b", { build: { transformSource: async (_context, text) => `${text}+b` } }),
    ];
    const out = await runWaterfall(plugins, "build.transformSource", CTX, "start", (candidate, context, text) => candidate.build!.transformSource!(context, text));
    expect(out).toBe("start+a+b");
  });
});

describe("runSequential", () => {
  test("every hook runs even though none returns a value", async () => {
    const seen: string[] = [];
    const plugins = ["a", "b"].map((name) => plugin(name, { build: { buildStart: async () => { seen.push(name); } } }));
    await runSequential(plugins, "build.buildStart", CTX, (candidate, context) => candidate.build!.buildStart!(context));
    expect(seen).toEqual(["a", "b"]);
  });
});

describe("runAllAllow", () => {
  test("deny beats allow and names the plugin", async () => {
    const plugins = [
      plugin("allow", { runtime: { verifyLicense: async () => true } }),
      plugin("deny", { runtime: { verifyLicense: async () => false } }),
    ];
    const error = await runAllAllow(plugins, "runtime.verifyLicense", CTX, (candidate, context) =>
      candidate.runtime!.verifyLicense!(context),
    ).then(
      () => null,
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(RuntimeError);
    expect((error as RuntimeError).code).toBe("PLUGIN_DENIED");
    expect((error as RuntimeError).exitCode).toBe(6);
    expect((error as Error).message).toContain('"deny"');
  });

  test("ctx.deny renders the denied code and message", async () => {
    const denyContext = { deny: (code: string, message: string): never => { throw new DeniedByPlugin(code, message); } };
    const plugins = [plugin("tenant", { runtime: { verifyLicense: async (context) => context.deny("LICENSE_SCOPE", "Tenant mismatch") } })];
    const error = await runAllAllow(plugins, "runtime.verifyLicense", denyContext as never, (candidate, context) =>
      candidate.runtime!.verifyLicense!(context),
    ).then(
      () => null,
      (failure: unknown) => failure,
    );
    expect(error).toMatchObject({ code: "LICENSE_SCOPE", exitCode: 2 });
    expect((error as Error).message).toContain("Tenant mismatch");
  });

  test("throw, timeout, and invalid returns become PLUGIN_ERROR", async () => {
    const throwing = plugin("boom", { runtime: { verifyLicense: async () => { throw new Error("inner"); } } });
    await expect(
      runAllAllow([throwing], "runtime.verifyLicense", CTX, (candidate, context) => candidate.runtime!.verifyLicense!(context)),
    ).rejects.toMatchObject({ code: "PLUGIN_ERROR" });

    const hanging = plugin("slow", { runtime: { verifyLicense: () => new Promise<boolean>(() => {}) } });
    await expect(
      runAllAllow([hanging], "runtime.verifyLicense", CTX, (candidate, context) => candidate.runtime!.verifyLicense!(context), { timeoutMs: 20 }),
    ).rejects.toMatchObject({ code: "PLUGIN_ERROR" });

    const invalid = plugin("weird", { runtime: { verifyLicense: (async () => "yes") as unknown as () => Promise<boolean> } });
    await expect(
      runAllAllow([invalid], "runtime.verifyLicense", CTX, (candidate, context) => candidate.runtime!.verifyLicense!(context)),
    ).rejects.toMatchObject({ code: "PLUGIN_ERROR" });
  });

  test("plugin errors redact secret-looking values", async () => {
    // Built by concatenation so the static secret scanner never sees a
    // token-shaped literal; at runtime this is a realistic token value.
    const tokenFixture = ["ssf1", "aGVsbG8", "d29ybGQ", "c2ln"].join(".");
    expect(redactPluginText(`leaked ${tokenFixture} failed`)).toContain("[redacted]");
    expect(redactPluginText("plain message")).toBe("plain message");
    const leaking = plugin("leak", {
      runtime: {
        verifyLicense: async () => { throw new Error(`saw ${tokenFixture} here`); },
      },
    });
    const error = await runAllAllow([leaking], "runtime.verifyLicense", CTX, (candidate, context) =>
      candidate.runtime!.verifyLicense!(context),
    ).then(
      () => null,
      (failure: unknown) => failure,
    );
    expect(String((error as Error).message)).toContain("[redacted]");
    expect(String((error as Error).message)).not.toContain("ssf1.");
  });
});

describe("orderPlugins", () => {
  test("pre runs first, post last, config order otherwise stable", async () => {
    const seen: string[] = [];
    const plugins = [
      plugin("default", { build: { buildStart: async () => { seen.push("default"); } } }),
      plugin("post", { enforce: "post", build: { buildStart: async () => { seen.push("post"); } } }),
      plugin("pre", { enforce: "pre", build: { buildStart: async () => { seen.push("pre"); } } }),
    ];
    const ordered = orderPlugins(plugins);
    await runSequential(ordered, "build.buildStart", CTX, (candidate, context) => candidate.build!.buildStart!(context));
    expect(seen).toEqual(["pre", "default", "post"]);
  });
});

describe("pluginsForMode", () => {
  test("apply filters to the current dev/prod mode", () => {
    const plugins = [
      plugin("both"),
      plugin("dev-only", { apply: "dev" }),
      plugin("prod-only", { apply: "prod" }),
    ];
    expect(pluginsForMode(plugins, "dev").map((entry) => entry.name)).toEqual(["both", "dev-only"]);
    expect(pluginsForMode(plugins, "prod").map((entry) => entry.name)).toEqual(["both", "prod-only"]);
  });
});
