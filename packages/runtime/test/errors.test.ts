// Error contract and notice tests (F-59 subset needed by Sprint 5).

import { describe, expect, test } from "bun:test";
import { formatRuntimeError, RuntimeError, buildNotice } from "@ssf/agent-contract";

describe("formatRuntimeError", () => {
  test("renders code, message, instruction, and exit codes", () => {
    const text = formatRuntimeError(new RuntimeError("LICENSE_DEV_KEY", "Test keys rejected."));
    expect(text.startsWith("ERROR LICENSE_DEV_KEY")).toBe(true);
    expect(text).toContain("Agent instruction:");
    expect(text).toContain("bypass");
    expect(new RuntimeError("SCRIPT_TIMEOUT", "slow").exitCode).toBe(7);
    expect(new RuntimeError("ARTIFACT_INVALID", "bad").exitCode).toBe(3);
    expect(new RuntimeError("PATH_NOT_FOUND", "lost").exitCode).toBe(4);
  });
});

describe("buildNotice", () => {
  test("headers the publisher and defaults the body", () => {
    const notice = buildNotice("acme");
    expect(notice).toContain("[CONFIDENTIAL SKILL RESOURCE - publisher: acme]");
    expect(notice).toContain("complete the user's task");
    expect(buildNotice("acme", "Custom text.")).toContain("Custom text.");
  });
});
