import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export async function which(bin: string): Promise<string | null> {
  const pathEnv = process.env.PATH ?? "";
  const parts = pathEnv.split(process.platform === "win32" ? ";" : ":");
  const names =
    process.platform === "win32" ? [bin, `${bin}.exe`, `${bin}.cmd`] : [bin];
  for (const dir of parts) {
    for (const name of names) {
      const full = `${dir}/${name}`.replace(/\/+/g, process.platform === "win32" ? "\\" : "/");
      try {
        await access(full, constants.X_OK);
        return full;
      } catch {
        // continue
      }
    }
  }
  return null;
}

export function execFile(
  command: string,
  args: string[],
  opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv; maxBuffer?: number } = {},
): Promise<ExecResult> {
  const timeoutMs = opts.timeoutMs ?? 600_000;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const max = opts.maxBuffer ?? 32 * 1024 * 1024;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`Command timed out after ${timeoutMs}ms: ${command} ${args.join(" ")}`));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < max) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < max) stderr += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? 1 });
    });
  });
}

export async function execOk(
  command: string,
  args: string[],
  opts?: { timeoutMs?: number; env?: NodeJS.ProcessEnv },
): Promise<ExecResult> {
  const result = await execFile(command, args, opts);
  if (result.code !== 0) {
    const msg = (result.stderr || result.stdout || `exit ${result.code}`).trim();
    throw new Error(`${command} failed: ${msg.slice(0, 2000)}`);
  }
  return result;
}
