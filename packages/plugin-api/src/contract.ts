// Plugin validation and contract tests (F-62/F-66).
// validatePlugin checks the manifest shape, the apiVersion gate (read from
// the plugin object itself, never assumed), enforce/apply values, the
// network|fs|env capability taxonomy, and that every registered hook is a
// function inside its build/runtime group. runContractTests invokes each
// registered hook once with a synthetic context: the plugin must return a
// well-typed value without throwing or timing out. The build runs both
// before any hook touches real artifacts.

import {
  DeniedByPlugin,
  normalizePlugin,
  PLUGIN_API_VERSION,
  type PluginCapability,
  type SsfPlugin,
  type SsfPluginInput,
} from "./plugin.js";
import { runAllAllow, runFirstWins, runSequential, runWaterfall, type RunnerOptions } from "./runner.js";

export interface ContractTestResult {
  hook: string;
  passed: boolean;
  detail: string;
}

const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const KNOWN_BUILD_HOOKS = [
  "configResolved",
  "buildStart",
  "buildEnd",
  "transformSource",
  "transformCompanion",
  "issueLicense",
  "packageReady",
] as const;

const KNOWN_RUNTIME_HOOKS = ["loadLicense", "verifyLicense", "provideKey", "afterRead"] as const;

/** Validate a plugin object or factory; returns error strings (empty = ok). */
export function validatePlugin(input: SsfPluginInput, apiVersion: number = PLUGIN_API_VERSION): string[] {
  let plugin: SsfPlugin;
  if (typeof input === "function") {
    try {
      plugin = normalizePlugin(input);
    } catch {
      return ["plugin factory threw when called with no arguments; call option-factories before listing them"];
    }
    if (!plugin || typeof plugin !== "object") {
      return ["plugin factory did not return a plugin object"];
    }
  } else {
    plugin = input;
  }
  if (!plugin || typeof plugin !== "object") {
    return ["missing plugin object"];
  }
  if (plugin.apiVersion !== apiVersion) {
    return [`unsupported plugin apiVersion "${String((plugin as { apiVersion?: unknown }).apiVersion)}" (framework provides "${apiVersion}")`];
  }
  const problems: string[] = [];
  if (typeof plugin.name !== "string" || !NAME_PATTERN.test(plugin.name) || plugin.name.length > 64) {
    problems.push(`invalid plugin name "${String(plugin.name)}"`);
  }
  if (plugin.enforce !== undefined && plugin.enforce !== "pre" && plugin.enforce !== "post") {
    problems.push(`invalid enforce "${String(plugin.enforce)}": expected "pre" or "post"`);
  }
  if (plugin.apply !== undefined && plugin.apply !== "dev" && plugin.apply !== "prod") {
    problems.push(`invalid apply "${String(plugin.apply)}": expected "dev" or "prod"`);
  }
  const known: PluginCapability[] = ["network", "fs", "env"];
  for (const capability of plugin.capabilities ?? []) {
    if (!known.includes(capability)) {
      problems.push(`unknown capability "${String(capability)}": expected "network", "fs", or "env"`);
    }
  }
  for (const [group, knownHooks] of [["build", KNOWN_BUILD_HOOKS], ["runtime", KNOWN_RUNTIME_HOOKS]] as const) {
    const hooks = plugin[group];
    if (hooks === undefined) {
      continue;
    }
    if (typeof hooks !== "object" || hooks === null) {
      problems.push(`plugin group "${group}" must be an object`);
      continue;
    }
    for (const key of Object.keys(hooks)) {
      if (!(knownHooks as ReadonlyArray<string>).includes(key)) {
        problems.push(`unknown ${group} hook "${key}": plugins cannot add hooks outside the api`);
      } else if (typeof (hooks as Record<string, unknown>)[key] !== "function") {
        problems.push(`${group} hook "${key}" is not a function`);
      }
    }
  }
  const topLevel = new Set(["name", "apiVersion", "enforce", "apply", "capabilities", "build", "runtime"]);
  for (const key of Object.keys(plugin)) {
    if (!topLevel.has(key)) {
      problems.push(`unknown plugin field "${key}": expected name, apiVersion, enforce, apply, capabilities, build, or runtime`);
    }
  }
  return problems;
}

function fakeBase() {
  return { publisher: "contract-test", skillId: "contract-test", version: "0.0.0", lang: "en" as const };
}

function deny(): never {
  throw new DeniedByPlugin("PLUGIN_DENIED", "contract-test deny");
}

