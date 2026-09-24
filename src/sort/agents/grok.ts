import { readFile } from "node:fs/promises";
import { AgentError, parseJsonLines, type AgentAdapter } from "./types.js";

/** Base64 chars of images per call; keeps --prompt-json well under macOS's ~1 MB argv limit. */
const IMAGE_BUDGET_CHARS = 600_000;

// --tools keeps read-only built-ins; grok's MCP meta-tools (search_tool/use_tool) and sub-agents are
// removed because they can reach write-capable servers. Images go inline as ACP image blocks.
export const grok: AgentAdapter = {
  name: "grok",
  imageMode: "attached",

  async build(req) {
    const images: { type: "image"; mimeType: string; data: string }[] = [];
    let used = 0;
    for (const file of req.images) {
      const data = (await readFile(file)).toString("base64");
      if (used + data.length > IMAGE_BUDGET_CHARS) break;
      used += data.length;
      images.push({ type: "image", mimeType: "image/jpeg", data });
    }
    const blocks = [{ type: "text", text: req.prompt }, ...images];
    return {
      cmd: "grok",
      args: [
        "--prompt-json", JSON.stringify(blocks),
        "--output-format", "streaming-messages-json",
        "--tools", "read_file",
        "--disallowed-tools", "Agent,search_tool,use_tool",
        "--disable-web-search",
        ...(req.model ? ["--model", req.model] : []),
      ],
    };
  },

  parse(stdout) {
    const result = parseJsonLines(stdout).filter((e) => e.type === "result").at(-1);
    if (!result) throw new AgentError(`grok returned no result: ${stdout.slice(0, 300)}`);
    if (result.is_error) throw new AgentError(`grok reported an error: ${String(result.result ?? "unknown error")}`);
    if (typeof result.result !== "string" || !result.result) throw new AgentError("grok returned no answer");
    return result.result;
  },
};
