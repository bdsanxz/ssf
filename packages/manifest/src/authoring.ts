// F-61 authoring warnings (progressive disclosure, proposal 13.6).
// Pure checks over manifest data plus the SKILL.md text; the CLI wires
// these into `ssf validate` (F-74) alongside the structural validators.

export interface AuthoringFile {
  path: string;
  lines: number;
  /** Protection mode of the companion file. */
  protection: "none" | "obfuscated" | "encrypted";
  description?: string;
}

export interface AuthoringScript {
  id: string;
  description?: string;
  usage?: string;
  /** Source entry path (for link checks; scripts are never link targets). */
  entry?: string;
}

export interface AuthoringWarning {
  rule: "script-meta" | "protected-description" | "description-hint" | "long-file" | "skill-md-length" | "ssf-block-budget" | "dangling-link" | "protected-link";
  severity: "warning" | "error";
  message: string;
}

export interface AuthoringInput {
  skillMd: string;
  files: AuthoringFile[];
  scripts: AuthoringScript[];
  /** Relative public paths that exist in the package (for link checks). */
  publicPaths: string[];
}

const SKILL_MD_WARN_LINES = 300;
const SKILL_MD_MAX_LINES = 500;
const FILE_WARN_LINES = 500;
/**
 * Lines the builder adds to SKILL.md: frontmatter (~12) plus the generated
 * ssf block (~60, proposal 9.x). Source text must leave room for them.
 */
export const SSF_GENERATED_OVERHEAD_LINES = 72;

/** A description should say when to use the file, so the agent can pick. */
function hasUseCue(description: string): boolean {
  return /\b(when|use|used|usage|for|if)\b/i.test(description);
}

function isProtectedText(file: AuthoringFile): boolean {
  return file.protection === "encrypted" || file.protection === "obfuscated";
}

/** Extract relative markdown links: [text](target), skipping URLs/anchors. */
export function extractRelativeLinks(markdown: string): string[] {
  const found: string[] = [];
  const pattern = /\[[^\]]*\]\(([^)\s]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(markdown)) !== null) {
    const target = (match[1] ?? "").split("#")[0] ?? "";
    if (
      target.length === 0 ||
      target.startsWith("http://") ||
      target.startsWith("https://") ||
      target.startsWith("mailto:") ||
      target.startsWith("/") ||
      /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target)
    ) {
      continue;
    }
    found.push(target);
  }
  return found;
}

/** Check progressive-disclosure authoring rules; errors fail validation. */
export function checkAuthoring(input: AuthoringInput): AuthoringWarning[] {
  const warnings: AuthoringWarning[] = [];

  for (const script of input.scripts) {
    if (!script.description || !script.usage) {
      warnings.push({
        rule: "script-meta",
        severity: "error",
        message: `script "${script.id}" needs both description and usage; agents cannot read script source.`,
      });
    }
  }

  for (const file of input.files) {
    if (isProtectedText(file) && !file.description) {
      warnings.push({
        rule: "protected-description",
        severity: "warning",
        message: `protected file "${file.path}" has no description; agents cannot tell whether it is relevant without opening it.`,
      });
    } else if (file.description && !hasUseCue(file.description)) {
      warnings.push({
        rule: "description-hint",
        severity: "warning",
        message: `description of "${file.path}" does not say when to use the file; agents pick from list by description alone.`,
      });
    }
    if (file.lines > FILE_WARN_LINES && !/search/i.test(input.skillMd)) {
      warnings.push({
        rule: "long-file",
        severity: "warning",
        message: `file "${file.path}" has ${file.lines} lines; split it or add a search hint to SKILL.md.`,
      });
    }
  }

  const skillLines = input.skillMd.split("\n").length;
  if (skillLines > SKILL_MD_MAX_LINES - SSF_GENERATED_OVERHEAD_LINES && skillLines <= SKILL_MD_MAX_LINES) {
    warnings.push({
      rule: "ssf-block-budget",
      severity: "warning",
      message: `SKILL.md has ${skillLines} lines; the generated frontmatter and ssf block add ~${SSF_GENERATED_OVERHEAD_LINES}, leaving ${SKILL_MD_MAX_LINES - skillLines} lines before the ${SKILL_MD_MAX_LINES}-line built limit.`,
    });
  }
  if (skillLines > SKILL_MD_MAX_LINES) {
    warnings.push({
      rule: "skill-md-length",
      severity: "error",
      message: `SKILL.md has ${skillLines} lines (max ${SKILL_MD_MAX_LINES}); move detail into companion files.`,
    });
  } else if (skillLines > SKILL_MD_WARN_LINES) {
    warnings.push({
      rule: "skill-md-length",
      severity: "warning",
      message: `SKILL.md has ${skillLines} lines; keep it under ${SKILL_MD_WARN_LINES} and move detail into companion files.`,
    });
  }

  const known = new Set(input.publicPaths.map((path) => path.replace(/^\.\//, "")));
  // F-81: author text must never link to a protected file or a script.
  // Those targets are reached through list/read/run (files) and run <id>
  // (scripts); a direct link leaks their location and breaks the agent
  // contract, so it fails validation instead of warning.
  const forbidden = new Map<string, string>();
  for (const file of input.files) {
    if (isProtectedText(file)) {
      forbidden.set(file.path.replace(/^\.\//, ""), `protected file "${file.path}"`);
    }
  }
  for (const script of input.scripts) {
    if (script.entry) {
      forbidden.set(script.entry.replace(/^\.\//, ""), `script "${script.id}"`);
    }
    forbidden.set(script.id, `script "${script.id}"`);
  }
  for (const link of extractRelativeLinks(input.skillMd)) {
    const normalized = link.replace(/^\.\//, "");
    const target = forbidden.get(normalized);
    if (target) {
      warnings.push({
        rule: "protected-link",
        severity: "error",
        message: `SKILL.md links to ${target}; reach it through list/read/run instead of a direct link.`,
      });
    } else if (!known.has(normalized)) {
      warnings.push({
        rule: "dangling-link",
        severity: "warning",
        message: `SKILL.md links to "${link}", which is not a real file; protected files and scripts are reached through list/read/run.`,
      });
    }
  }

  return warnings;
}
