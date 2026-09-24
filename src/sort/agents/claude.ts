import path from "node:path";
import { AgentError, type AgentAdapter } from "./types.js";

// --restricted drops tools that run code and confines Read to the working dirs (--add-dir included);
// --strict-mcp-config with no --mcp-config loads no MCP servers.
export const claude: AgentAdapter = {
  name: "claude",
  imageMode: "paths",

  async build(req) {
    const dirs = [...new Set([req.cwd, ...req.images.map((i) => path.dirname(i))])];
    return {
      cmd: "claude",
      args: [
        "-p",
        "--output-format", "json",
        "--restricted",
        "--tools", "Read",
        "--strict-mcp-config",
        ...dirs.flatMap((d) => ["--add-dir", d]),
        ...(req.model ? ["--model", req.model] : []),
        req.prompt,
      ],
    };
  },

  parse(stdout) {
    let out: { is_error?: boolean; result?: unknown };
    try {
      out = JSON.parse(stdout) as typeof out;
    } catch {
      throw new AgentError(`claude returned unreadable output: ${stdout.slice(0, 300)}`);
    }
    if (out.is_error) throw new AgentError(`claude reported an error: ${String(out.result ?? "unknown error")}`);
    if (typeof out.result !== "string" || !out.result) throw new AgentError("claude returned no answer");
    return out.result;
  },
};
