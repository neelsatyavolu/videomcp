import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ADAPTERS, createAsk, selectAgent } from "../../src/sort/agents/index.js";
import { killRunning, runProcess, type RunResult, type Runner } from "../../src/sort/agents/run.js";
import { tempDir } from "./helpers.js";

const fixture = (name: string) => readFileSync(path.join(__dirname, "fixtures", name), "utf8");
const ok = (stdout: string): RunResult => ({ stdout, stderr: "", code: 0, timedOut: false });

function fakeRunner(handler: (cmd: string, args: readonly string[]) => RunResult) {
  const calls: { cmd: string; args: readonly string[]; cwd: string }[] = [];
  const run: Runner = async (cmd, args, o) => {
    calls.push({ cmd, args, cwd: o.cwd });
    return handler(cmd, args);
  };
  return { run, calls };
}

describe("claude adapter", () => {
  it("runs restricted, read-only, with image dirs added", async () => {
    const inv = await ADAPTERS.claude.build(
      { prompt: "P", images: ["/f/a/1.jpg", "/f/a/2.jpg", "/f/b/3.jpg"], cwd: "/f/a", model: "haiku" },
      [],
    );
    expect(inv.cmd).toBe("claude");
    expect(inv.args).toEqual([
      "-p", "--output-format", "json", "--restricted", "--tools", "Read", "--strict-mcp-config",
      "--add-dir", "/f/a", "--add-dir", "/f/b", "--model", "haiku", "P",
    ]);
    expect(ADAPTERS.claude.imageMode).toBe("paths");
  });

  it("parses the result text and surfaces errors", () => {
    expect(ADAPTERS.claude.parse(fixture("claude-success.json"))).toBe('{"ok":true}');
    expect(() => ADAPTERS.claude.parse('{"is_error":true,"result":"Not logged in"}')).toThrow(/Not logged in/);
    expect(() => ADAPTERS.claude.parse("garbage")).toThrow(/unreadable/);
  });
});

describe("codex adapter", () => {
  it("disables enabled MCP servers in prepare", async () => {
    const { run } = fakeRunner(() =>
      ok(JSON.stringify([{ name: "video", enabled: true }, { name: "old", enabled: false }])),
    );
    expect(await ADAPTERS.codex.prepare!(run, "/tmp")).toEqual([
      "-c", "features.plugins=false", "-c", "mcp_servers.video.enabled=false",
    ]);
  });

  it("attaches images with -i and puts the prompt after --", async () => {
    const inv = await ADAPTERS.codex.build({ prompt: "P", images: ["/a.jpg", "/b.jpg"], cwd: "/tmp" }, ["-c", "x=1"]);
    expect(inv.args).toEqual([
      "exec", "--json", "--ephemeral", "--skip-git-repo-check", "-c", 'sandbox_mode="read-only"', "-c", "x=1",
      "-i", "/a.jpg", "-i", "/b.jpg", "--", "P",
    ]);
    const withModel = await ADAPTERS.codex.build({ prompt: "P", images: [], cwd: "/tmp", model: "gpt-x" }, []);
    expect(withModel.args).toContain("-m");
  });

  it("parses the last agent message and surfaces turn failures", () => {
    expect(ADAPTERS.codex.parse(fixture("codex-success.jsonl"))).toBe('{"color":"red"}');
    expect(() => ADAPTERS.codex.parse('{"type":"turn.failed","error":{"message":"quota"}}')).toThrow(/quota/);
    expect(() => ADAPTERS.codex.parse('{"type":"thread.started"}')).toThrow(/no answer/);
  });
});

