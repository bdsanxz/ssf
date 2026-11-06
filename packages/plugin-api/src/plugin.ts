// @ssf/plugin-api - hook contracts for Secure Skill Framework plugins (F-62).
// Shape follows proposal 15.2 (Vite/Rollup style): a plugin is an object, or
// a factory function returning one. Hooks nest under build and runtime.
// Plugins replace policy, never crypto primitives: there is no hook for
// algorithms, key derivation, or encryption.
//
// Hook wiring scope: runtime.* hooks are wired by the SkillRuntime (F-63);
// build.* hooks are wired by the build pipeline (F-64). build.issueLicense
// fires from `ssf license issue` (F-79) but is validated and contract-tested
// with the rest of the build hooks.

import type { ContractLang } from "@ssf/agent-contract";

export const PLUGIN_API_VERSION = 1;

/**
 * Declared resource access, for review. A plugin that touches the network
 * must claim "network", one that reads files "fs", one that reads
 * environment variables "env".
 */
export type PluginCapability = "network" | "fs" | "env";

/** Minimal context shared by every hook: identity only, never secrets. */
export interface PluginContext {
  publisher: string;
  skillId: string;
  version: string;
  lang: ContractLang;
}

/** License request context for key providers and verifiers. */
export interface LicenseRequestContext extends PluginContext {
  /** Env var configured for this publisher (name only, never the value). */
  envVar?: string;
  /** Config file path configured for this publisher. */
  configFile?: string;
  /** User config dir override (deployment detail, not a secret). */
  configDir?: string;
  /** True when the caller passed a token explicitly (token-first). */
  hasProvidedToken: boolean;
}

/** License view for verifyLicense: issuance facts, never content keys. */
export interface LicenseView {
  license_id: string;
  publisher: string;
  mode: "offline" | "online";
  skills: string[];
  issued_at: number;
  expires_at: number;
  ext: Record<string, unknown>;
}

export interface VerifyLicenseContext extends LicenseRequestContext {
  license: LicenseView;
  /**
   * Deny access with a contract error code and message. The runtime renders
   * them as `ERROR <code>` and relays the message to the user. Returning
   * false denies with PLUGIN_DENIED; returning (or resolving) true allows.
   */
  deny: (code: string, message: string) => never;
}

/** A license source returns the raw key string, or null when it has none. */
export type LoadLicenseHook = (context: LicenseRequestContext) => Promise<string | null>;

/** A key provider supplies key material; the core always verifies it. */
export type ProvideKeyHook = (context: LicenseRequestContext) => Promise<string | null>;

/** Extra license check: deny, return false (PLUGIN_DENIED), or allow. */
export type VerifyLicenseHook = (context: VerifyLicenseContext) => Promise<boolean | void>;

/** Build-time source transform: text in, text out. */
export interface SourceTransformContext extends PluginContext {
  /** Workspace-relative path of the source file. */
  path: string;
}
export type TransformSourceHook = (context: SourceTransformContext, code: string) => Promise<string>;

/** Build-time companion transform: protected text in, protected text out. */
export interface CompanionTransformContext extends PluginContext {
  /** Logical id of the companion file. */
  fileId: string;
  /** Declared protection mode; the transform must not change it. */
  protection: "none" | "obfuscated" | "encrypted";
}
export type TransformCompanionHook = (context: CompanionTransformContext, content: string) => Promise<string>;

/** License issuance draft: plugins may only add `ext` claims. */
export interface LicenseDraft {
  ext: Record<string, string>;
}

export interface IssueLicenseContext extends PluginContext {
  customer?: string;
  skills: string[];
}

/** Build lifecycle context: final config identity plus the workspace dir. */
export interface ConfigResolvedContext extends PluginContext {
  workspaceDir: string;
}

/** Build package metadata for packageReady: frozen, read-only. */
export interface PackageMeta {
  notices: readonly string[];
}

export type ConfigResolvedHook = (context: ConfigResolvedContext) => Promise<void>;
export type BuildStageHook = (context: PluginContext) => Promise<void>;
export type IssueLicenseHook = (draft: LicenseDraft, context: IssueLicenseContext) => Promise<LicenseDraft>;
export type PackageReadyHook = (pkg: PackageMeta, context: PluginContext) => Promise<void>;

