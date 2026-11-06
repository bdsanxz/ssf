// Bin-level smoke tests: argv wiring for new/generate/validate/keys/license.
// A symlinked node_modules lets the generated ssf.config.ts (which imports
// @ssf/cli) load inside the temp workspace.
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SSF_ROOT = "/Users/budisantoso/Dev/bdsanxz/SsfWorkspace/ssf";
const BIN = `${SSF_ROOT}/packages/cli/src/bin.ts`;

function sff(args: string[], cwd: string): { stdout: string; exitCode: number } {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8", timeout: 120000 });
    return { stdout, exitCode: 0 };
  } catch (error) {
    const failure = error as { stdout?: unknown; status?: unknown };
    return { stdout: String(failure.stdout ?? ""), exitCode: (failure.status as number) ?? 1 };
  }
}

/**
 * Workspace links do not exist on disk (cross-package imports resolve
 * through tsconfig paths), so temp workspaces get a tsconfig that maps
 * @ssf/* back to the monorepo. Without it the generated ssf.config.ts
 * (which imports @ssf/cli) cannot load.
 */
function linkWorkspaceScope(root: string): void {
  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@ssf/*": [`${SSF_ROOT}/packages/*/src/index.ts`] } } }),
  );
}

describe("ssf bin", () => {
  test("--help lists the MVP commands", () => {
    const out = sff(["--help"], tmpdir());
    expect(out.exitCode).toBe(0);
    for (const command of ["ssf new", "generate skill", "generate reference", "generate script", "generate plugin", "plugins list", "ssf pack", "ssf unpack", "ssf validate", "ssf build", "ssf dev", "ssf keys generate", "ssf license issue", "ssf license revoke"]) {
      expect(out.stdout).toContain(command);
    }
  });

  test("new, generate, validate, keys, and license issue chain end to end", () => {
    const parent = mkdtempSync(join(tmpdir(), "ssf-bine2e-"));
    const root = join(parent, "shop");
    expect(sff(["new", root, "--publisher", "acme"], parent).exitCode).toBe(0);
    linkWorkspaceScope(root);
    expect(sff(["generate", "skill", "pdf-helper"], root).exitCode).toBe(0);
    expect(existsSync(join(root, "skills", "pdf-helper", "skill.manifest"))).toBe(true);
    const validated = sff(["validate"], root);
    expect(validated.stdout).toContain("workspace: valid.");
    expect(validated.exitCode).toBe(0);
    expect(sff(["keys", "generate", "--kid", "prod-2026"], root).exitCode).toBe(0);
    expect(sff(["keys", "lease", "--kid", "prod-2026"], root).exitCode).toBe(0);
    expect(sff(["keys", "lease"], root).exitCode).toBe(1);
    const issued = sff(["license", "issue", "--skills", "pdf-helper@0.1.0", "--expires", "7d", "--customer", "ref-9"], root);
    expect(issued.exitCode).toBe(0);
    expect(issued.stdout).toContain("ssf1.");
    const verified = sff(["license", "verify", issued.stdout.trim().split("\n").pop() as string, "--public-key-file", join(root, "keys", "prod-2026.license.pub.pem")], root);
    expect(verified.stdout).toContain("valid: true");
    expect(sff(["license", "revoke", "lic-1"], root).exitCode).toBe(0);
    expect(existsSync(join(root, "revoked.json"))).toBe(true);
    expect(sff(["frobnicate"], root).exitCode).toBe(1);
  }, 180000);

  test("generate reference/script/plugin and plugins list chain end to end", () => {
    const parent = mkdtempSync(join(tmpdir(), "ssf-bingen-"));
    const root = join(parent, "shop");
    expect(sff(["new", root, "--publisher", "acme"], parent).exitCode).toBe(0);
    linkWorkspaceScope(root);
    expect(sff(["generate", "skill", "pdf-helper"], root).exitCode).toBe(0);
    expect(sff(["generate", "reference", "pdf-helper", "topic"], root).exitCode).toBe(0);
    expect(existsSync(join(root, "skills", "pdf-helper", "references", "topic.md"))).toBe(true);
    expect(sff(["generate", "script", "pdf-helper", "run-it"], root).exitCode).toBe(0);
    expect(existsSync(join(root, "skills", "pdf-helper", "src", "run-it.ts"))).toBe(true);
    expect(sff(["generate", "plugin", "ssf-plugin-toc"], root).exitCode).toBe(0);
    expect(existsSync(join(root, "plugins", "ssf-plugin-toc.mjs"))).toBe(true);
    expect(existsSync(join(root, "plugins", "ssf-plugin-toc.contract.test.ts"))).toBe(true);
    const validated = sff(["validate"], root);
    expect(validated.stdout).toContain("workspace: valid.");
    expect(validated.exitCode).toBe(0);
    const listed = sff(["plugins", "list"], root);
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout).toContain("ssf-plugin-toc");
    expect(listed.stdout).toContain("local");
    expect(listed.stdout).toContain("api 1");
  }, 180000);
});
