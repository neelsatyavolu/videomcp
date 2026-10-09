import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cmdSort } from "../../src/sort/index.js";
import { tempDir } from "./helpers.js";

describe("cmdSort folder errors", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("names the missing folder, not an earlier flag value", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((msg?: unknown) => {
      errors.push(String(msg));
    });
    const code = await cmdSort(["--agent", "grok", "/no/such/footage-sort-dir"]);
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("Folder not found: /no/such/footage-sort-dir");
    expect(errors.join("\n")).not.toContain("Folder not found: grok");
  });

  it("says when the path is a file", async () => {
    const root = await tempDir();
    const file = path.join(root, "clip.mp4");
    await writeFile(file, "x");
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((msg?: unknown) => {
      errors.push(String(msg));
    });
    const code = await cmdSort([file]);
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain(`Not a folder: ${file}`);
  });
});
