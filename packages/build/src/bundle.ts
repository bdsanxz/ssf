// F-22: esbuild bundling without source maps.
// Each script id bundles from its entry into one self-contained unit, and
// the runtime loader bundles the same way. Shared files declared by the
// skill resolve through normal relative imports. Source maps are never
// emitted: script sources must not ship in any form.

import { build } from "esbuild";

export interface BundleResult {
  code: string;
  /** Workspace-relative inputs that were bundled, for declaration checks. */
  inputs: string[];
}

export interface BundleOptions {
  /** Directory that relative imports resolve from (usually the skill dir). */
  resolveDir: string;
  /** Workspace root, used to report inputs as workspace-relative paths. */
  workspaceDir?: string;
}

/** Bundle TypeScript/JavaScript source from an in-memory entry. */
export async function bundleSource(
  source: string,
  loader: "ts" | "js",
  options: BundleOptions,
): Promise<BundleResult> {
  return bundleEntries([{ contents: source, loader }], options);
}

/** Bundle one entry file plus everything it imports. */
export async function bundleEntryFile(entryFile: string, options: BundleOptions): Promise<BundleResult> {
  const result = await build({
    entryPoints: [entryFile],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    sourcemap: false,
    minify: false,
    write: false,
    metafile: true,
    absWorkingDir: options.resolveDir,
  });
  return toResult(result, options);
}

async function bundleEntries(
  stdinFiles: Array<{ contents: string; loader: "ts" | "js" }>,
  options: BundleOptions,
): Promise<BundleResult> {
  const [first, ...rest] = stdinFiles;
  if (!first || rest.length > 0) {
    throw new Error("Exactly one stdin entry is supported.");
  }
  const result = await build({
    stdin: { contents: first.contents, loader: first.loader, resolveDir: options.resolveDir },
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    sourcemap: false,
    minify: false,
    write: false,
    metafile: true,
  });
  return toResult(result, options);
}

function toResult(
  result: { outputFiles?: Array<{ text: string }>; metafile?: { inputs: Record<string, unknown> } },
  options: BundleOptions,
): BundleResult {
  const output = result.outputFiles?.[0]?.text;
  if (output === undefined) {
    throw new Error("Bundling produced no output.");
  }
  const inputs = Object.keys(result.metafile?.inputs ?? {});
  const base = (options.workspaceDir ?? options.resolveDir).replace(/\\/g, "/");
  const relative = inputs.map((absolute) => {
    const normalized = absolute.replace(/\\/g, "/");
    if (normalized.startsWith(`${base}/`)) {
      return normalized.slice(base.length + 1);
    }
    return normalized;
  });
  return { code: output, inputs: relative };
}
