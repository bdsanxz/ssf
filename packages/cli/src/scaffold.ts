// F-69/F-70: workspace scaffolding and skill generation.
// Generators write template files with substituted names and register the
// skill in ssf.config.ts when the skills array is detectable.

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isValidLogicalPath, NAME_PATTERN, type SkillManifest } from "@ssf/manifest";
import {
  renderPluginTemplate,
  renderReferenceTemplate,
  renderScriptTemplate,
  renderSkillTemplate,
  renderWorkspaceTemplate,
} from "@ssf/templates";

export function defaultEnvFor(publisher: string): string {
  return `${publisher.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_SSF_LICENSE`;
}

function exists(path: string): boolean {
  try {
    return statSync(path).isFile() || statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Create a new workspace directory with config and gitignore. */
export function newWorkspace(dir: string, publisher: string): { text: string } {
  if (exists(join(dir, "ssf.config.ts"))) {
    throw new Error(`Workspace already exists: ${join(dir, "ssf.config.ts")}. Pick an empty directory.`);
  }
  mkdirSync(dir, { recursive: true });
  const env = defaultEnvFor(publisher);
  for (const file of renderWorkspaceTemplate({ workspace: dir, publisher, env })) {
    const full = join(dir, file.path);
    if (exists(full)) {
      throw new Error(`Refusing to overwrite ${full}. Pick an empty directory.`);
    }
    writeFileSync(full, file.content);
  }
  return { text: `Created workspace ${dir} (publisher ${publisher}, env ${env}). Next: ssf generate skill <name>.` };
}

function registerSkillInConfig(workspaceDir: string, skillDir: string): boolean {
  const configPath = join(workspaceDir, "ssf.config.ts");
  let text: string;
  try {
    text = readFileSync(configPath, "utf8");
  } catch {
    return false;
  }
  const match = /skills:\s*\[([^\]]*)\]/.exec(text);
  if (!match) {
    return false;
  }
  const entries = match[1] as string;
  if (entries.includes(`"${skillDir}"`) || entries.includes(`'${skillDir}'`)) {
    return true;
  }
  const separator = entries.trim().length === 0 ? "" : ", ";
  const replacement = `skills: [${entries.trim()}${separator}"${skillDir}"]`;
  writeFileSync(configPath, text.replace(match[0], replacement));
  return true;
}

function resolveSkillDir(skillDirs: string[], skill: string): string {
  const selected = skillDirs.filter((dir) => dir === skill || dir.endsWith(`/${skill}`));
  if (selected.length === 0) {
    throw new Error(`Skill "${skill}" is not listed in ssf.config.ts skills.`);
  }
  if (selected.length > 1) {
    throw new Error(`Skill "${skill}" matches several entries; pass the full directory.`);
  }
  return selected[0] as string;
}

function readSkillManifest(workspaceDir: string, skillDir: string): { path: string; manifest: SkillManifest } {
  const path = join(workspaceDir, skillDir, "skill.manifest");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error(`skill.manifest is missing: ${path}.`);
  }
  try {
    return { path, manifest: parseYaml(text) as SkillManifest };
  } catch (error) {
    throw new Error(`skill.manifest does not parse: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function writeSkillManifest(path: string, manifest: SkillManifest): void {
  writeFileSync(path, `${stringifyYaml(manifest)}`);
}

/** Scaffold skills/<name>/ and register it in ssf.config.ts. */
export function generateSkill(workspaceDir: string, name: string, publisher: string, env: string): { text: string; registered: boolean } {
  if (!NAME_PATTERN.test(name) || name.length > 64) {
    throw new Error(`Invalid skill name "${name}": lowercase letters, digits, dashes, 1-64 chars.`);
  }
  const skillDir = join("skills", name);
  const absolute = join(workspaceDir, skillDir);
  if (exists(absolute)) {
    throw new Error(`Skill directory already exists: ${absolute}.`);
  }
  for (const file of renderSkillTemplate({ name, publisher, env })) {
    const full = join(absolute, file.path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, file.content);
  }
  const registered = registerSkillInConfig(workspaceDir, skillDir);
  const next = registered
    ? "Next: fill in TODO fields, then ssf validate."
    : `Next: add "${skillDir}" to ssf.config.ts skills, fill in TODO fields, then ssf validate.`;
  return { text: `Created skill ${skillDir}. ${next}`, registered };
}

/**
 * Add a companion file plus its manifest entry (F-71). The entry is public
 * (`protection: none`) with a TODO description the author must replace;
 * `ssf validate` fails the skill without a description.
 */
export function generateReference(workspaceDir: string, skillDirs: string[], skill: string, name: string): { text: string } {
  const withExt = name.endsWith(".md") ? name : `${name}.md`;
  const normalized = withExt.includes("/") ? withExt : `references/${withExt}`;
  if (!isValidLogicalPath(normalized)) {
    throw new Error(`Invalid companion name "${name}": use a relative path like topic or guides/topic.md.`);
  }
  const skillDir = resolveSkillDir(skillDirs, skill);
  const absolute = join(workspaceDir, skillDir, normalized);
  if (exists(absolute)) {
    throw new Error(`Companion file already exists: ${absolute}.`);
  }
  const id = skillDir.split("/").pop() ?? skillDir;
  for (const file of renderReferenceTemplate({ skill: id, name: normalized.replace(/\.md$/, "") })) {
    const full = join(workspaceDir, skillDir, file.path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, file.content);
  }
  const { path, manifest } = readSkillManifest(workspaceDir, skillDir);
  manifest.companion_files = manifest.companion_files ?? [];
  if (manifest.companion_files.some((entry) => entry.path === normalized)) {
    throw new Error(`Companion entry already exists: ${normalized}.`);
  }
  manifest.companion_files.push({
    path: normalized,
    protection: "none",
    description: "TODO describe this file for list output.",
  });
  writeSkillManifest(path, manifest);
  return { text: `Created companion ${skillDir}/${normalized}. Next: write the content, replace the TODO description, then ssf validate.` };
}

/**
 * Add a script plus its manifest entry (F-72). The id must be valid (F-10);
 * description and usage start as TODO markers that `ssf validate` requires.
 */
export function generateScript(workspaceDir: string, skillDirs: string[], skill: string, id: string): { text: string } {
  if (!NAME_PATTERN.test(id) || id.length > 64) {
    throw new Error(`Invalid script id "${id}": lowercase letters, digits, dashes, 1-64 chars.`);
  }
  const skillDir = resolveSkillDir(skillDirs, skill);
  const entry = `src/${id}.ts`;
  const absolute = join(workspaceDir, skillDir, entry);
  if (exists(absolute)) {
    throw new Error(`Script file already exists: ${absolute}.`);
  }
  const manifestId = skillDir.split("/").pop() ?? skillDir;
  for (const file of renderScriptTemplate({ skill: manifestId, id })) {
    const full = join(workspaceDir, skillDir, "src", `${id}.ts`);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, file.content);
  }
  const { path, manifest } = readSkillManifest(workspaceDir, skillDir);
  manifest.scripts = manifest.scripts ?? [];
  if (manifest.scripts.some((script) => script.id === id)) {
    throw new Error(`Script entry already exists: ${id}.`);
  }
  manifest.scripts.push({
    id,
    entry,
    description: "TODO describe what the script does.",
    usage: "TODO describe arguments, for example <file> [--format json]",
    max_output_chars: 20000,
    timeout_seconds: 120,
  });
  writeSkillManifest(path, manifest);
  return { text: `Created script ${skillDir}/${entry} (id ${id}). Next: implement it, replace the TODO fields, then ssf validate.` };
}

/**
 * Scaffold a plugin module plus its contract test (F-73), and register the
 * module path in ssf.config.ts plugins when the array is detectable.
 */
export function generatePlugin(workspaceDir: string, name: string): { text: string; registered: boolean } {
  if (!NAME_PATTERN.test(name) || name.length > 64) {
    throw new Error(`Invalid plugin name "${name}": lowercase letters, digits, dashes, 1-64 chars.`);
  }
  const dir = join(workspaceDir, "plugins");
  const module = join(dir, `${name}.mjs`);
  if (exists(module)) {
    throw new Error(`Plugin module already exists: ${module}.`);
  }
  for (const file of renderPluginTemplate({ name })) {
    const full = join(dir, file.path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, file.content);
  }
  const registered = registerPluginInConfig(workspaceDir, `./plugins/${name}.mjs`);
  const next = registered
    ? "Next: implement the hooks, then run the contract test with bun test."
    : `Next: add "./plugins/${name}.mjs" to ssf.config.ts plugins, implement the hooks, then run the contract test.`;
  return { text: `Created plugin plugins/${name}.mjs with contract test. ${next}`, registered };
}

function registerPluginInConfig(workspaceDir: string, spec: string): boolean {
  const configPath = join(workspaceDir, "ssf.config.ts");
  let text: string;
  try {
    text = readFileSync(configPath, "utf8");
  } catch {
    return false;
  }
  const match = /plugins:\s*\[([^\]]*)\]/.exec(text);
  if (!match) {
    return false;
  }
  const entries = match[1] as string;
  if (entries.includes(`"${spec}"`) || entries.includes(`'${spec}'`)) {
    return true;
  }
  const separator = entries.trim().length === 0 ? "" : ", ";
  const replacement = `plugins: [${entries.trim()}${separator}"${spec}"]`;
  writeFileSync(configPath, text.replace(match[0], replacement));
  return true;
}
