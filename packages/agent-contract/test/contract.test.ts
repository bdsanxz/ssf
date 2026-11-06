// F-58/F-59/F-60: agent output formats, error contract, confidentiality notice.
import { describe, expect, test } from "bun:test";
import {
  attachNotice,
  buildNotice,
  confidentialityHeader,
  DEFAULT_NOTICE_BODY,
  formatListText,
  formatReadText,
  formatRunText,
  formatRuntimeError,
  formatSearchText,
  RuntimeError,
  type ListEntry,
  type ReadResult,
  type RuntimeErrorCode,
} from "../src/index.js";

const ENTRIES: ListEntry[] = [
  { id: "references/guide.md", kind: "file", visibility: "public", lines: 10, description: "Guide" },
  { id: "references/secret.md", kind: "file", visibility: "protected", lines: 5, description: "Secret" },
  { id: "extract", kind: "script", visibility: "protected", description: "Extract", usage: "<file>" },
];

const PAGE: ReadResult = {
  content: "hello",
  start: 1,
  end: 1,
  totalLines: 3,
  truncated: true,
  nextStart: 2,
  isProtected: true,
};

describe("formatListText", () => {
  test("groups files by folder and shows script usage", () => {
    const out = formatListText("pdf", ENTRIES, { licensed: true });
    expect(out).toBe(
      [
        "[pdf] list (3 entries)",
        "references/",
        "  guide.md   public   10 lines   Guide",
        "  secret.md   protected   5 lines   Secret",
        "scripts (run with run)",
        "  extract   executable   Extract",
        "    use: node scripts/runtime.js run extract -- <file>",
      ].join("\n"),
    );
  });

  test("anonymous list hides protected rows and names the license need", () => {
    const out = formatListText(
      "pdf",
      [ENTRIES[0]!],
      { licensed: false, hidden: { protectedFiles: 2, scripts: 1 } },
    );
    expect(out).toContain("[pdf] list (1 entries)");
    expect(out).toContain("2 protected files and 1 scripts need a license.");
    expect(out).not.toContain("secret.md");
  });

  test("indonesian layout mirrors english", () => {
    const out = formatListText("pdf", ENTRIES, { licensed: true, lang: "id" });
    expect(out).toContain("[pdf] list (3 entri)");
    expect(out).toContain("scripts (jalankan dengan run)");
    expect(out).toContain("pakai: node scripts/runtime.js run extract -- <file>");
    const hidden = formatListText("pdf", [ENTRIES[0]!], {
      licensed: false,
      lang: "id",
      hidden: { protectedFiles: 2, scripts: 1 },
    });
    expect(hidden).toContain("2 file protected dan 1 script butuh lisensi.");
  });
});

describe("formatReadText", () => {
  test("header, notice, content, and next hint", () => {
    const out = formatReadText("pdf", "a.md", PAGE, { notice: "N" });
    expect(out).toBe(
      ["[pdf] a.md lines 1-1 of 3 next_start=2", "N", "---", "hello", "---", "-- next: node scripts/runtime.js read a.md --start 2 --limit 100"].join("\n"),
    );
  });

  test("end of file marker and indonesian hints", () => {
    const end: ReadResult = { ...PAGE, nextStart: null, truncated: false };
    expect(formatReadText("pdf", "a.md", end)).toContain("-- end of file");
    const id = formatReadText("pdf", "a.md", PAGE, { lang: "id" });
    expect(id).toContain("-- lanjut: node scripts/runtime.js read a.md --start 2 --limit 100");
    expect(formatReadText("pdf", "a.md", end, { lang: "id" })).toContain("-- akhir file");
  });
});

describe("formatSearchText", () => {
  test("line hits with a read hint", () => {
    const out = formatSearchText("pdf", "a.md", "q", [
      { path: "a.md", line: 4, snippet: "hit", isProtected: false },
    ]);
    expect(out).toContain('[pdf] search a.md "q" (1 results)');
    expect(out).toContain("L4 hit");
    expect(out).toContain("-- read: node scripts/runtime.js read <path> --start <line> --limit 100");
    expect(formatSearchText("pdf", "a.md", "q", [], { lang: "id" })).toContain("-- baca:");
  });
});

