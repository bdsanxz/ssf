// Text output formats for list/read/search/run (F-58 agent-readable).
// Layout: a header line explaining the result, then the content, then a
// follow-up hint. Newlines, truncation markers, and the hint commands are
// part of the contract: agent harnesses parse and display them.
//
// Language: English by default; Indonesian is available for publishers that
// serve Indonesian users. The layout is identical in both languages.

import type { ListEntry, ReadResult, RunResult, SearchResult } from "./results.js";

export type ContractLang = "en" | "id";

export interface FormatLanguage {
  lang?: ContractLang;
}

export interface HiddenCounts {
  protectedFiles: number;
  scripts: number;
}

const LIST_WORDS = {
  en: { entries: "entries", scripts: "scripts (run with run)", use: "use", needLicenseMany: (p: number, s: number) => `${p} protected files and ${s} scripts need a license.`, needLicense: "Protected files and scripts need a license." },
  id: { entries: "entri", scripts: "scripts (jalankan dengan run)", use: "pakai", needLicenseMany: (p: number, s: number) => `${p} file protected dan ${s} script butuh lisensi.`, needLicense: "File protected dan script butuh lisensi." },
} as const;

/** Render list output, grouping files by folder and scripts together. */
export function formatListText(
  skillId: string,
  entries: ListEntry[],
  options: { licensed: boolean; hidden?: HiddenCounts } & FormatLanguage = { licensed: true },
): string {
  const words = LIST_WORDS[options.lang ?? "en"];
  const files = entries.filter((entry) => entry.kind === "file").sort((a, b) => a.id.localeCompare(b.id));
  const scripts = entries.filter((entry) => entry.kind === "script").sort((a, b) => a.id.localeCompare(b.id));
  const lines = [`[${skillId}] list (${entries.length} ${words.entries})`];
  let currentDir = "";
  for (const file of files) {
    const dir = file.id.includes("/") ? file.id.slice(0, file.id.lastIndexOf("/") + 1) : "";
    if (dir !== currentDir) {
      lines.push(dir === "" ? "./" : dir);
      currentDir = dir;
    }
    const base = file.id.slice(dir.length);
    const detail = [base, file.visibility, file.lines !== undefined ? `${file.lines} lines` : "", file.description ?? ""]
      .filter((part) => part.length > 0)
      .join("   ");
    lines.push(`  ${detail}`);
  }
  if (scripts.length > 0) {
    lines.push(words.scripts);
    for (const script of scripts) {
      lines.push(`  ${script.id}   executable   ${script.description ?? ""}`);
      if (script.usage) {
        lines.push(`    ${words.use}: node scripts/runtime.js run ${script.id} -- ${script.usage}`);
      }
    }
  }
  if (!options.licensed) {
    const hidden = options.hidden;
    if (hidden && (hidden.protectedFiles > 0 || hidden.scripts > 0)) {
      lines.push(words.needLicenseMany(hidden.protectedFiles, hidden.scripts));
    } else {
      lines.push(words.needLicense);
    }
  }
  return lines.join("\n");
}

export interface ReadTextOptions extends FormatLanguage {
  notice?: string;
  runPrefix?: string;
}

/** Render read output with header, optional notice, and a follow-up hint. */
export function formatReadText(
  skillId: string,
  path: string,
  page: ReadResult,
  options: ReadTextOptions = {},
): string {
  const lang = options.lang ?? "en";
  const next = page.nextStart === null ? "end" : String(page.nextStart);
  const lines = [`[${skillId}] ${path} lines ${page.start}-${page.end} of ${page.totalLines} next_start=${next}`];
  if (options.notice) {
    lines.push(options.notice, "---");
  }
  lines.push(page.content, "---");
  const prefix = options.runPrefix ?? "node scripts/runtime.js";
  lines.push(
    page.nextStart === null
      ? lang === "id"
        ? "-- akhir file"
        : "-- end of file"
      : lang === "id"
        ? `-- lanjut: ${prefix} read ${path} --start ${page.nextStart} --limit 100`
        : `-- next: ${prefix} read ${path} --start ${page.nextStart} --limit 100`,
  );
  return lines.join("\n");
}

/** Render search output with line hits and a read follow-up hint. */
export function formatSearchText(
  skillId: string,
  path: string,
  query: string,
  results: SearchResult[],
  options: ReadTextOptions = {},
): string {
  const lang = options.lang ?? "en";
  const lines = [`[${skillId}] search ${path} "${query}" (${results.length} results)`];
  if (options.notice) {
    lines.push(options.notice, "---");
  }
  for (const result of results) {
    lines.push(`L${result.line} ${result.snippet}`);
  }
  lines.push(
    lang === "id"
      ? `-- baca: ${(options.runPrefix ?? "node scripts/runtime.js")} read <path> --start <baris> --limit 100`
      : `-- read: ${(options.runPrefix ?? "node scripts/runtime.js")} read <path> --start <line> --limit 100`,
  );
  return lines.join("\n");
}

/** Render run output with exit code, char count, and truncation hint. */
export function formatRunText(
  skillId: string,
  scriptId: string,
  result: RunResult,
  options: FormatLanguage = {},
): string {
  const head = `[${skillId}] run ${scriptId} exit=${result.exitCode} chars=${result.chars}${result.truncated ? " truncated=true" : ""}`;
  const lines = [head, result.stdout];
  if (result.stderr.length > 0) {
    lines.push("stderr:", result.stderr);
  }
  if (result.truncated) {
    lines.push(
      (options.lang ?? "en") === "id"
        ? "-- output dipotong; persempit permintaan (misalnya rentang halaman)."
        : "-- output was cut; narrow the request (for example a page range).",
    );
  }
  return lines.join("\n");
}
