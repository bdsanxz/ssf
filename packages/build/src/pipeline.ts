// F-21: build pipeline orchestration (plus F-33 stage gates).
// Stage order per skill: read and validate manifest and declarations, run
// the typecheck and test stages, bundle scripts, minify, obfuscate, classify
// and protect companions, generate frontmatter plus the ssf block plus the
// public manifest, pack the protected container, encrypt with derived keys,
// CBOR-encode, sign the artifact, write dist/skills/<id>/, record the
// release hash, and run the final leak scan. The build refuses to run
// without publisher key material: no default keys exist.

import { createHash, createPublicKey } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative as relativePath } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import {
  assertProductionKid,
  buildAad,
  CONTAINER_FORMAT_SEEDED,
  deriveContentKey,
  deriveFileKey,
  deriveNonce,
  encodeContainer,
  obfuscateJavaScript,
  seal,
  signArtifact,
  type ContainerEntry,
} from "@ssf/crypto";
import { type ContractLang } from "@ssf/agent-contract";
import {
  orderPlugins,
  pluginsForMode,
  runContractTests,
  runSequential,
  runWaterfall,
  validatePlugin,
  type SsfPlugin,
} from "@ssf/plugin-api";
import { codecDefaultPlugin, defaultBuildPlugins, defaultRuntimePluginNames } from "@ssf/plugins";
import {
  applySsfBlock,
  generateFrontmatterData,
  generateSsfBlock,
  renderFrontmatter,
  splitFrontmatter,
} from "@ssf/agent-contract";
import {
  assertTierAllowsContent,
  effectiveCompanionLimits,
  effectiveNotice,
  effectiveScriptLimits,
  isSharedDeclared,
  isUtf8Text,
  isValidLogicalPath,
  normalizeProtectionTier,
  parseSkillManifestText,
  validateCompanionEntry,
  validateScriptEntry,
  validateSharedSection,
  validateSkillManifest,
  type CompanionFileEntry,
  type SkillManifest,
  type SsfConfig,
} from "@ssf/manifest";
import { bundleEntryFile, bundleSource } from "./bundle.js";
import { buildPublicManifest } from "./publicManifest.js";
import { RUNTIME_BIN_PATH, RUNTIME_JS_PATH, writeSkillPackage, type PackageFiles } from "./layout.js";
import { scanPackageForLeaks } from "./leakscan.js";
import { pickSeeds } from "./diversify.js";
import { recordRelease } from "./releases.js";
import { renderRuntimeSource } from "./runtimeTemplate.js";
import { minifyJs } from "./minify.js";

export class BuildError extends Error {
  constructor(
    message: string,
    readonly stage: string,
  ) {
    super(message);
    this.name = "BuildError";
  }
}

export interface ArtifactKeys {
  rootSecret: Buffer;
  rootKid: string;
  artifactPrivateKey: KeyObject;
  artifactKid: string;
  licensePublicKey: KeyObject;
  /** Lease verification key; embedded when the workspace sets keys.leaseKid. */
  leasePublicKey?: KeyObject;
}

export interface StageHooks {
  typecheck?: () => void | Promise<void>;
  tests?: () => void | Promise<void>;
}

export interface BuildOptions {
  force?: boolean;
  seedOverride?: number;
  dev?: boolean;
  stages?: StageHooks;
  /** Build plugins for every skill in this run (F-64). */
  plugins?: SsfPlugin[];
  /** Per-customer cut: overrides dist/skills (F-93). */
  distSkillsDir?: string;
  /** Per-customer cut: overrides releases.jsonl (F-93). */
  releasesLog?: string;
}

