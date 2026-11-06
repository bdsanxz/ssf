// F-47 CLI tests: parsing, errors, and output contracts.

import { describe, expect, test } from "bun:test";
import { executeCommand, parseArgv } from "../src/cli.js";
import { RuntimeError } from "@ssf/agent-contract";
import type { SkillRuntime } from "../src/api.js";

function stubRuntime(overrides: Partial<SkillRuntime> = {}): SkillRuntime {
  return {
    checkAccess: async () => ({ licensed: true }),
    list: async () => [],
    read: async () => ({ content: "", start: 1, end: 0, totalLines: 0, truncated: false, nextStart: null, isProtected: false }),
    search: async () => [],
    run: async () => ({ exitCode: 0, stdout: "", stderr: "", chars: 0, truncated: false }),
    extract: async (_path: string, options: { outFile: string }) => ({ outFile: options.outFile, bytes: 0 }),
    formatError: (error: unknown) =>
      error instanceof RuntimeError ? { text: `ERROR ${error.code}\n${error.message}`, exitCode: error.exitCode } : { text: "ERROR INTERNAL", exitCode: 1 },
    ...overrides,
  };
}

const CONTEXT = { skillId: "demo", publisher: "acme" };

describe("parseArgv", () => {
  test("parses list, read, search, and run forms", () => {
    expect(parseArgv(["list"]).command.name).toBe("list");
    expect(parseArgv(["list", "references/", "--scripts"]).command).toMatchObject({ name: "list", path: "references/", scripts: true });
    expect(parseArgv(["read", "a.md", "--start", "2", "--limit", "10"]).command).toMatchObject({ name: "read", path: "a.md", start: 2, limit: 10 });
    const search = parseArgv(["search", "a.md", "query text", "--json"]);
    expect(search.command).toMatchObject({ name: "search", path: "a.md", query: "query text", json: true });
    const run = parseArgv(["run", "extract-table", "--", "a.pdf", "--pages", "3"]);
    expect(run.command).toMatchObject({ name: "run", id: "extract-table", args: ["a.pdf", "--pages", "3"] });
  });

  test("rejects unknown commands with usage", () => {
    expect(() => parseArgv(["frobnicate"])).toThrow(RuntimeError);
    expect(() => parseArgv(["read"])).toThrow(RuntimeError);
    expect(() => parseArgv(["extract", "a.png"])).toThrow("--out");
  });

  test("parses the extract form", () => {
    expect(parseArgv(["extract", "assets/logo.png", "--out", "out/logo.png"]).command).toMatchObject({
      name: "extract",
      path: "assets/logo.png",
      out: "out/logo.png",
    });
  });
});

describe("executeCommand", () => {
  test("renders license errors with exit code 2", async () => {
    const runtime = stubRuntime({
      checkAccess: async () => ({ licensed: false }),
      list: async () => {
        throw new RuntimeError("LICENSE_MISSING", "Set a key.");
      },
    });
    const { text, exitCode } = await executeCommand(runtime, { name: "list", scripts: false, json: false, debug: false }, CONTEXT);
    expect(text.startsWith("ERROR LICENSE_MISSING")).toBe(true);
    expect(exitCode).toBe(2);
  });

  test("renders run results with exit passthrough", async () => {
    const runtime = stubRuntime({
      run: async () => ({ exitCode: 3, stdout: "out", stderr: "err", chars: 6, truncated: false }),
    });
    const { text, exitCode } = await executeCommand(runtime, { name: "run", id: "x", args: [], json: false, debug: false }, CONTEXT);
    expect(text).toContain("exit=3");
    expect(exitCode).toBe(3);
  });

  test("renders extract results with byte counts", async () => {
    const runtime = stubRuntime({
      extract: async (_path: string, options: { outFile: string }) => ({ outFile: options.outFile, bytes: 12 }),
    });
    const { text, exitCode } = await executeCommand(
      runtime,
      { name: "extract", path: "assets/logo.png", out: "out/logo.png", json: false, debug: false },
      CONTEXT,
    );
    expect(text).toBe("wrote 12 bytes to out/logo.png");
    expect(exitCode).toBe(0);
  });
});
