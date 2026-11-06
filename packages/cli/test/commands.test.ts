// F-75/F-76/F-79: build, dev, license issue from the keys dir, ext hooks, revoke.
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeys } from "../src/keys.js";
import { licenseIssue, licenseRevoke, licenseVerify } from "../src/license.js";
import { buildCommand, devCommand } from "../src/buildCmd.js";
import { loadWorkspacePlugins } from "../src/plugins.js";
import type { SsfConfig } from "@ssf/manifest";

function config(): SsfConfig {
  return {
    workspace: { publisher: "acme", defaultMode: "offline" },
    license: { env: "ACME_SSF_LICENSE", configFile: "acme/license" },
    keys: { dir: "./keys", licenseKid: "prod-2026", artifactKid: "prod-2026", rootKid: "prod-2026" },
    limits: { defaultMaxLines: 500, defaultMaxChars: 40000, defaultScriptOutputChars: 20000, defaultScriptTimeoutSeconds: 120 },
    agent: { confidentialityNotice: { enabled: true } },
    build: { obfuscate: { scripts: true, runtime: true }, diversify: true },
    skills: ["skills/demo"],
    plugins: [],
  };
}

const MANIFEST = [
  "skill:",
  "  id: demo",
  "  version: 1.0.0",
  "  description: Demo skill for CLI tests. Use when testing builds.",
  "  license: Proprietary",
  "",
  "license:",
  "  mode: offline",
  "",
  "companion_files:",
  "  - path: references/guide.md",
  "    protection: none",
  "    description: Guide",
  "  - path: secrets/notes.md",
  "    protection: encrypted",
  "    description: Notes",
  "",
  "scripts:",
  "  - id: echo-args",
  "    entry: src/echo.ts",
  "    description: Echo back",
  "    usage: <words...>",
  "",
].join("\n");

function workspace(withPlugin?: string): { root: string; config: SsfConfig } {
  const root = mkdtempSync(join(tmpdir(), "ssf-cmd-"));
  const skill = join(root, "skills", "demo");
  mkdirSync(join(skill, "src"), { recursive: true });
  mkdirSync(join(skill, "references"), { recursive: true });
  mkdirSync(join(skill, "secrets"), { recursive: true });
  writeFileSync(join(skill, "skill.manifest"), MANIFEST);
  writeFileSync(join(skill, "SKILL.md"), "# Demo\n\nAuthor text.\n");
  writeFileSync(join(skill, "src", "echo.ts"), "console.log(JSON.stringify(process.argv.slice(2)));\n");
  writeFileSync(join(skill, "references", "guide.md"), "Guide.\n");
  writeFileSync(join(skill, "secrets", "notes.md"), "alpha\n");
  generateKeys({ dir: join(root, "keys"), kid: "prod-2026" });
  const cfg = config();
  if (withPlugin) {
    writeFileSync(join(root, "tenant-plugin.mjs"), withPlugin);
    cfg.plugins = ["./tenant-plugin.mjs"];
  }
  return { root, config: cfg };
}

describe("loadWorkspacePlugins", () => {
  test("resolves object and factory modules; rejects bad shapes", async () => {
    const root = mkdtempSync(join(tmpdir(), "ssf-plugload-"));
    writeFileSync(join(root, "ok.mjs"), "export default { name: 'ok', apiVersion: 1 };");
    writeFileSync(join(root, "factory.mjs"), "export default () => ({ name: 'made', apiVersion: 1 });");
    writeFileSync(join(root, "bad.mjs"), "export default { name: 'Bad_Name', apiVersion: 1 };");
    expect((await loadWorkspacePlugins(root, ["./ok.mjs", "./factory.mjs"])).map((plugin) => plugin.name)).toEqual(["ok", "made"]);
    await expect(loadWorkspacePlugins(root, ["./missing.mjs"])).rejects.toThrow("Cannot load plugin");
    await expect(loadWorkspacePlugins(root, ["./bad.mjs"])).rejects.toThrow("invalid");
  });
});