export interface BuildPluginSummary {
  /** All plugin names that ran, in enforce order. */
  plugins: string[];
  /** Declared resource access per plugin, for review (F-66 rule 7). */
  capabilities: Array<{ name: string; capabilities: string[] }>;
  /** Contract test outcome per hook. */
  contractTests: Array<{ hook: string; passed: boolean }>;
  /** Plugin names embedded into runtime.js (builtins only). */
  embeddedPlugins: string[];
  /** Custom runtime hooks that only apply to direct SkillRuntime use. */
  directApiOnly: string[];
  /** How many source/companion files the transforms rewrote. */
  transforms: { source: number; companion: number };
}

export interface BuildResult {
  skillId: string;
  version: string;
  hash: string;
  outDir: string;
  plugins: BuildPluginSummary;
}

export interface SkillBuildPlan {
  workspaceDir: string;
  /** Skill directory relative to the workspace, as listed in config. */
  skillDir: string;
  manifest: SkillManifest;
  config: SsfConfig;
  keys: ArtifactKeys;
  options?: BuildOptions;
  /** Build plugins (F-64). Defaults to the framework tier-1 codec. */
  plugins?: SsfPlugin[];
  /** releases.jsonl path relative to the workspace root. */
  releasesLog?: string;
  /** dist/skills directory relative to the workspace root. */
  distSkillsDir?: string;
}

function fail(stage: string, message: string): never {
  throw new BuildError(message, stage);
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  return text.split("\n").length;
}

