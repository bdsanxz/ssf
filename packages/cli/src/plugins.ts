// Workspace plugin loading (F-63/F-64): config lists module specifiers,
// each resolving to a plugin object or a zero-arg factory. Option factories
// (kmsKeys({...})) cannot be expressed as bare specifiers, so publishers
// call those in a local module that re-exports the result.

import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { normalizePlugin, validatePlugin, type SsfPlugin, type SsfPluginInput } from "@ssf/plugin-api";

function specifierToUrl(workspaceDir: string, spec: string): string {
  if (spec.startsWith(".") || isAbsolute(spec)) {
    return pathToFileURL(join(workspaceDir, spec)).href;
  }
  return spec;
}

export interface PluginListEntry {
  spec: string;
  name: string;
  version: string;
  apiVersion: number;
  capabilities: string[];
}

function packageVersion(workspaceDir: string, spec: string): string {
  if (spec.startsWith(".") || isAbsolute(spec)) {
    return "local";
  }
  try {
    const manifest = join(workspaceDir, "node_modules", spec, "package.json");
    if (!statSync(manifest).isFile()) {
      return "unknown";
    }
    const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.length > 0 ? parsed.version : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Describe every configured plugin for audit (F-80): the config spec, the
 * loaded name, the package version (`local` for workspace files), the
 * plugin apiVersion, and the declared capabilities.
 */
export async function listWorkspacePlugins(workspaceDir: string, specs: string[]): Promise<PluginListEntry[]> {
  const plugins = await loadWorkspacePlugins(workspaceDir, specs);
  return plugins.map((plugin, index) => ({
    spec: specs[index] as string,
    name: plugin.name,
    version: packageVersion(workspaceDir, specs[index] as string),
    apiVersion: plugin.apiVersion,
    capabilities: [...(plugin.capabilities ?? [])],
  }));
}

/** Import, normalize, and validate every configured plugin. */
export async function loadWorkspacePlugins(workspaceDir: string, specs: string[]): Promise<SsfPlugin[]> {
  const plugins: SsfPlugin[] = [];
  for (const spec of specs) {
    let exported: unknown;
    try {
      const module = (await import(specifierToUrl(workspaceDir, spec))) as Record<string, unknown>;
      exported = (module["default"] ?? module["plugin"]) as unknown;
    } catch (error) {
      throw new Error(`Cannot load plugin "${spec}": ${error instanceof Error ? error.message : String(error)}`);
    }
    let plugin: SsfPlugin;
    try {
      plugin = normalizePlugin(exported as SsfPluginInput);
    } catch {
      throw new Error(`Plugin "${spec}" must export a plugin object or a zero-arg factory. Call option factories before re-exporting them.`);
    }
    const problems = validatePlugin(plugin);
    if (problems.length > 0) {
      throw new Error(`Plugin "${spec}" is invalid: ${problems.join("; ")}`);
    }
    plugins.push(plugin);
  }
  return plugins;
}
