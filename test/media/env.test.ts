import { describe, expect, it } from "vitest";
import { numberFromEnv } from "../../src/constants.js";
import { runCli } from "../../src/cli.js";
import { cmdSetup } from "../../src/cli/setup.js";

describe("numberFromEnv", () => {
  it("keeps the default when the value is blank or not a finite number", () => {
    expect(numberFromEnv(undefined, 6)).toBe(6);
    expect(numberFromEnv("  ", 6)).toBe(6);
    expect(numberFromEnv("foo", 0.28)).toBe(0.28);
    expect(numberFromEnv("NaN", 8)).toBe(8);
    expect(numberFromEnv("12", 6)).toBe(12);
    expect(numberFromEnv("0", 6)).toBe(0);
  });
});

describe("setup model flag", () => {
  it("rejects an unknown whisper model before downloading", async () => {
    await expect(cmdSetup({ model: "huge", skipBrew: true })).rejects.toThrow(/Unknown whisper model/);
  });

  it("rejects --model without a value", async () => {
    const errors: string[] = [];
    const spy = console.error;
    console.error = (msg?: unknown) => {
      errors.push(String(msg));
    };
    const prev = process.exitCode;
    try {
      await runCli(["node", "video-mcp", "setup", "--model"]);
      expect(process.exitCode).toBe(1);
      expect(errors.join("\n")).toMatch(/--model needs a value/);
    } finally {
      console.error = spy;
      process.exitCode = prev;
    }
  });
});