/**
 * Run each registered hook once with a synthetic context. Every hook must
 * resolve with a well-typed value; a throw, timeout, or wrong type fails
 * that hook. Returns one result per registered hook.
 */
export async function runContractTests(plugin: SsfPlugin, options: RunnerOptions = {}): Promise<ContractTestResult[]> {
  const results: ContractTestResult[] = [];
  const record = async (hook: string, run: () => Promise<unknown>) => {
    try {
      await run();
      results.push({ hook, passed: true, detail: "ok" });
    } catch (error) {
      results.push({ hook, passed: false, detail: error instanceof Error ? error.message : String(error) });
    }
  };
  const base = fakeBase();
  const licenseContext = { ...base, hasProvidedToken: false };
  const build = plugin.build ?? {};
  const runtime = plugin.runtime ?? {};
  if (runtime.loadLicense) {
    await record("runtime.loadLicense", () =>
      runFirstWins([plugin], "runtime.loadLicense", licenseContext, (candidate) => candidate.runtime!.loadLicense!(licenseContext), options),
    );
  }
  if (runtime.provideKey) {
    await record("runtime.provideKey", () =>
      runFirstWins([plugin], "runtime.provideKey", licenseContext, (candidate) => candidate.runtime!.provideKey!(licenseContext), options),
    );
  }
  if (runtime.verifyLicense) {
    const context = {
      ...licenseContext,
      license: { license_id: "contract", publisher: "contract-test", mode: "offline" as const, skills: [], issued_at: 0, expires_at: 0, ext: {} },
      deny,
    };
    await record("runtime.verifyLicense", () =>
      runAllAllow([plugin], "runtime.verifyLicense", context, (candidate) => candidate.runtime!.verifyLicense!(context), options),
    );
  }
  if (runtime.afterRead) {
    await record("runtime.afterRead", () =>
      runWaterfall(
        [plugin],
        "runtime.afterRead",
        {
          ...base,
          fileId: "references/example.md",
          license: { license_id: "contract", publisher: "contract-test", mode: "offline" as const, skills: [], issued_at: 0, expires_at: 0, ext: {} },
        },
        "hello",
        (candidate, context, text) => candidate.runtime!.afterRead!(context, text),
        options,
      ),
    );
  }
  if (build.configResolved) {
    await record("build.configResolved", () =>
      runSequential([plugin], "build.configResolved", { ...base, workspaceDir: "." }, (candidate, context) =>
        candidate.build!.configResolved!({ ...context, workspaceDir: "." }), options,
      ),
    );
  }
  if (build.buildStart || build.buildEnd) {
    for (const stage of ["buildStart", "buildEnd"] as const) {
      const hook = build[stage];
      if (!hook) {
        continue;
      }
      await record(`build.${stage}`, () =>
        runSequential([plugin], `build.${stage}`, base, (candidate, context) => candidate.build![stage]!(context), options),
      );
    }
  }
  if (build.transformSource) {
    await record("build.transformSource", () =>
      runWaterfall([plugin], "build.transformSource", { ...base, path: "src/example.ts" }, "const x = 1;", (candidate, context, text) =>
        candidate.build!.transformSource!(context, text), options,
      ),
    );
  }
  if (build.transformCompanion) {
    await record("build.transformCompanion", () =>
      runWaterfall(
        [plugin],
        "build.transformCompanion",
        { ...base, fileId: "references/example.md", protection: "none" as const },
        "hello",
        (candidate, context, text) => candidate.build!.transformCompanion!(context, text), options,
      ),
    );
  }
  if (build.issueLicense) {
    await record("build.issueLicense", async () => {
      const draft = { ext: {} as Record<string, string> };
      const context = { ...base, skills: ["contract-test"] as string[] };
      const result = await build.issueLicense!(draft, context);
      if (!result || typeof result !== "object" || result.ext === undefined || typeof result.ext !== "object") {
        throw new Error('issueLicense must resolve a draft with an "ext" object');
      }
      for (const key of Object.keys(result)) {
        if (key !== "ext") {
          throw new Error(`issueLicense must only add ext claims (found "${key}")`);
        }
      }
    });
  }
  if (build.packageReady) {
    await record("build.packageReady", () =>
      runSequential([plugin], "build.packageReady", base, (candidate, context) =>
        candidate.build!.packageReady!(Object.freeze({ notices: Object.freeze([] as string[]) }), context), options,
      ),
    );
  }
  return results;
}