describe("grok adapter", () => {
  it("sends text plus base64 image blocks and read-only tools", async () => {
    const dir = await tempDir();
    const img = path.join(dir, "f.jpg");
    await writeFile(img, Buffer.from([1, 2, 3]));
    const inv = await ADAPTERS.grok.build({ prompt: "P", images: [img], cwd: dir }, []);
    expect(inv.cmd).toBe("grok");
    const blocks = JSON.parse(inv.args[inv.args.indexOf("--prompt-json") + 1]!);
    expect(blocks).toEqual([
      { type: "text", text: "P" },
      { type: "image", mimeType: "image/jpeg", data: "AQID" },
    ]);
    expect(inv.args).toContain("--disable-web-search");
    expect(inv.args.join(" ")).toContain("--disallowed-tools Agent,search_tool,use_tool");
  });

  it("drops images beyond the payload budget", async () => {
    const dir = await tempDir();
    const big = path.join(dir, "big.jpg");
    await writeFile(big, Buffer.alloc(400_000));
    const inv = await ADAPTERS.grok.build({ prompt: "P", images: [big, big, big], cwd: dir }, []);
    const blocks = JSON.parse(inv.args[inv.args.indexOf("--prompt-json") + 1]!) as unknown[];
    expect(blocks).toHaveLength(2);
  });

  it("parses the result event", () => {
    expect(ADAPTERS.grok.parse(fixture("grok-success.jsonl"))).toBe('{"color":"red"}');
    expect(() => ADAPTERS.grok.parse('{"type":"result","is_error":true,"result":"auth"}')).toThrow(/auth/);
  });
});

describe("selectAgent", () => {
  const installed = (names: string[]) =>
    fakeRunner((cmd) => (names.includes(cmd) ? ok("1.0") : { stdout: "", stderr: "", code: 127, timedOut: false })).run;

  it("prefers grok, then codex, then claude", async () => {
    expect(await selectAgent(installed(["claude", "codex", "grok"]))).toBe("grok");
    expect(await selectAgent(installed(["claude", "codex"]))).toBe("codex");
    expect(await selectAgent(installed(["claude"]))).toBe("claude");
  });

  it("honours an explicit choice and fails clearly when it is missing", async () => {
    expect(await selectAgent(installed(["grok", "claude"]), "claude")).toBe("claude");
    await expect(selectAgent(installed(["grok"]), "codex")).rejects.toThrow(/codex/);
    await expect(selectAgent(installed([]))).rejects.toThrow(/No agent CLI/);
  });
});

describe("createAsk", () => {
  it("runs prepare once and returns the parsed answer", async () => {
    const { run, calls } = fakeRunner((_cmd, args) =>
      args[0] === "mcp" ? ok("[]") : ok(fixture("codex-success.jsonl")),
    );
    const ask = createAsk(run, "codex");
    expect(await ask("P", [], "/tmp")).toBe('{"color":"red"}');
    await ask("P", [], "/tmp");
    expect(calls.filter((c) => c.args[0] === "mcp")).toHaveLength(1);
  });

  it("lets a single call use a longer timeout", async () => {
    const seen: number[] = [];
    const run: Runner = async (_cmd, _args, o) => {
      seen.push(o.timeoutMs);
      return ok(fixture("claude-success.json"));
    };
    const ask = createAsk(run, "claude", undefined, 1_000);
    await ask("P", [], "/tmp");
    await ask("P", [], "/tmp", 600_000);
    expect(seen).toEqual([1_000, 600_000]);
  });

  it("reports timeouts and non-zero exits", async () => {
    const timeout = fakeRunner(() => ({ stdout: "", stderr: "", code: null, timedOut: true })).run;
    await expect(createAsk(timeout, "claude", undefined, 5_000)("P", [], "/tmp")).rejects.toThrow(/timed out after 5s/);
    const fail = fakeRunner(() => ({ stdout: "", stderr: "boom", code: 1, timedOut: false })).run;
    await expect(createAsk(fail, "claude")("P", [], "/tmp")).rejects.toThrow(/boom/);
  });
});

describe("runProcess", () => {
  it("captures output and kills on timeout", async () => {
    const res = await runProcess("sh", ["-c", "echo hi"], { cwd: "/tmp", timeoutMs: 5_000 });
    expect(res).toMatchObject({ stdout: "hi\n", code: 0, timedOut: false });
    const slow = await runProcess("sh", ["-c", "sleep 5"], { cwd: "/tmp", timeoutMs: 200 });
    expect(slow.timedOut).toBe(true);
  });

  it("kills every running agent process group on demand (used on Ctrl-C)", async () => {
    const started = Date.now();
    const pending = runProcess("sh", ["-c", "sleep 30 & sleep 30; wait"], { cwd: "/tmp", timeoutMs: 60_000 });
    await new Promise((r) => setTimeout(r, 200));
    expect(killRunning()).toBe(1);
    const res = await pending;
    expect(res.code).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(killRunning()).toBe(0);
  });
});
