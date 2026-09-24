import type { AgentName } from "../types.js";
import type { Runner } from "./run.js";

export interface AgentRequest {
  readonly prompt: string;
  /** Absolute JPEG paths. */
  readonly images: readonly string[];
  readonly cwd: string;
  readonly model?: string;
}

export interface Invocation {
  readonly cmd: string;
  readonly args: readonly string[];
}

/** Turns one prompt (+ images) into a headless, read-only CLI call and parses its answer. */
export interface AgentAdapter {
  readonly name: AgentName;
  /** "paths": the prompt must list image paths for the agent to open; "attached": sent inline. */
  readonly imageMode: "paths" | "attached";
  /** Extra args computed once per run (e.g. which MCP servers to switch off). */
  prepare?(run: Runner, cwd: string): Promise<string[]>;
  build(req: AgentRequest, extra: readonly string[]): Promise<Invocation>;
  /** The agent's final text answer; throws when the output holds an error or no answer. */
  parse(stdout: string): string;
}

export class AgentError extends Error {
  override readonly name = "AgentError";
}

export function parseJsonLines(stdout: string): Record<string, unknown>[] {
  return stdout.split("\n").flatMap((line) => {
    const t = line.trim();
    if (!t.startsWith("{")) return [];
    try {
      return [JSON.parse(t) as Record<string, unknown>];
    } catch {
      return [];
    }
  });
}
