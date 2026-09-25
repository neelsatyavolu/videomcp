import os from "node:os";
import type { AgentName } from "../types.js";
import { claude } from "./claude.js";
import { codex } from "./codex.js";
import { grok } from "./grok.js";
import type { Runner } from "./run.js";
import { AgentError, type AgentAdapter } from "./types.js";

export const AGENT_ORDER: readonly AgentName[] = ["grok", "codex", "claude"];
export const ADAPTERS: Readonly<Record<AgentName, AgentAdapter>> = { grok, codex, claude };
export const DEFAULT_AGENT_TIMEOUT_MS = 180_000;

export function isAgentName(s: string): s is AgentName {
  return (AGENT_ORDER as readonly string[]).includes(s);
}

async function isInstalled(run: Runner, agent: AgentName): Promise<boolean> {
  const res = await run(agent, ["--version"], { cwd: os.homedir(), timeoutMs: 15_000 });
  return res.code === 0;
}

/** The preferred agent if installed, else the first installed in AGENT_ORDER. */
export async function selectAgent(run: Runner, preferred?: AgentName): Promise<AgentName> {
  if (preferred) {
    if (await isInstalled(run, preferred)) return preferred;
    throw new AgentError(`${preferred} CLI not found or not working (\`${preferred} --version\` failed)`);
  }
  for (const agent of AGENT_ORDER) {
    if (await isInstalled(run, agent)) return agent;
  }
  throw new AgentError("No agent CLI found. Install and sign in to one of: grok, codex, claude.");
}

/** timeoutMs overrides the default for one call (e.g. the whole-shoot grouping call). */
export type Ask = (prompt: string, images: readonly string[], cwd: string, timeoutMs?: number) => Promise<string>;

/** One headless call per ask; the adapter's prepare step runs once and is shared. */
export function createAsk(run: Runner, agent: AgentName, model?: string, timeoutMs = DEFAULT_AGENT_TIMEOUT_MS): Ask {
  const adapter = ADAPTERS[agent];
  let extra: Promise<string[]> | null = null;
  return async (prompt, images, cwd, callTimeoutMs = timeoutMs) => {
    extra ??= adapter.prepare ? adapter.prepare(run, cwd) : Promise.resolve([]);
    const inv = await adapter.build({ prompt, images, cwd, ...(model ? { model } : {}) }, await extra);
    const res = await run(inv.cmd, inv.args, { cwd, timeoutMs: callTimeoutMs });
    if (res.timedOut) throw new AgentError(`${agent} timed out after ${Math.round(callTimeoutMs / 1000)}s`);
    if (res.code !== 0) {
      const detail = (res.stderr.trim() || res.stdout.trim()).slice(-500);
      throw new AgentError(`${agent} exited with code ${res.code}: ${detail}`);
    }
    return adapter.parse(res.stdout);
  };
}