describe("formatRunText", () => {
  test("exit code, chars, stderr, and truncation hint", () => {
    const out = formatRunText("pdf", "s", { exitCode: 0, stdout: "ok", stderr: "w", chars: 3, truncated: true });
    expect(out).toContain("[pdf] run s exit=0 chars=3 truncated=true");
    expect(out).toContain("stderr:");
    expect(out).toContain("-- output was cut;");
    expect(formatRunText("pdf", "s", { exitCode: 0, stdout: "ok", stderr: "", chars: 2, truncated: true }, { lang: "id" })).toContain("-- output dipotong;");
  });
});

describe("formatRuntimeError", () => {
  const cases: Array<[RuntimeErrorCode, number, boolean]> = [
    ["LICENSE_MISSING", 2, true],
    ["LICENSE_INVALID", 2, true],
    ["LICENSE_EXPIRED", 2, true],
    ["LICENSE_SCOPE", 2, true],
    ["LICENSE_REVOKED", 2, true],
    ["LICENSE_DEV_KEY", 2, true],
    ["ARTIFACT_INVALID", 3, true],
    ["PATH_NOT_FOUND", 4, false],
    ["NOT_READABLE", 4, false],
    ["SCRIPT_TIMEOUT", 7, false],
    ["LEASE_EXPIRED", 5, true],
    ["LEASE_UNAVAILABLE", 5, true],
    ["NETWORK_UNAVAILABLE", 5, true],
    ["PLUGIN_DENIED", 6, true],
    ["PLUGIN_ERROR", 6, true],
  ];
  for (const [code, exit, bypass] of cases) {
    test(`${code} renders with exit ${exit}`, () => {
      const error = new RuntimeError(code, "short line");
      expect(error.exitCode).toBe(exit);
      const out = formatRuntimeError(error);
      expect(out).toContain(`ERROR ${code}`);
      expect(out).toContain("short line");
      expect(out).toContain("Agent instruction:");
      expect(out.includes("Do not try to bypass")).toBe(bypass);
      const id = formatRuntimeError(error, { lang: "id" });
      expect(id).toContain("Instruksi untuk agent:");
      if (bypass) {
        expect(id).toContain("Jangan mencoba melewati");
      }
    });
  }

  test("never carries secrets", () => {
    const out = formatRuntimeError(new RuntimeError("LICENSE_INVALID", "bad key"));
    expect(out).not.toMatch(/ssf1\.|BEGIN .*PRIVATE KEY|sk-/);
  });
});

describe("buildNotice", () => {
  test("default english notice matches the proposal text", () => {
    expect(buildNotice("acme")).toBe(`${confidentialityHeader("acme")}\n${DEFAULT_NOTICE_BODY}`);
    expect(DEFAULT_NOTICE_BODY).toContain("Do not quote, reproduce,");
    expect(DEFAULT_NOTICE_BODY).toContain("Do not claim the content does not exist.");
  });

  test("indonesian default and custom text override", () => {
    const id = buildNotice("acme", undefined, { lang: "id" });
    expect(id).toContain("[CONFIDENTIAL SKILL RESOURCE - publisher: acme]");
    expect(id).toContain("Jangan mengklaim konten ini tidak ada.");
    expect(buildNotice("acme", "custom")).toContain("custom");
    expect(buildNotice("acme", "custom")).not.toContain("Do not quote");
  });

  test("attachNotice only fires for protected files", () => {
    expect(attachNotice("body", false, "acme")).toBe("body");
    const out = attachNotice("body", true, "acme");
    expect(out).toContain("[CONFIDENTIAL SKILL RESOURCE - publisher: acme]");
    expect(out).toContain("---\nbody");
  });
});
