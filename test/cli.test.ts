import { execFileSync } from "node:child_process";
import { symlink } from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { tempDir } from "./sort/helpers.js";

const repo = path.resolve(__dirname, "..");

describe("installed bin", () => {
  beforeAll(() => {
    execFileSync("npm", ["run", "-s", "build"], { cwd: repo });
  });

  it("runs a command once when invoked through a symlink named video-mcp", async () => {
    const bin = path.join(await tempDir(), "video-mcp");
    await symlink(path.join(repo, "dist", "index.js"), bin);
    const out = execFileSync("node", [bin, "version"], { encoding: "utf8" });
    expect(out.trim().split("\n")).toHaveLength(1);
  });
});
