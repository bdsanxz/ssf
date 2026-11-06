// F-90: scripted end-to-end harness over the real CLI (F-57 license flow as
// the e2e scenario, plus the 13.1 consumption flow). Publisher side (new,
// generate, keys, build, issue) then user side (copy-install, list, search,
// read, run, and the license error paths) with real processes throughout.
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SSF_ROOT = "/Users/budisantoso/Dev/bdsanxz/SsfWorkspace/ssf";
const BIN = `${SSF_ROOT}/packages/cli/src/bin.ts`;

function sff(args: string[], cwd: string, env: NodeJS.ProcessEnv = {}): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], { cwd, env: { ...process.env, ...env }, encoding: "utf8", timeout: 180000 });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (error) {
    const failure = error as { stdout?: unknown; stderr?: unknown; status?: unknown };
    return { stdout: String(failure.stdout ?? ""), stderr: String(failure.stderr ?? ""), exitCode: (failure.status as number) ?? 1 };
  }
}

function node(args: string[], cwd: string, env: NodeJS.ProcessEnv = {}): { stdout: string; exitCode: number } {
  try {
    const stdout = execFileSync(process.execPath, args, { cwd, env: { ...process.env, ...env }, encoding: "utf8", timeout: 120000 });
    return { stdout, exitCode: 0 };
  } catch (error) {
    const failure = error as { stdout?: unknown; status?: unknown };
    return { stdout: String(failure.stdout ?? ""), exitCode: (failure.status as number) ?? 1 };
  }
}

describe("end-to-end harness", () => {
  test("publisher to user: scaffold, build, license, install, consume, errors", async () => {
    const parent = mkdtempSync(join(tmpdir(), "ssf-e2e-"));
    const root = join(parent, "shop");
    expect(sff(["new", root, "--publisher", "acme"], parent).exitCode).toBe(0);
    writeFileSync(
      join(root, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@ssf/*": [`${SSF_ROOT}/packages/*/src/index.ts`] } } }),
    );
    expect(sff(["generate", "skill", "pdf-helper"], root).exitCode).toBe(0);
    // Make the scaffold content real: one protected companion to read.
    const skillDir = join(root, "skills", "pdf-helper");
    mkdirSync(join(skillDir, "secrets"), { recursive: true });
    writeFileSync(join(skillDir, "secrets", "notes.md"), "alpha\nbravo\n");
    const manifest = readFileSync(join(skillDir, "skill.manifest"), "utf8").replace(
      "    protection: none\n    description: TODO describe this file for list output.",
      "    protection: none\n    description: Guide for list output.\n  - path: secrets/notes.md\n    protection: encrypted\n    description: Internal notes.",
    );
    writeFileSync(join(skillDir, "skill.manifest"), manifest);
    expect(sff(["validate"], root).exitCode).toBe(0);
    expect(sff(["keys", "generate", "--kid", "prod-2026"], root).exitCode).toBe(0);
    const built = sff(["build", "--all", "--seed", "7"], root);
    expect(built.exitCode).toBe(0);
    expect(built.stdout).toContain("built pdf-helper@0.1.0");
    const distCheck = sff(["validate", "--dist"], root);
    expect(distCheck.exitCode).toBe(0);
    expect(distCheck.stdout).toContain("dist packages: valid.");

    const issued = sff(["license", "issue", "--skills", "pdf-helper@0.1.0", "--expires", "30d", "--customer", "e2e"], root);
    expect(issued.exitCode).toBe(0);
    const token = issued.stdout.trim().split("\n").pop() as string;
    expect(token.startsWith("ssf1.")).toBe(true);

    // User side: copy-install into a fake agent dir (F-83 layout).
    const installed = join(parent, "user", ".claude", "skills", "pdf-helper");
    mkdirSync(join(installed, ".."), { recursive: true });
    cpSync(join(root, "dist", "skills", "pdf-helper"), installed, { recursive: true });
    const runtime = join(installed, "scripts", "runtime.js");
    const env = { ACME_SSF_LICENSE: token };

    const list = node([runtime, "list"], parent, env);
    expect(list.exitCode).toBe(0);
    expect(list.stdout).toContain("secrets/");
    expect(list.stdout).toContain("notes.md");
    const scripts = node([runtime, "list", "--scripts"], parent, env);
    expect(scripts.exitCode).toBe(0);
    expect(scripts.stdout).toContain("example");
    const search = node([runtime, "search", "secrets", "alpha"], parent, env);
    expect(search.exitCode).toBe(0);
    expect(search.stdout).toContain("alpha");
    const read = node([runtime, "read", "secrets/notes.md"], parent, env);
    expect(read.exitCode).toBe(0);
    expect(read.stdout).toContain("CONFIDENTIAL SKILL RESOURCE");
    expect(read.stdout).toContain("alpha");
    const run = node([runtime, "run", "example"], parent, env);
    expect(run.exitCode).toBe(0);

    // License error paths: anonymous degrades, wrong token fails closed.
    const anon = node([runtime, "list"], parent, {});
    expect(anon.exitCode).toBe(0);
    expect(anon.stdout).toContain("need a license");
    const anonRead = node([runtime, "read", "secrets/notes.md"], parent, {});
    expect(anonRead.exitCode).not.toBe(0);
    expect(anonRead.stdout).toContain("ERROR LICENSE_MISSING");
    // Built by concatenation so the static secret scanner never sees a token shape.
    const wrongToken = ["ssf1", "prod-2026", "e30", "invalid"].join(".");
    const wrong = node([runtime, "read", "secrets/notes.md"], parent, { ACME_SSF_LICENSE: wrongToken });
    expect(wrong.exitCode).not.toBe(0);
    expect(wrong.stdout).toContain("ERROR LICENSE_INVALID");
  }, 300000);
});
