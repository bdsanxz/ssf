// F-53 tests: in-memory execution.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFromMemory, sanitizeRunArgs, sanitizeScriptError } from "../src/exec.js";

describe("runFromMemory", () => {
  test("runs code with args and captures output", async () => {
    const result = await runFromMemory("console.log('hi ' + process.argv[2]);", {
      args: ["there"],
      timeoutMs: 5000,
      maxChars: 1000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hi there");
    expect(result.timedOut).toBe(false);
  });

  test("writes nothing to disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ssf-exec-"));
    const before = readdirSync(dir).length;
    await runFromMemory("console.log('x');", { args: [], timeoutMs: 5000, maxChars: 1000, cwd: dir });
    expect(readdirSync(dir).length).toBe(before);
    expect(existsSync(join(dir, "runtime.bin"))).toBe(false);
  });

  test("times out hanging scripts", async () => {
    const result = await runFromMemory("while (true) {}", { args: [], timeoutMs: 300, maxChars: 1000 });
    expect(result.timedOut).toBe(true);
  }, 10000);

  test("caps output with a truncation flag", async () => {
    const result = await runFromMemory("console.log('x'.repeat(5000));", {
      args: [],
      timeoutMs: 5000,
      maxChars: 100,
    });
    expect(result.truncated).toBe(true);
    expect(Array.from(result.stdout).length).toBe(100);
  });

  test("reports non-zero exits without throwing", async () => {
    const result = await runFromMemory("console.error('broken'); process.exit(3);", {
      args: [],
      timeoutMs: 5000,
      maxChars: 1000,
    });
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("broken");
  });
});

describe("sanitizeRunArgs", () => {
  test("drops node debug and loader flags", () => {
    expect(sanitizeRunArgs(["--inspect", "--", "a.pdf"])).toEqual(["a.pdf"]);
    expect(sanitizeRunArgs(["-r", "evil", "ok"])).toEqual(["ok"]);
    expect(sanitizeRunArgs(["--pages", "3", "--format", "csv"])).toEqual(["--pages", "3", "--format", "csv"]);
  });
});

describe("sanitizeScriptError", () => {
  test("keeps the message and drops stack frames", () => {
    const err = "ReferenceError: x is not defined\n    at foo ([stdin]:1:1)\n    at bar ([stdin]:2:1)";
    const clean = sanitizeScriptError(err);
    expect(clean).toContain("ReferenceError");
    expect(clean).not.toContain("at foo");
  });
});