describe("license issue from keys dir", () => {
  test("issues and verifies without explicit key files; ext hooks apply", async () => {
    const { root, config: cfg } = workspace(
      "export default { name: 'tenant', apiVersion: 1, build: { issueLicense: async (draft) => ({ ext: { ...draft.ext, tenant: 'acme' } }) } };",
    );
    const { token } = await licenseIssue(
      { skills: ["demo@1.0.0"], expires: "7d", customer: "ref-1", extJson: '{"team":"docs"}' },
      { workspaceDir: root, config: cfg },
    );
    expect(token.startsWith("ssf1.")).toBe(true);
    const { text } = licenseVerify(token, { publicKeyFile: join(root, "keys", "prod-2026.license.pub.pem") });
    expect(text).toContain("valid: true");
    const payload = JSON.parse(Buffer.from(token.split(".")[2] as string, "base64url").toString("utf8")) as { ext: Record<string, string> };
    expect(payload.ext).toMatchObject({ tenant: "acme", team: "docs" });
    expect(readFileSync(join(root, "issued.jsonl"), "utf8")).toContain("ref-1");
  });

  test("revoke appends to the workspace revocation list", () => {
    const { root, config: cfg } = workspace();
    const { text } = licenseRevoke("lic-1", {}, { workspaceDir: root, config: cfg });
    expect(text).toContain("revoked: lic-1 (1 total)");
    expect(text).toContain(join(root, "revoked.json"));
  });

  test("issueLicense plugins may only add ext claims", async () => {
    const { root, config: cfg } = workspace(
      "export default { name: 'greedy', apiVersion: 1, build: { issueLicense: async (draft) => ({ ...draft, skills: ['other'] }) } };",
    );
    await expect(
      licenseIssue({ skills: ["demo@1.0.0"], expires: "7d" }, { workspaceDir: root, config: cfg }),
    ).rejects.toThrow("may only add ext claims");
  });
});

describe("build and dev commands", () => {
  test("release build writes dist and prints the plugin summary", async () => {
    const { root, config: cfg } = workspace();
    const { text } = await buildCommand(root, cfg, {});
    expect(text).toContain("built demo@1.0.0");
    expect(text).toContain("codec-default");
    expect(text).toContain("license-source-env, license-source-file");
  }, 180000);

  test("plugin summary shows each plugin with its capabilities", async () => {
    const { root, config: cfg } = workspace(
      "export default { name: 'tenant', apiVersion: 1, capabilities: ['network'], build: { transformSource: async (_c, code) => code } };",
    );
    const { text } = await buildCommand(root, cfg, {});
    expect(text).toContain("codec-default");
    expect(text).toContain("tenant [network]");
  }, 180000);

  test("third-party plain-JS plugin loads from config and transforms the build (F-68)", async () => {
    // Exactly what a published ssf-plugin-* package ships: plain JavaScript,
    // no framework imports, default-exported object.
    const { root, config: cfg } = workspace();
    writeFileSync(
      join(root, "ssf-plugin-shout.mjs"),
      "export default {\n" +
        "  name: 'ssf-plugin-shout',\n" +
        "  apiVersion: 1,\n" +
        "  build: {\n" +
        "    transformSource: async (context, code) =>\n" +
        "      context.path.endsWith('echo.ts') ? code.replace('JSON.stringify', 'String') : code,\n" +
        "  },\n" +
        "};\n",
    );
    cfg.plugins = ["./ssf-plugin-shout.mjs"];
    const { text } = await buildCommand(root, cfg, {});
    expect(text).toContain("ssf-plugin-shout");
    const { token } = await licenseIssue({ skills: ["demo@1.0.0"], expires: "7d" }, { workspaceDir: root, config: cfg });
    const out = execFileSync(
      process.execPath,
      [join(root, "dist", "skills", "demo", "scripts", "runtime.js"), "run", "echo-args", "--", "hi"],
      { cwd: tmpdir(), env: { ...process.env, ACME_SSF_LICENSE: token }, encoding: "utf8", timeout: 60000 },
    );
    expect(out).toContain("hi");
    expect(out).not.toContain('["hi"]');
  }, 300000);

  test("per-customer flags validate before any key loading (F-93)", async () => {
    const { root, config: cfg } = workspace();
    await expect(buildCommand(root, cfg, { customer: "acme-corp" })).rejects.toThrow(
      "--customer <ref> and --root-secret-file",
    );
    await expect(buildCommand(root, cfg, { rootSecretFile: join(root, "keys", "x.hex") })).rejects.toThrow(
      "needs --customer",
    );
    await expect(buildCommand(root, cfg, { customer: "../evil", rootSecretFile: join(root, "keys", "x.hex") })).rejects.toThrow(
      "safe reference",
    );
  });

  test("dev build runs the installed runtime with a dev license", async () => {
    const { root, config: cfg } = workspace();
    const { text } = await devCommand(root, cfg, "demo");
    expect(text).toContain("DEV BUILD");
    expect(text).toContain("references/");
  }, 180000);
});
