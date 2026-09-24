import { describe, expect, it } from "vitest";
import type { Judgement } from "../../src/sort/types.js";

describe("sort types", () => {
  it("compiles a Judgement", () => {
    const j: Judgement = {
      summary: "s",
      tags: [],
      verdict: "keep",
      issues: [],
      reason: "r",
      spokenLine: null,
    };
    expect(j.verdict).toBe("keep");
  });
});
