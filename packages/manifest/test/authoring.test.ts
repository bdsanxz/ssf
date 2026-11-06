// F-61 authoring warnings (progressive disclosure).
import { describe, expect, test } from "bun:test";
import { checkAuthoring, extractRelativeLinks } from "../src/authoring.js";

describe("checkAuthoring", () => {
  test("clean skill reports nothing", () => {
    expect(
      checkAuthoring({
        skillMd: "# Skill\nUse search before read.\n",
        files: [{ path: "references/a.md", lines: 10, protection: "encrypted", description: "Doc for picking. Use when testing." }],
        scripts: [{ id: "run-it", description: "Runs", usage: "<file>" }],
        publicPaths: ["SKILL.md", "references/a.md"],
      }),
    ).toEqual([]);
  });

  test("description without a when-to-use cue warns", () => {
    const warnings = checkAuthoring({
      skillMd: "",
      files: [{ path: "a.md", lines: 5, protection: "none", description: "Misc notes" }],
      scripts: [],
      publicPaths: [],
    });
    expect(warnings.map((warning) => warning.rule)).toEqual(["description-hint"]);
  });

  test("ssf block budget warns near the built limit", () => {
    const near = `# Skill\n${"text\n".repeat(440)}`;
    const warnings = checkAuthoring({ skillMd: near, files: [], scripts: [], publicPaths: [] });
    expect(warnings.some((warning) => warning.rule === "ssf-block-budget")).toBe(true);
    expect(warnings.some((warning) => warning.rule === "skill-md-length" && warning.severity === "warning")).toBe(true);
    const roomy = checkAuthoring({ skillMd: "# Skill\nshort\n", files: [], scripts: [], publicPaths: [] });
    expect(roomy.some((warning) => warning.rule === "ssf-block-budget")).toBe(false);
  });

  test("script without description or usage is an error", () => {
    const warnings = checkAuthoring({
      skillMd: "",
      files: [],
      scripts: [{ id: "run-it", description: "Runs" }],
      publicPaths: [],
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.severity).toBe("error");
    expect(warnings[0]!.rule).toBe("script-meta");
  });

  test("protected file without description warns; public files stay quiet", () => {
    const warnings = checkAuthoring({
      skillMd: "",
      files: [
        { path: "secret.md", lines: 5, protection: "encrypted" },
        { path: "open.md", lines: 5, protection: "none" },
      ],
      scripts: [],
      publicPaths: [],
    });
    expect(warnings.map((warning) => warning.rule)).toEqual(["protected-description"]);
  });

  test("long files need a search hint; long SKILL.md escalates", () => {
    const noHint = checkAuthoring({
      skillMd: "# Skill\n",
      files: [{ path: "big.md", lines: 600, protection: "none" }],
      scripts: [],
      publicPaths: [],
    });
    expect(noHint.some((warning) => warning.rule === "long-file")).toBe(true);

    const longSkill = checkAuthoring({
      skillMd: `${"# Skill\n" + "text\n".repeat(350)}`,
      files: [],
      scripts: [],
      publicPaths: [],
    });
    expect(longSkill.some((warning) => warning.rule === "skill-md-length" && warning.severity === "warning")).toBe(true);

    const tooLong = checkAuthoring({
      skillMd: `${"# Skill\n" + "text\n".repeat(600)}`,
      files: [],
      scripts: [],
      publicPaths: [],
    });
    expect(tooLong.some((warning) => warning.rule === "skill-md-length" && warning.severity === "error")).toBe(true);
  });

  test("links to protected files or scripts are errors", () => {
    const findings = checkAuthoring({
      skillMd: "See [secret](secrets/s.md), [code](src/run.ts), [tool](run-it), and [ok](yes.md).",
      files: [{ path: "secrets/s.md", lines: 5, protection: "encrypted", description: "Secret; use when testing." }],
      scripts: [{ id: "run-it", description: "Runs", usage: "<x>", entry: "src/run.ts" }],
      publicPaths: ["SKILL.md", "yes.md"],
    });
    const errors = findings.filter((finding) => finding.severity === "error");
    expect(errors.map((finding) => finding.rule)).toEqual(["protected-link", "protected-link", "protected-link"]);
    expect(errors[0]!.message).toContain("secrets/s.md");
  });

  test("dangling relative links warn; urls and anchors are ignored", () => {
    expect(extractRelativeLinks("[a](https://x.test) [b](#top) [c](real.md)")).toEqual(["real.md"]);
    const warnings = checkAuthoring({
      skillMd: "[missing](nope.md) [real](yes.md)",
      files: [],
      scripts: [],
      publicPaths: ["SKILL.md", "yes.md"],
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toContain("nope.md");
  });
});
