import { AgentError, parseJsonLines, type AgentAdapter } from "./types.js";

const PLUGINS_OFF = ["-c", "features.plugins=false"];

// Codex runs MCP tools outside its shell sandbox, so plugins are switched off and every enabled
// MCP server is disabled by name; the sandbox itself is read-only.
export const codex: AgentAdapter = {
  name: "codex",
  imageMode: "attached",

  async prepare(run, cwd) {
    const res = await run("codex", ["mcp", "list", "--json", ...PLUGINS_OFF], { cwd, timeoutMs: 30_000 });
    if (res.code !== 0) {
      throw new AgentError(`could not list codex MCP servers to disable them: ${res.stderr.trim().slice(-300)}`);
    }
    const servers = JSON.parse(res.stdout) as { name: string; enabled: boolean }[];
    return [...PLUGINS_OFF, ...servers.filter((s) => s.enabled).flatMap((s) => ["-c", `mcp_servers.${s.name}.enabled=false`])];
  },

  async build(req, extra) {
    return {
      cmd: "codex",
      args: [
        "exec", "--json", "--ephemeral", "--skip-git-repo-check",
        "-c", 'sandbox_mode="read-only"',
        ...extra,
        ...(req.model ? ["-m", req.model] : []),
        ...req.images.flatMap((i) => ["-i", i]),
        "--", req.prompt,
      ],
    };
  },

  parse(stdout) {
    const events = parseJsonLines(stdout);
    const failure = events.find((e) => e.type === "turn.failed" || e.type === "error");
    if (failure) {
      const message = (failure.error as { message?: string } | undefined)?.message ?? failure.message;
      throw new AgentError(`codex reported an error: ${String(message ?? "unknown error")}`);
    }
    const answer = events
      .filter((e) => e.type === "item.completed")
      .map((e) => e.item as { type?: string; text?: string })
      .filter((item) => item.type === "agent_message" && item.text)
      .at(-1)?.text;
    if (!answer) throw new AgentError("codex returned no answer");
    return answer;
  },
};