/**
 * Runtime afterRead transform: protected companion text only, never
 * scripts. The verified license rides along so per-license transforms
 * (F-92 watermarks) stay stateless instead of caching license state in
 * plugin closures across concurrent runtimes.
 */
export interface AfterReadContext extends PluginContext {
  fileId: string;
  license: LicenseView;
}
export type AfterReadHook = (context: AfterReadContext, text: string) => Promise<string>;

/** Build-time hooks (wired by the build pipeline, F-64). */
export interface BuildHooks {
  configResolved?: ConfigResolvedHook;
  buildStart?: BuildStageHook;
  buildEnd?: BuildStageHook;
  transformSource?: TransformSourceHook;
  transformCompanion?: TransformCompanionHook;
  issueLicense?: IssueLicenseHook;
  packageReady?: PackageReadyHook;
}

/** Runtime hooks (bundled into runtime.js, wired by the SkillRuntime, F-63). */
export interface RuntimeHooks {
  loadLicense?: LoadLicenseHook;
  verifyLicense?: VerifyLicenseHook;
  provideKey?: ProvideKeyHook;
  afterRead?: AfterReadHook;
}

export interface SsfPlugin {
  name: string;
  apiVersion: 1;
  /** Ordering: pre plugins run before default ones, post plugins after. */
  enforce?: "pre" | "post";
  /** Build-environment filter: dev-only, prod-only, or both when omitted. */
  apply?: "dev" | "prod";
  capabilities?: PluginCapability[];
  build?: BuildHooks;
  runtime?: RuntimeHooks;
}

/**
 * Define a third-party plugin (F-68). Passes the object through unchanged
 * so plain JavaScript packages work, while TypeScript authors get full
 * type checking on the shape, hook names, and hook signatures. Factories
 * are called with no arguments by the loader.
 */
export function definePlugin(input: SsfPluginInput): SsfPluginInput {
  return input;
}

/** A plugin, or a factory returning one (called with no arguments). */
export type SsfPluginInput = SsfPlugin | (() => SsfPlugin);

/** Resolve a plugin input to the plugin object (calls factories). */
export function normalizePlugin(input: SsfPluginInput): SsfPlugin {
  if (typeof input !== "function") {
    return input;
  }
  return (input as () => SsfPlugin)();
}

/** Stable order: pre plugins first, then default, then post. */
export function orderPlugins(plugins: SsfPlugin[]): SsfPlugin[] {
  const rank = (plugin: SsfPlugin): number => (plugin.enforce === "pre" ? 0 : plugin.enforce === "post" ? 2 : 1);
  return [...plugins]
    .map((plugin, index) => ({ plugin, index }))
    .sort((a, b) => rank(a.plugin) - rank(b.plugin) || a.index - b.index)
    .map((entry) => entry.plugin);
}

/** Keep only plugins that apply to the given build environment. */
export function pluginsForMode(plugins: SsfPlugin[], mode: "dev" | "prod"): SsfPlugin[] {
  return plugins.filter((plugin) => !plugin.apply || plugin.apply === mode);
}

/** Thrown by ctx.deny(); the runner renders it as ERROR <code>. */
export class DeniedByPlugin extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DeniedByPlugin";
    this.code = code;
  }
}

/**
 * Which framework pass wires each hook. loadLicense and issueLicense belong
 * to the F-63/F-64 plugin passes (validated and contract-tested here);
 * issueLicense fires from `ssf license issue` (F-79).
 */
export const HOOK_WIRING: Record<string, "F-63" | "F-64"> = {
  "runtime.loadLicense": "F-63",
  "runtime.verifyLicense": "F-63",
  "runtime.provideKey": "F-63",
  "runtime.afterRead": "F-63",
  "build.configResolved": "F-64",
  "build.buildStart": "F-64",
  "build.buildEnd": "F-64",
  "build.transformSource": "F-64",
  "build.transformCompanion": "F-64",
  "build.issueLicense": "F-64",
  "build.packageReady": "F-64",
};
