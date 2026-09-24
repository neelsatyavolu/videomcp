import path from "node:path";
import os from "node:os";

let enriched = false;

/**
 * GUI apps (Claude Desktop) often have a minimal PATH and miss Homebrew.
 * Prepend common binary locations once at process start.
 */
export function enrichPath(): void {
  if (enriched) return;
  enriched = true;

  const extras: string[] = [];
  if (process.platform === "darwin") {
    extras.push("/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin");
  } else if (process.platform === "linux") {
    extras.push("/usr/local/bin", "/home/linuxbrew/.linuxbrew/bin");
  } else if (process.platform === "win32") {
    // leave default
  }

  const home = os.homedir();
  extras.push(
    path.join(home, ".local", "bin"),
    path.join(home, ".cargo", "bin"),
  );

  const current = process.env.PATH ?? "";
  const parts = current.split(path.delimiter).filter(Boolean);
  const seen = new Set(parts);
  const prepend: string[] = [];
  for (const p of extras) {
    if (!seen.has(p)) {
      prepend.push(p);
      seen.add(p);
    }
  }
  process.env.PATH = [...prepend, ...parts].join(path.delimiter);

  // Help GUI-launched whisper find models / python
  if (!process.env.PYTHONUTF8) process.env.PYTHONUTF8 = "1";
}
