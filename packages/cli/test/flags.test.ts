// F-75: flag value consumption at a single point, so values are never
// mistaken for positionals (`build --seed 7` targets no skill named "7").
import { describe, expect, test } from "bun:test";
import { positionals, takeFlag } from "../src/bin.js";

describe("takeFlag", () => {
  test("reads space and equals forms", () => {
    expect(takeFlag(["build", "--seed", "7"], "seed")).toBe("7");
    expect(takeFlag(["build", "--seed=8"], "seed")).toBe("8");
    expect(takeFlag(["build"], "seed")).toBeUndefined();
    expect(takeFlag(["--seed"], "seed")).toBeUndefined();
  });
});

describe("positionals", () => {
  test("skips values of value-flags", () => {
    expect(positionals(["--all", "--seed", "7", "--force"])).toEqual([]);
    expect(positionals(["demo", "--seed", "7"])).toEqual(["demo"]);
    expect(positionals(["--seed=8", "demo"])).toEqual(["demo"]);
    expect(positionals(["--seed", "7"])).toEqual([]);
    expect(positionals(["verify", "--public-key-file", "k.pem"], [])).toEqual(["verify"]);
  });
});
