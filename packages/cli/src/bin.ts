#!/usr/bin/env bun
// ssf CLI: one entry point for the whole workflow (F-69 and later).
// new, generate, validate, build, dev, keys, and license commands live in
// their own modules; this file only parses argv and prints results.

import { join } from "node:path";
import { findWorkspaceRoot } from "./workspace.js";
import { licenseIssue, licenseList, licenseRevoke, licenseVerify } from "./license.js";
import { buildCommand, devCommand } from "./buildCmd.js";
import { defaultEnvFor, generatePlugin, generateReference, generateScript, generateSkill, newWorkspace } from "./scaffold.js";
import { listWorkspacePlugins } from "./plugins.js";
import { validateDistPackages, validatePluginSpecs, warnPluginSpecConventions, validateWorkspaceSkills } from "./validate.js";
import { ensureLeaseKeys, generateKeys } from "./keys.js";
import { packSkill, unpackSkill } from "./pack.js";
import { validateSsfConfig } from "@ssf/manifest";

function printHelp(): void {
  console.log(`ssf - Secure Skill Framework CLI

Usage:
  ssf new <workspace> --publisher <id>     Create a workspace
  ssf generate skill <name> (alias: g)     Scaffold skills/<name>/
  ssf generate reference <skill> <name>    Add a companion file + manifest entry
  ssf generate script <skill> <id>         Add a script + manifest entry
  ssf generate plugin <name>               Scaffold plugins/<name>.mjs + contract test
  ssf plugins list                         List workspace plugins, versions, capabilities
  ssf validate [skill]                     Validate manifests, limits, authoring rules
  ssf validate [skill] --dist              Validate built packages in dist/skills/
  ssf build [skill] [--all] [--seed <n>] [--force]
                                           [--customer <ref> --root-secret-file <hex>]
                                           Deterministic release build to dist/skills/<id>/
  ssf dev <skill>                          Dev build (random seed, kid dev) + one runtime run
  ssf keys generate (--kid <kid> | --dev) [--force]
                                           Create keypair + root secret in keys/
  ssf keys lease (--kid <kid> | --dev)     Backfill the lease keypair (online)
  ssf license issue --skills <id@ver,...> --expires <ISO|Nd> [--customer <ref>] [--ext-json <json>] [--license-id <id>] [--mode offline|online]
                                           [--root-secret-file <hex> --license-key-file <pem> --license-kid <kid>]
  ssf license verify <token> --public-key-file <pem>
  ssf license list
  ssf license revoke <id> [--revocations <file>]  Append to the revocation list (default revoked.json)
  ssf pack [skill] [--force]               Pack a public level-0 skill to <id>-<version>.tgz (refuses dev/tiered)
  ssf unpack --tgz <file> [--dir <d>] [--force]
                                           Verify and unpack a .tgz package
  ssf list                                 List skill directories
  ssf --help | -h                          Show this help
  ssf --version | -V                       Show version

Security: ssf.config.ts is executed code (like vite.config.ts). Do not run ssf in an untrusted workspace.`);
}

/**
 * Flags that consume the next arg as their value (both `--flag value` and
 * `--flag=value` forms). Positional detection below skips those values, so
 * `build --seed 7` never reads `7` as the skill name.
 */
const VALUE_FLAGS = new Set([
  "seed", "publisher", "kid", "expires", "customer", "ext-json",
  "license-id", "root-secret-file", "license-key-file", "license-kid", "public-key-file",
  "tgz", "dir", "mode", "revocations",
]);

export function takeFlag(args: string[], name: string): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === `--${name}`) {
      return args[i + 1];
    }
    if (arg.startsWith(`--${name}=`)) {
      return arg.slice(name.length + 3);
    }
  }
  return undefined;
}

/** Positional args with flag values consumed at a single point. */
export function positionals(args: string[], extraValueFlags: string[] = []): string[] {
  const values = new Set([...VALUE_FLAGS, ...extraValueFlags]);
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg.startsWith("--")) {
      if (!arg.includes("=") && values.has(arg.slice(2))) {
        i += 1;
      }
      continue;
    }
    out.push(arg);
  }
  return out;
}

function takeRepeated(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === `--${name}` && args[i + 1] !== undefined) {
      out.push(args[i + 1] as string);
    }
  }
  return out;
}

function requireRoot(): string {
  const root = findWorkspaceRoot(process.cwd());
  if (!root) {
    console.error("ssf: no ssf.config.ts found in this directory or parents.");
    process.exit(1);
  }
  return root as string;
}

