// @ssf/templates - plain file templates with name substitution (F-89).
// Generators are dumb file writes: no logic, no network, deterministic bytes
// for the same inputs. Placeholders use {{name}}, {{publisher}}, {{env}}.

export interface SkillTemplateVars {
  name: string;
  publisher: string;
  env: string;
}

export interface WorkspaceTemplateVars {
  workspace: string;
  publisher: string;
  env: string;
}

function substitute(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => vars[key] ?? match);
}

const WORKSPACE_CONFIG_TEMPLATE = `// ssf workspace config. This file is executed code (like vite.config.ts);
// do not run ssf in a workspace you do not trust.
import { defineConfig } from '@ssf/cli';

export default defineConfig({
  workspace: { publisher: '{{publisher}}', defaultMode: 'offline' },

  license: {
    env: '{{env}}',
    configFile: '{{publisher}}/license',
  },

  keys: {
    dir: './keys',
    licenseKid: 'prod-2026',
    artifactKid: 'prod-2026',
    rootKid: 'prod-2026',
    // leaseKid: 'prod-2026', // online mode only: embeds the lease key
  },

  limits: {
    defaultMaxLines: 500,
    defaultMaxChars: 40000,
    defaultScriptOutputChars: 20000,
    defaultScriptTimeoutSeconds: 120,
  },

  agent: {
    confidentialityNotice: { enabled: true, text: undefined },
    allowedTools: undefined,
  },

  build: {
    obfuscate: { scripts: true, runtime: true },
    diversify: true,
  },

  skills: [],

  plugins: [],
});
`;

const WORKSPACE_GITIGNORE_TEMPLATE = `# Publisher secrets: never commit key material.
keys/
dist/
node_modules/
`;

const SKILL_MANIFEST_TEMPLATE = `skill:
  id: {{name}}
  version: 0.1.0
  description: TODO describe what the skill does and when to use it.
  license: Proprietary
  metadata: {}

license:
  mode: offline

limits:
  default_max_lines: 500
  default_max_chars: 40000

shared: []

companion_files:
  - path: references/guide.md
    protection: none
    description: TODO describe this file for list output.

scripts:
  - id: example
    entry: src/example.ts
    description: TODO describe what the script does.
    usage: TODO describe arguments, for example <file> [--format json]
    max_output_chars: 20000
    timeout_seconds: 120

exclude: []
`;

const SKILL_MD_TEMPLATE = `# {{name}}

TODO: short instructions for the agent. Keep this file short; put detail in
companion files. Use search before read.
`;

const SKILL_SRC_TEMPLATE = `// Example script for {{name}}.
// Scripts are execute-only: agents run them by id, never read them.
const args = process.argv.slice(2);
console.log(JSON.stringify({ args }));
`;

const SKILL_GUIDE_TEMPLATE = `# Guide

TODO: public guide for {{name}}.
`;

const SKILL_TEST_TEMPLATE = `// Smoke test for the {{name}} skill source.
// Run with: bun test test/smoke.test.ts
// Extend this file with checks that fit the skill (link targets, script
// usage strings, companion descriptions).
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

function manifestText(): string {
  return readFileSync(join(SKILL_DIR, "skill.manifest"), "utf8");
}

describe("{{name}} skill source", () => {
  test("manifest id matches the skill directory", () => {
    expect(manifestText()).toContain("id: {{name}}");
  });

  test("companion files listed in the manifest exist", () => {
    const listed = [...manifestText().matchAll(/path:\\s*(\\S+)/g)].map((match) => match[1] as string);
    expect(listed.length).toBeGreaterThan(0);
    for (const path of listed) {
      expect(existsSync(join(SKILL_DIR, path))).toBe(true);
    }
  });

  test("SKILL.md names the skill", () => {
    expect(readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8")).toContain("# {{name}}");
  });
});
`;

export interface TemplateFile {
  path: string;
  content: string;
}

export interface ReferenceTemplateVars {
  skill: string;
  name: string;
}

export interface ScriptTemplateVars {
  skill: string;
  id: string;
}

