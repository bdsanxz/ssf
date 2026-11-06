// F-52 tests: pagination and character caps.

import { describe, expect, test } from "bun:test";
import { paginateLines, splitLines, truncateChars } from "../src/paginate.js";

describe("splitLines", () => {
  test("normalizes CRLF", () => {
    expect(splitLines("a\r\nb\r\nc")).toEqual(["a", "b", "c"]);
  });
});

describe("paginateLines", () => {
  const lines = ["one", "two", "three", "four", "five"];

  test("pages 1-based with next_start", () => {
    const page = paginateLines(lines, 2, 2);
    expect(page.content).toBe("two\nthree");
    expect(page.start).toBe(2);
    expect(page.end).toBe(3);
    expect(page.totalLines).toBe(5);
    expect(page.truncated).toBe(true);
    expect(page.nextStart).toBe(4);
  });

  test("ends cleanly on the last page", () => {
    const page = paginateLines(lines, 4, 10);
    expect(page.content).toBe("four\nfive");
    expect(page.truncated).toBe(false);
    expect(page.nextStart).toBeNull();
  });

  test("caps a single call at 500 lines", () => {
    const many = Array.from({ length: 600 }, (_, i) => `line ${i}`);
    const page = paginateLines(many, 1, 100000);
    expect(page.content.split("\n").length).toBe(500);
    expect(page.nextStart).toBe(501);
  });
});

describe("truncateChars", () => {
  test("never splits surrogate pairs", () => {
    const text = `prefix ${"😀".repeat(10)} suffix`;
    const cut = truncateChars(text, 10);
    expect(cut.truncated).toBe(true);
    expect(Array.from(cut.text).length).toBe(10);
    expect(() => encodeURIComponent(cut.text)).not.toThrow();
  });

  test("passes short text through", () => {
    expect(truncateChars("hello", 100)).toEqual({ text: "hello", truncated: false });
  });
});