/** F-33: run the typecheck and test stages; any failure fails the build. */
export async function runQualityStages(plan: SkillBuildPlan): Promise<void> {
  const hooks = plan.options?.stages;
  if (hooks?.typecheck) {
    try {
      await hooks.typecheck();
    } catch (error) {
      fail("typecheck", `Typecheck stage failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (hooks?.tests) {
    try {
      await hooks.tests();
    } catch (error) {
      fail("tests", `Tests stage failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** F-64: resolve build plugins (default: the tier-1 codec), validate their
shape and apiVersion, and run every registered hook's contract test. Any
failure fails the build before any hook touches real artifacts. */
export interface ResolvedBuildPlugins {
  ordered: SsfPlugin[];
  mode: "dev" | "prod";
  contractTests: Array<{ hook: string; passed: boolean }>;
}

export async function resolveBuildPlugins(plan: SkillBuildPlan): Promise<ResolvedBuildPlugins> {
  const mode = plan.options?.dev === true ? "dev" : "prod";
  // Framework defaults always run; plan plugins are additional customs.
  // A custom name colliding with a builtin is rejected: running the tier-1
  // codec twice would double-encode companions the runtime decodes once.
  const defaults = defaultBuildPlugins();
  for (const plugin of plan.plugins ?? []) {
    if (defaults.some((builtin) => builtin.name === plugin.name)) {
      fail("plugins", `Plugin "${plugin.name}" collides with a builtin plugin name.`);
    }
  }
  const resolved = [...defaults, ...(plan.plugins ?? [])];
  for (const plugin of resolved) {
    const problems = validatePlugin(plugin);
    if (problems.length > 0) {
      fail("plugins", `Plugin "${plugin.name ?? "unknown"}" is invalid: ${problems.join("; ")}`);
    }
  }
  const contractTests: Array<{ hook: string; passed: boolean }> = [];
  for (const plugin of resolved) {
    const results = await runContractTests(plugin);
    for (const result of results) {
      contractTests.push({ hook: `${plugin.name}:${result.hook}`, passed: result.passed });
      if (!result.passed) {
        fail("plugins", `Plugin "${plugin.name}" failed contract test "${result.hook}": ${result.detail}`);
      }
    }
  }
  return { ordered: pluginsForMode(orderPlugins(resolved), mode), mode, contractTests };
}

/** F-64: run one build lifecycle stage across every plugin that has the hook. */
async function runLifecycleStage(
  plugins: SsfPlugin[],
  stage: "configResolved" | "buildStart" | "buildEnd" | "packageReady",
  base: { publisher: string; skillId: string; version: string; lang: ContractLang },
  workspaceDir: string,
): Promise<void> {
  const hooks = plugins.filter((plugin) => plugin.build?.[stage]);
  if (hooks.length === 0) {
    return;
  }
  try {
    if (stage === "configResolved") {
      await runSequential(hooks, "build.configResolved", { ...base, workspaceDir }, (plugin, context) =>
        plugin.build!.configResolved!({ ...context, workspaceDir }),
      );
    } else if (stage === "packageReady") {
      // Read-only by construction: the only metadata handle is deep-frozen,
      // and no release writer is exposed. Any write attempt throws and fails
      // the build (fail-closed).
      const meta = Object.freeze({ notices: Object.freeze([] as string[]) });
      await runSequential(hooks, "build.packageReady", base, (plugin, context) =>
        plugin.build!.packageReady!(meta, context),
      );
    } else {
      await runSequential(hooks, `build.${stage}`, base, (plugin, context) =>
        plugin.build![stage]!(context),
      );
    }
  } catch (error) {
    fail("plugins", error instanceof Error ? error.message : String(error));
  }
}

/** Validate the manifest and every declaration. Returns errors, if any. */
export function validateSkillPlan(plan: SkillBuildPlan): string[] {
  const errors: string[] = [];
  errors.push(...validateSkillManifest(plan.manifest).errors);
  errors.push(...validateSharedSection(plan.manifest));
  for (const file of plan.manifest.companion_files ?? []) {
    errors.push(...validateCompanionEntry(file));
  }
  for (const script of plan.manifest.scripts ?? []) {
    errors.push(...validateScriptEntry(script));
  }
  return errors;
}

/**
 * Require publisher key material. Production builds refuse test kids;
 * dev builds require kid "dev" (example stays rejected) and sign dev
 * artifacts that production runtimes reject.
 */
function requirePublisherKeys(keys: ArtifactKeys, dev: boolean): void {
  if (keys.rootSecret.length !== 32 || keys.rootKid.length === 0) {
    fail("keys", "Build needs publisher key material: a 32-byte root secret with a kid. No default keys exist.");
  }
  if (dev) {
    if (keys.rootKid !== "dev" || keys.artifactKid !== "dev") {
      fail("keys", "Dev builds need key material with kid \"dev\".");
    }
    return;
  }
  try {
    assertProductionKid(keys.rootKid);
    assertProductionKid(keys.artifactKid);
  } catch (error) {
    fail("keys", error instanceof Error ? error.message : String(error));
  }
}

/** Read one companion file or fail the build when it is missing. */
function readCompanion(skillAbsDir: string, logicalPath: string): Buffer {
  try {
    const full = join(skillAbsDir, logicalPath);
    if (!statSync(full).isFile()) {
      fail("validate", `Companion file is not a file: ${logicalPath}`);
    }
    return readFileSync(full);
  } catch (error) {
    if (error instanceof BuildError) throw error;
    fail("validate", `Companion file in manifest was not found: ${logicalPath}`);
  }
}

/**
 * Encrypt one protected companion file into a container entry. The declared
 * protection mode always comes from the manifest: transforms only rewrite
 * text, they can never downgrade the mode. Tier-1 encoding is applied by
 * the default codec plugin through the hook runner, never special-cased.
 */
async function protectCompanion(
  bytes: Buffer,
  file: CompanionFileEntry,
  plan: SkillBuildPlan,
  contentKey: Buffer,
  plugins: SsfPlugin[],
  pluginBase: { publisher: string; skillId: string; version: string; lang: ContractLang },
): Promise<{ entry: ContainerEntry; plaintext: string; transformed: boolean }> {
  const protection = normalizeProtectionTier(file.protection, file.path);
  if (protection === "none") {
    fail("validate", `Public file routed to protection: ${file.path}`);
  }
  assertTierAllowsContent(protection, bytes, file.path);
  // F-94: binary assets skip every text stage (transforms, codec, line
  // counts). They are GCM-sealed as raw bytes and extract-only at read.
  const binary = !isUtf8Text(bytes);
  const text = binary ? bytes.toString("latin1") : bytes.toString("utf8");
  const hooks = binary ? [] : plugins.filter((plugin) => plugin.build?.transformCompanion);
  let transformedText = text;
  if (hooks.length > 0) {
    try {
      transformedText = await runWaterfall(
        hooks,
        "build.transformCompanion",
        { ...pluginBase, fileId: file.path, protection },
        text,
        (plugin, context, current) => plugin.build!.transformCompanion!(context, current),
      );
    } catch (error) {
      fail("plugins", error instanceof Error ? error.message : String(error));
    }
  }
  const fileKey = deriveFileKey(contentKey, file.path);
  const payload = binary ? Buffer.from(bytes) : Buffer.from(transformedText, "utf8");
  const sealed = seal(fileKey, deriveNonce(fileKey, payload), payload, buildAad(plan.manifest.skill.id, plan.manifest.skill.version, file.path));
  const limits = effectiveCompanionLimits(file, plan.manifest, plan.config);
  return {
    entry: {
      kind: "file",
      id: file.path,
      protection,
      description: file.description,
      lines: binary ? undefined : countLines(text),
      binary: binary || undefined,
      notice: effectiveNotice(protection, file.confidentiality_notice),
      maxLines: limits.maxLines,
      maxChars: limits.maxChars,
      nonce: sealed.nonce,
      ciphertext: sealed.ciphertext,
      tag: sealed.tag,
    },
    plaintext: text,
    transformed: transformedText !== text,
  };
}

/**
 * Bundle one entry through an overlay of transformed sources. The first
 * bundle discovers the import graph; when custom transformSource hooks
 * exist, every bundled text input is transformed and the entry is bundled
 * again from the overlay, so hooks run before bundling (never on output).
 */
async function bundleWithSourcePlugins(
  entryFile: string,
  skillAbsDir: string,
  workspaceDir: string,
  plugins: SsfPlugin[],
  pluginBase: { publisher: string; skillId: string; version: string; lang: ContractLang },
): Promise<{ code: string; inputs: string[]; transformed: number }> {
  const first = await bundleEntryFile(entryFile, { resolveDir: skillAbsDir, workspaceDir });
  const hooks = plugins.filter((plugin) => plugin.build?.transformSource);
  if (hooks.length === 0) {
    return { ...first, transformed: 0 };
  }
  const overlay = mkdtempSync(join(tmpdir(), "ssf-overlay-"));
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const stage = (absolute: string, workspaceRel: string): void => {
      const target = join(overlay, workspaceRel);
      mkdirSync(dirname(target), { recursive: true });
      const bytes = readFileSync(absolute);
      try {
        writeFileSync(target, decoder.decode(bytes), "utf8");
      } catch {
        copyFileSync(absolute, target);
      }
    };
    const staged = new Map<string, string>();
    const toWorkspaceRel = (absolute: string): string =>
      relativePath(workspaceDir, absolute).replace(/\\/g, "/");
    stage(entryFile, toWorkspaceRel(entryFile));
    staged.set(entryFile, toWorkspaceRel(entryFile));
    for (const input of first.inputs) {
      // Metafile inputs are relative to the skill dir (absWorkingDir), so
      // they resolve against skillAbsDir, not the workspace root.
      const absolute = isAbsolute(input) ? input : join(skillAbsDir, input);
      if (staged.has(absolute)) {
        continue;
      }
      staged.set(absolute, toWorkspaceRel(absolute));
      stage(absolute, toWorkspaceRel(absolute));
    }
    let transformed = 0;
    for (const workspaceRel of staged.values()) {
      const target = join(overlay, workspaceRel);
      let text: string;
      try {
        text = decoder.decode(readFileSync(target));
      } catch {
        continue;
      }
      let next = text;
      try {
        next = await runWaterfall(hooks, "build.transformSource", { ...pluginBase, path: workspaceRel }, text, (plugin, context, current) =>
          plugin.build!.transformSource!(context, current),
        );
      } catch (error) {
        fail("plugins", error instanceof Error ? error.message : String(error));
      }
      if (next !== text) {
        transformed += 1;
      }
      writeFileSync(target, next, "utf8");
    }
    const overlayEntry = join(overlay, toWorkspaceRel(entryFile));
    const overlaySkillDir = join(overlay, relativePath(workspaceDir, skillAbsDir).replace(/\\/g, "/"));
    const second = await bundleEntryFile(overlayEntry, { resolveDir: overlaySkillDir, workspaceDir: overlay });
    const inputs = second.inputs.map((input) => {
      const absolute = isAbsolute(input) ? input : join(overlay, input);
      return relativePath(workspaceDir, absolute).replace(/\\/g, "/");
    });
    return { code: second.code, inputs, transformed };
  } finally {
    rmSync(overlay, { recursive: true, force: true });
  }
}

/** Bundle, minify, obfuscate, and encrypt one script id. */
async function protectScript(
  skillAbsDir: string,
  workspaceDir: string,
  scriptId: string,
  plan: SkillBuildPlan,
  contentKey: Buffer,
  obfuscatorSeed: number,
  plugins: SsfPlugin[],
  pluginBase: { publisher: string; skillId: string; version: string; lang: ContractLang },
): Promise<{ entry: ContainerEntry; source: string; transformed: number }> {
  const script = (plan.manifest.scripts ?? []).find((item) => item.id === scriptId);
  if (!script || !isValidLogicalPath(script.entry)) {
    fail("bundle", `Unknown or invalid script id: ${scriptId}`);
  }
  const entryFile = join(skillAbsDir, script.entry);
  try {
    if (!statSync(entryFile).isFile()) {
      fail("bundle", `Script entry was not found: ${script.entry}`);
    }
  } catch (error) {
    if (error instanceof BuildError) throw error;
    fail("bundle", `Script entry was not found: ${script.entry}`);
  }
  const bundled = await bundleWithSourcePlugins(entryFile, skillAbsDir, workspaceDir, plugins, pluginBase);
  for (const input of bundled.inputs) {
    const absolute = isAbsolute(input) ? input : join(skillAbsDir, input);
    const relative = relativePath(workspaceDir, absolute).replace(/\\/g, "/");
    if (relative.startsWith("shared/") && !isSharedDeclared(plan.manifest, relative)) {
      fail("bundle", `Script bundles undeclared shared file: ${relative}`);
    }
  }
  const source = readFileSync(entryFile, "utf8");
  const obfuscated = obfuscateJavaScript(minifyJs(bundled.code), { seed: obfuscatorSeed });
  const scriptLimits = effectiveScriptLimits(script, plan.config);
  const fileKey = deriveFileKey(contentKey, script.id);
  const payload = Buffer.from(obfuscated, "utf8");
  const sealed = seal(fileKey, deriveNonce(fileKey, payload), payload, buildAad(plan.manifest.skill.id, plan.manifest.skill.version, script.id));
  return {
    entry: {
      kind: "script",
      id: script.id,
      protection: "encrypted",
      description: script.description,
      usage: script.usage,
      lines: countLines(source),
      notice: false,
      maxOutputChars: scriptLimits.maxOutputChars,
      timeoutSeconds: scriptLimits.timeoutSeconds,
      nonce: sealed.nonce,
      ciphertext: sealed.ciphertext,
      tag: sealed.tag,
    },
    source,
    transformed: bundled.transformed,
  };
}

/** Bundle, minify, and obfuscate the runtime loader with embedded metadata. */
async function buildRuntimeJs(
  skillAbsDir: string,
  plan: SkillBuildPlan,
  signatureHex: string,
  seedHex: string,
  obfuscatorSeed: number,
  pluginNames: string[],
): Promise<string> {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const installedEntryFile = require.resolve("@ssf/runtime/src/installed.ts");
  const source = renderRuntimeSource({
    skillId: plan.manifest.skill.id,
    version: plan.manifest.skill.version,
    publisher: plan.config.workspace.publisher,
    licenseEnvVar: plan.config.license.env,
    licensePublicKeyPem: plan.keys.licensePublicKey.export({ format: "pem", type: "spki" }).toString(),
    leasePublicKeyPem: plan.keys.leasePublicKey?.export({ format: "pem", type: "spki" }).toString(),
    artifactPublicKeyPem: createPublicKey(plan.keys.artifactPrivateKey).export({ format: "pem", type: "spki" }).toString(),
    artifactKid: plan.keys.artifactKid,
    artifactSignatureHex: signatureHex,
    seedHex,
    pluginNames,
    dev: plan.options?.dev === true,
    containerLayout: CONTAINER_FORMAT_SEEDED,
    installedEntryFile,
  });
  const bundled = await bundleSource(source, "js", { resolveDir: skillAbsDir });
  return obfuscateJavaScript(minifyJs(bundled.code), { seed: obfuscatorSeed });
}

/** Build one skill end to end and write dist/skills/<id>/. */
export async function buildSkill(plan: SkillBuildPlan): Promise<BuildResult> {
  const { manifest, config, keys } = plan;
  const skillId = manifest.skill.id;
  const version = manifest.skill.version;
  const skillAbsDir = join(plan.workspaceDir, plan.skillDir);
  const distSkillsDir = join(
    plan.workspaceDir,
    plan.distSkillsDir ?? plan.options?.distSkillsDir ?? join("dist", "skills"),
  );
  const releasesLog = join(plan.workspaceDir, plan.releasesLog ?? plan.options?.releasesLog ?? "releases.jsonl");

  const planErrors = validateSkillPlan(plan);
  if (planErrors.length > 0) {
    fail("validate", planErrors.join("; "));
  }
  requirePublisherKeys(keys, plan.options?.dev === true);
  const buildPlugins = await resolveBuildPlugins(plan);
  const pluginBase = {
    publisher: config.workspace.publisher,
    skillId,
    version,
    lang: "en" as ContractLang,
  };
  await runLifecycleStage(buildPlugins.ordered, "configResolved", pluginBase, plan.workspaceDir);
  await runQualityStages(plan);
  await runLifecycleStage(buildPlugins.ordered, "buildStart", pluginBase, plan.workspaceDir);

  const seeds = pickSeeds(keys.rootSecret, skillId, version, {
    seedOverride: plan.options?.seedOverride,
    dev: plan.options?.dev,
  });
  const contentKey = deriveContentKey(keys.rootSecret, skillId, version);

  const secretTexts: string[] = [];
  const entries: ContainerEntry[] = [];
  const files: PackageFiles = new Map();
  let sourceTransforms = 0;
  let companionTransforms = 0;

  for (const script of manifest.scripts ?? []) {
    const protected_ = await protectScript(skillAbsDir, plan.workspaceDir, script.id, plan, contentKey, seeds.obfuscatorSeed, buildPlugins.ordered, pluginBase);
    secretTexts.push(protected_.source);
    entries.push(protected_.entry);
    sourceTransforms += protected_.transformed;
  }

  for (const file of manifest.companion_files ?? []) {
    const protection = normalizeProtectionTier(file.protection, file.path);
    const bytes = readCompanion(skillAbsDir, file.path);
    if (protection === "none") {
      files.set(file.path, bytes);
      continue;
    }
    const protected_ = await protectCompanion(bytes, file, plan, contentKey, buildPlugins.ordered, pluginBase);
    secretTexts.push(protected_.plaintext);
    entries.push(protected_.entry);
    if (protected_.transformed) {
      companionTransforms += 1;
    }
  }

  // F-16b3/F-25: the container layout (field order, magic bytes) derives
  // from the release seed; verification needs no seed (canonical hash).
  const containerBytes = encodeContainer(keys.rootKid, entries, { seed: seeds.releaseSeed });
  const { signature } = signArtifact(keys.artifactPrivateKey, containerBytes, keys.artifactKid);
  const hash = createHash("sha256").update(containerBytes).digest("hex");

  let authorSkillMd: string;
  try {
    authorSkillMd = readFileSync(join(skillAbsDir, "SKILL.md"), "utf8");
  } catch {
    fail("validate", "SKILL.md is missing from the skill directory.");
  }
  const { body } = splitFrontmatter(authorSkillMd);
  const skillMd = `${renderFrontmatter(generateFrontmatterData(manifest, config))}\n${applySsfBlock(body, generateSsfBlock(manifest))}`;
  files.set("SKILL.md", Buffer.from(skillMd, "utf8"));
  files.set("skill.manifest", Buffer.from(stringifyYaml(buildPublicManifest(manifest)), "utf8"));

  // Only builtin runtime plugins embed by name; custom runtime hooks stay
  // direct-API-only and are reported as such in the build summary.
  const embeddedPlugins = defaultRuntimePluginNames();
  const directApiOnly = (plan.plugins ?? [])
    .filter((plugin) => plugin.runtime && Object.keys(plugin.runtime).length > 0)
    .map((plugin) => plugin.name);
  const runtimeJs = await buildRuntimeJs(skillAbsDir, plan, signature.toString("hex"), seeds.releaseSeed.toString("hex"), seeds.obfuscatorSeed, embeddedPlugins);
  files.set(RUNTIME_JS_PATH, Buffer.from(runtimeJs, "utf8"));
  files.set(RUNTIME_BIN_PATH, containerBytes);

  const outDir = writeSkillPackage(distSkillsDir, skillId, files);
  try {
    recordRelease(releasesLog, { skill: skillId, version, hash, kid: keys.artifactKid }, { force: plan.options?.force });
  } catch (error) {
    fail("releases", error instanceof Error ? error.message : String(error));
  }
  await runLifecycleStage(buildPlugins.ordered, "packageReady", pluginBase, plan.workspaceDir);
  await runLifecycleStage(buildPlugins.ordered, "buildEnd", pluginBase, plan.workspaceDir);

  const violations = scanPackageForLeaks({
    pkgDir: outDir,
    skillId,
    manifest,
    secretTexts,
    dev: plan.options?.dev === true,
    plugins: buildPlugins.ordered,
    contractTests: buildPlugins.contractTests,
    releasesLog,
    expectedHash: hash,
  });
  if (violations.length > 0) {
    fail("leakscan", violations.join("; "));
  }

  return {
    skillId,
    version,
    hash,
    outDir,
    plugins: {
      plugins: buildPlugins.ordered.map((plugin) => plugin.name),
      capabilities: buildPlugins.ordered.map((plugin) => ({ name: plugin.name, capabilities: [...(plugin.capabilities ?? [])] })),
      contractTests: buildPlugins.contractTests,
      embeddedPlugins,
      directApiOnly,
      transforms: { source: sourceTransforms, companion: companionTransforms },
    },
  };
}

export interface PerSkillOutcome {
  dir: string;
  ok: boolean;
  result?: BuildResult;
  error?: string;
}

/** Run the pipeline for every listed skill, independently per skill. */
export async function buildAllSkills(
  workspaceDir: string,
  skillDirs: string[],
  config: SsfConfig,
  keys: ArtifactKeys,
  options?: BuildOptions,
): Promise<PerSkillOutcome[]> {
  const outcomes: PerSkillOutcome[] = [];
  for (const dir of skillDirs) {
    try {
      const manifest = parseSkillManifestText(readFileSync(join(workspaceDir, dir, "skill.manifest"), "utf8"));
      const result = await buildSkill({ workspaceDir, skillDir: dir, manifest, config, keys, options, plugins: options?.plugins });
      outcomes.push({ dir, ok: true, result });
    } catch (error) {
      outcomes.push({ dir, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return outcomes;
}