export interface PluginTemplateVars {
  name: string;
}

const REFERENCE_TEMPLATE = `# {{name}}

TODO: companion notes for {{skill}}. Keep this file focused; the agent finds
it through list output, so the manifest description must say when to read it.
`;

const SCRIPT_TEMPLATE = `// {{id}} script for {{skill}}.
// Scripts are execute-only: agents run them by id, never read them.
const args = process.argv.slice(2);
console.log(JSON.stringify({ args }));
`;

const PLUGIN_TEMPLATE = `// {{name}}: example SSF plugin (plain JavaScript, no framework imports).
// Hooks run through the same runner as builtins: throw, timeout, or an
// invalid return denies the operation. See docs/plugins.md.
export default {
  name: "{{name}}",
  apiVersion: 1,
  capabilities: [],
  build: {
    transformSource: async (context, code) => code,
  },
  runtime: {
    verifyLicense: async () => {},
  },
};
`;

const PLUGIN_TEST_TEMPLATE = `// Contract test for the {{name}} plugin (F-73).
// Run with: bun test plugins/{{name}}.contract.test.ts
// Needs @ssf/plugin-api resolvable (bun add -D @ssf/plugin-api), because the
// contract suite is the same one the build runs before accepting a plugin.
import { describe, expect, test } from "bun:test";
import { runContractTests, validatePlugin } from "@ssf/plugin-api";
import plugin from "./{{name}}.mjs";

describe("{{name}} plugin contract", () => {
  test("shape is valid and every registered hook passes", async () => {
    expect(validatePlugin(plugin)).toEqual([]);
    const results = await runContractTests(plugin);
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((result) => result.passed)).toBe(true);
  });
});
`;

/** Render a new workspace: ssf.config.ts plus an ignoring .gitignore. */
export function renderWorkspaceTemplate(vars: WorkspaceTemplateVars): TemplateFile[] {
  const mapping = { workspace: vars.workspace, publisher: vars.publisher, env: vars.env };
  return [
    { path: "ssf.config.ts", content: substitute(WORKSPACE_CONFIG_TEMPLATE, mapping) },
    { path: ".gitignore", content: WORKSPACE_GITIGNORE_TEMPLATE },
  ];
}

/** Render a companion file stub for `ssf generate reference`. */
export function renderReferenceTemplate(vars: ReferenceTemplateVars): TemplateFile[] {
  return [{ path: `${vars.name}.md`, content: substitute(REFERENCE_TEMPLATE, { skill: vars.skill, name: vars.name }) }];
}

/** Render a script stub for `ssf generate script`. */
export function renderScriptTemplate(vars: ScriptTemplateVars): TemplateFile[] {
  return [{ path: `${vars.id}.ts`, content: substitute(SCRIPT_TEMPLATE, { skill: vars.skill, id: vars.id }) }];
}

/** Render a plugin module plus its contract test for `ssf generate plugin`. */
export function renderPluginTemplate(vars: PluginTemplateVars): TemplateFile[] {
  const mapping = { name: vars.name };
  return [
    { path: `${vars.name}.mjs`, content: substitute(PLUGIN_TEMPLATE, mapping) },
    { path: `${vars.name}.contract.test.ts`, content: substitute(PLUGIN_TEST_TEMPLATE, mapping) },
  ];
}

/** Render a new skill scaffold with one example script and a smoke test. */
export function renderSkillTemplate(vars: SkillTemplateVars): TemplateFile[] {
  const mapping = { name: vars.name, publisher: vars.publisher, env: vars.env };
  return [
    { path: "skill.manifest", content: substitute(SKILL_MANIFEST_TEMPLATE, mapping) },
    { path: "SKILL.md", content: substitute(SKILL_MD_TEMPLATE, mapping) },
    { path: "src/example.ts", content: substitute(SKILL_SRC_TEMPLATE, mapping) },
    { path: "references/guide.md", content: substitute(SKILL_GUIDE_TEMPLATE, mapping) },
    { path: "test/smoke.test.ts", content: substitute(SKILL_TEST_TEMPLATE, mapping) },
  ];
}
