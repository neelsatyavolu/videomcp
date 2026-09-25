import { spawn } from "node:child_process";

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const KILL_GRACE_MS = 2_000;

export interface RunResult {
  readonly stdout: string;
  readonly stderr: string;
  /** null when the process was killed; 127 when it could not be started. */
  readonly code: number | null;
  readonly timedOut: boolean;
}

export type Runner = (
  cmd: string,
  args: readonly string[],
  o: { readonly cwd: string; readonly timeoutMs: number },
) => Promise<RunResult>;

/** Process-group ids of agent CLIs still running. */
const running = new Set<number>();

/**
 * SIGKILLs every running agent process group; returns how many there were. The groups are
 * detached, so a terminal Ctrl-C does not reach them on its own.
 */
export function killRunning(): number {
  const count = running.size;
  for (const pid of running) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // already exited
    }
  }
  running.clear();
  return count;
}

/**
 * Runs a command with stdin closed, in its own process group so a timeout also stops any
 * children the agent CLI spawned (SIGTERM, then SIGKILL after a grace period).
 */
export const runProcess: Runner = (cmd, args, { cwd, timeoutMs }) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const pid = child.pid;
    if (pid) running.add(pid);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const killGroup = (signal: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, signal);
      } catch {
        // already exited
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS).unref();
    }, timeoutMs);

    child.stdout.on("data", (c: Buffer) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += c.toString("utf8");
    });
    child.stderr.on("data", (c: Buffer) => {
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += c.toString("utf8");
    });
    child.on("error", (err) => {
      if (pid) running.delete(pid);
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr: err.message, code: 127, timedOut: false });
    });
    child.on("close", (code) => {
      if (pid) running.delete(pid);
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code: timedOut ? null : code, timedOut });
    });
  });
