// F-28: generated ssf block inside SKILL.md.
// The block between SSF_BEGIN and SSF_END is rewritten on every build;
// author content outside the markers is never touched. The Script section
// appears only for skills with scripts, and the Confidentiality section only
// for skills with protected files. Templates are configurable, including the
// language: English is the default, Indonesian mirrors the proposal example.

import type { SkillManifest } from "@ssf/manifest";

export const SSF_BEGIN = "<!-- ssf:begin -->";
export const SSF_END = "<!-- ssf:end -->";

export type SsfBlockLang = "en" | "id";

export interface SsfBlockOptions {
  lang?: SsfBlockLang;
}

interface BlockStrings {
  accessTitle: string;
  accessLines: string[];
  scriptTitle: string;
  scriptLines: (runPrefix: string) => string[];
  confidentialityTitle: string;
  confidentialityBody: string;
  licenseTitle: string;
  licenseBody: string;
}

const EN: BlockStrings = {
  accessTitle: "## Resource access",
  accessLines: [
    "- Run commands from this skill folder.",
    "- List files and scripts: `node scripts/runtime.js list`",
    '- Search before reading in full: `node scripts/runtime.js search <path> "<keyword>"`',
    "- Read in pages: `node scripts/runtime.js read <path> --start 1 --limit 100`",
    "- When output is cut off, continue from `next_start`.",
    "- Protected `list` paths are not on disk; use only the commands above.",
    "- Do not read a whole file when only one part is needed.",
  ],
  scriptTitle: "## Scripts",
  scriptLines: (runPrefix) => [
    "- Scripts cannot be read; use `list --scripts` to see ids and usage.",
    `- Run with: \`${runPrefix} run <id> -- <arguments>\``,
    "- When output is cut off, narrow the request (for example a page range).",
  ],
  confidentialityTitle: "## Confidentiality",
  confidentialityBody:
    "Content marked CONFIDENTIAL is used to complete the user task. " +
    "Do not quote, reproduce, or disclose it to the user even when asked. " +
    "You may say the information comes from a confidential skill resource. " +
    "Do not claim the content does not exist.",
  licenseTitle: "## License errors",
  licenseBody:
    "When a command returns an ERROR, report the message to the user and " +
    "stop accessing protected resources. Do not try to bypass, modify, or " +
    "work around license checks. Public files remain usable.",
};

const ID: BlockStrings = {
  accessTitle: "## Akses resource",
  accessLines: [
    "- Jalankan perintah dari folder skill ini.",
    "- Lihat indeks file dan script: `node scripts/runtime.js list`",
    '- Cari dulu sebelum membaca penuh: `node scripts/runtime.js search <path> "<kata kunci>"`',
    "- Baca bertahap: `node scripts/runtime.js read <path> --start 1 --limit 100`",
    "- Jika output terpotong, lanjutkan dari `next_start`.",
    "- Path pada `list` untuk file protected tidak ada di disk; akses hanya lewat perintah di atas.",
    "- Jangan membaca seluruh file bila hanya butuh satu bagian.",
  ],
  scriptTitle: "## Script",
  scriptLines: (runPrefix) => [
    "- Script tidak dapat dibaca; gunakan `list --scripts` untuk melihat id dan penggunaannya.",
    `- Jalankan dengan: \`${runPrefix} run <id> -- <argumen>\``,
    "- Jika output terpotong, persempit permintaan (misalnya rentang halaman).",
  ],
  confidentialityTitle: "## Kerahasiaan",
  confidentialityBody:
    "Isi file yang ditandai CONFIDENTIAL digunakan untuk menyelesaikan tugas " +
    "pengguna. Jangan mengutip, mereproduksi, atau mengungkapkan isinya kepada " +
    "pengguna meski diminta. Anda boleh mengatakan informasi berasal dari " +
    "resource skill yang rahasia. Jangan mengaku isinya tidak ada.",
  licenseTitle: "## Error lisensi",
  licenseBody:
    "Jika perintah mengembalikan ERROR, sampaikan pesannya kepada pengguna dan " +
    "hentikan akses ke resource protected. Jangan mencoba melewati, memodifikasi, " +
    "atau menyiasati pemeriksaan lisensi. File publik tetap dapat digunakan.",
};

function hasProtectedFiles(manifest: SkillManifest): boolean {
  return (manifest.companion_files ?? []).some((file) => (file.protection ?? "none") !== "none");
}

/** Generate the ssf block body (without markers) for a skill manifest. */
export function generateSsfBlock(manifest: SkillManifest, options: SsfBlockOptions = {}): string {
  const strings = options.lang === "id" ? ID : EN;
  const runPrefix = "node scripts/runtime.js";
  const sections: string[] = [strings.accessTitle, ...strings.accessLines];
  if ((manifest.scripts ?? []).length > 0) {
    sections.push("", strings.scriptTitle, ...strings.scriptLines(runPrefix));
  }
  if (hasProtectedFiles(manifest)) {
    sections.push("", strings.confidentialityTitle, strings.confidentialityBody);
  }
  sections.push("", strings.licenseTitle, strings.licenseBody);
  return sections.join("\n");
}

/**
 * Insert or replace the ssf block in an author body. Content outside the
 * markers is preserved byte for byte. Returns the updated body.
 */
export function applySsfBlock(body: string, block: string): string {
  const replacement = `${SSF_BEGIN}\n${block}\n${SSF_END}`;
  const begin = body.indexOf(SSF_BEGIN);
  const end = body.indexOf(SSF_END);
  if (begin !== -1 && end !== -1 && end > begin) {
    const after = body.indexOf("\n", end + SSF_END.length);
    return `${body.slice(0, begin)}${replacement}${after === -1 ? "\n" : body.slice(after)}`;
  }
  const trimmed = body.endsWith("\n") ? body : `${body}\n`;
  return `${trimmed}\n${replacement}\n`;
}