async function loadConfig(root: string) {
  console.warn("Security: ssf.config.ts is executed code. Do not run ssf in an untrusted workspace.");
  const configModule = (await import(join(root, "ssf.config.ts"))) as { default: unknown };
  const validation = validateSsfConfig(configModule.default);
  if (!validation.ok) {
    console.error(`ssf: invalid ssf.config.ts: ${validation.errors.join("; ")}`);
    process.exit(1);
  }
  return configModule.default as import("@ssf/manifest").SsfConfig;
}

async function newCommand(args: string[]): Promise<void> {
  const [dir] = positionals(args);
  const publisher = takeFlag(args, "publisher");
  if (!dir || !publisher) {
    console.error("ssf: new needs <workspace> and --publisher <id>.");
    process.exit(1);
  }
  try {
    console.log(newWorkspace(dir, publisher).text);
  } catch (error) {
    console.error(`ssf: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

async function generateCommand(args: string[]): Promise<void> {
  const [kind, first, second] = positionals(args);
  const root = requireRoot();
  const config = await loadConfig(root);
  try {
    if (kind === "skill" && first) {
      console.log(generateSkill(root, first, config.workspace.publisher, config.license.env ?? defaultEnvFor(config.workspace.publisher)).text);
      return;
    }
    if (kind === "reference" && first && second) {
      console.log(generateReference(root, config.skills, first, second).text);
      return;
    }
    if (kind === "script" && first && second) {
      console.log(generateScript(root, config.skills, first, second).text);
      return;
    }
    if (kind === "plugin" && first && !second) {
      console.log(generatePlugin(root, first).text);
      return;
    }
    console.error("ssf: generate needs 'skill <name>', 'reference <skill> <name>', 'script <skill> <id>', or 'plugin <name>'.");
    process.exit(1);
  } catch (error) {
    console.error(`ssf: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

async function pluginsCommand(args: string[]): Promise<void> {
  const [sub] = positionals(args);
  if (sub !== "list") {
    console.error("ssf: plugins needs 'list'.");
    process.exit(1);
  }
  const root = requireRoot();
  const config = await loadConfig(root);
  try {
    const entries = await listWorkspacePlugins(root, config.plugins ?? []);
    if (entries.length === 0) {
      console.log("No workspace plugins configured.");
      return;
    }
    for (const entry of entries) {
      const caps = entry.capabilities.length > 0 ? ` [${entry.capabilities.join(", ")}]` : "";
      console.log(`${entry.name} ${entry.version} (api ${entry.apiVersion})${caps} <- ${entry.spec}`);
    }
  } catch (error) {
    console.error(`ssf: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

async function validateCommand(args: string[]): Promise<void> {
  const root = requireRoot();
  const config = await loadConfig(root);
  const dist = args.includes("--dist");
  const [skill] = positionals(args);
  const report = dist ? validateDistPackages(root, config.skills, skill) : validateWorkspaceSkills(root, config.skills, skill);
  for (const problem of await validatePluginSpecs(root, config.plugins)) {
    report.errors.push(problem);
  }
  for (const warning of warnPluginSpecConventions(config.plugins ?? [])) {
    report.warnings.push(warning);
  }
  if (report.warnings.length > 0) {
    console.log(report.warnings.join("\n"));
  }
  if (report.errors.length > 0) {
    console.error(report.errors.join("\n"));
    process.exit(1);
  }
  console.log(dist ? "dist packages: valid." : "workspace: valid.");
}

async function buildCommandRun(args: string[]): Promise<void> {
  const root = requireRoot();
  const config = await loadConfig(root);
  const seed = takeFlag(args, "seed");
  const [skill] = positionals(args);
  try {
    const { text } = await buildCommand(root, config, {
      skill,
      all: args.includes("--all"),
      seed: seed === undefined ? undefined : Number.parseInt(seed, 10),
      force: args.includes("--force"),
      customer: takeFlag(args, "customer"),
      rootSecretFile: takeFlag(args, "root-secret-file"),
    });
    console.log(text);
  } catch (error) {
    console.error(`ssf: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

async function devCommandRun(args: string[]): Promise<void> {
  const [skill] = positionals(args);
  if (!skill) {
    console.error("ssf: dev needs <skill>.");
    process.exit(1);
  }
  const root = requireRoot();
  const config = await loadConfig(root);
  try {
    console.log((await devCommand(root, config, skill)).text);
  } catch (error) {
    console.error(`ssf: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

async function keysCommand(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  const root = requireRoot();
  const config = await loadConfig(root);
  try {
    if (sub === "generate") {
      console.log(
        generateKeys({
          dir: join(root, config.keys.dir),
          kid: takeFlag(rest, "kid"),
          dev: rest.includes("--dev"),
          force: rest.includes("--force"),
        }).text,
      );
      return;
    }
    if (sub === "lease") {
      const kid = rest.includes("--dev") ? "dev" : (takeFlag(rest, "kid") ?? "");
      console.log(ensureLeaseKeys(join(root, config.keys.dir), kid).text);
      return;
    }
    console.error("ssf: keys needs 'generate (--kid <kid> | --dev) [--force]' or 'lease (--kid <kid> | --dev)'.");
    process.exit(1);
  } catch (error) {
    console.error(`ssf: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

async function licenseCommand(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  const root = requireRoot();
  if (sub === "list") {
    console.log(licenseList(join(root, "issued.jsonl")).text);
    return;
  }
  if (sub === "verify") {
    const [token] = positionals(rest);
    const publicKeyFile = takeFlag(rest, "public-key-file");
    if (!token || !publicKeyFile) {
      console.error("ssf: license verify needs a token and --public-key-file.");
      process.exit(1);
    }
    try {
      console.log(licenseVerify(token, { publicKeyFile }).text);
    } catch (error) {
      console.error(error instanceof Error ? error.message : "Token is not valid.");
      process.exit(2);
    }
    return;
  }
  if (sub === "issue") {
    const config = await loadConfig(root);
    const skills = takeRepeated(rest, "skills");
    try {
      const { text } = await licenseIssue(
        {
          skills,
          expires: takeFlag(rest, "expires") ?? "",
          customer: takeFlag(rest, "customer"),
          extJson: takeFlag(rest, "ext-json"),
          mode: takeFlag(rest, "mode"),
          licenseId: takeFlag(rest, "license-id"),
          rootSecretFile: takeFlag(rest, "root-secret-file"),
          licenseKeyFile: takeFlag(rest, "license-key-file"),
          licenseKid: takeFlag(rest, "license-kid"),
        },
        { workspaceDir: root, config },
      );
      console.log(text);
    } catch (error) {
      console.error(`ssf: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
    return;
  }
  if (sub === "revoke") {
    const [id] = positionals(rest);
    if (!id) {
      console.error("ssf: license revoke needs <id>.");
      process.exit(1);
    }
    try {
      const config = await loadConfig(root);
      console.log(
        licenseRevoke(
          id,
          { revocationsFile: takeFlag(rest, "revocations") },
          { workspaceDir: root, config },
        ).text,
      );
    } catch (error) {
      console.error(`ssf: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
    return;
  }
  console.error("ssf: unknown license command. Use issue, verify, list, or revoke.");
  process.exit(1);
}

async function packCommand(args: string[]): Promise<void> {
  const root = requireRoot();
  const [skill] = positionals(args);
  try {
    const packed = packSkill(root, { skill, force: args.includes("--force") });
    console.log(`packed ${packed.skillId}@${packed.version} -> ${packed.outFile}`);
  } catch (error) {
    console.error(`ssf: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

async function unpackCommand(args: string[]): Promise<void> {
  const tgz = takeFlag(args, "tgz");
  if (!args.includes("--tgz") || !tgz) {
    console.error("ssf: unpack needs '--tgz <file>'. Only .tgz packs unpack.");
    process.exit(1);
  }
  const [positional] = positionals(args, ["tgz", "dir"]);
  const file = positional ?? tgz;
  const dir = takeFlag(args, "dir");
  try {
    const unpacked = unpackSkill(file, { dir, force: args.includes("--force") });
    console.log(`unpacked ${unpacked.skillId}@${unpacked.version} -> ${unpacked.dir}`);
  } catch (error) {
    console.error(`ssf: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

export async function main(argv: string[]): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h") || argv.length === 0) {
    printHelp();
    return;
  }
  if (argv[0] === "--version" || argv[0] === "-V") {
    console.log("ssf 0.1.0");
    return;
  }
  const [command, ...rest] = argv;
  switch (command) {
    case "new":
      await newCommand(rest);
      return;
    case "generate":
    case "g":
      await generateCommand(rest);
      return;
    case "validate":
      await validateCommand(rest);
      return;
    case "build":
      await buildCommandRun(rest);
      return;
    case "dev":
      await devCommandRun(rest);
      return;
    case "keys":
      await keysCommand(rest);
      return;
    case "license":
      await licenseCommand(rest);
      return;
    case "plugins":
      await pluginsCommand(rest);
      return;
    case "pack":
      await packCommand(rest);
      return;
    case "unpack":
      await unpackCommand(rest);
      return;
    case "list": {
      const root = requireRoot();
      const config = await loadConfig(root);
      console.log([`Workspace: ${root}`, ...config.skills.map((skill) => `  ${skill}`)].join("\n"));
      return;
    }
    default:
      console.error(`ssf: unknown command '${command ?? ""}'. Run 'ssf --help'.`);
      process.exit(1);
  }
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
