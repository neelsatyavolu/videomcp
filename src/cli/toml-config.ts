import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { MCP_SERVER_KEY, getServerLaunch } from "./paths.js";

function sectionHeader(): string {
  return `[mcp_servers.${MCP_SERVER_KEY}]`;
}

function escapeTomlString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function buildSection(extraEnv?: Record<string, string>): string {
  const { command, args } = getServerLaunch();
  const lines = [
    sectionHeader(),
    `command = "${escapeTomlString(command)}"`,
    `args = [${args.map((a) => `"${escapeTomlString(a)}"`).join(", ")}]`,
    "enabled = true",
    "startup_timeout_sec = 30",
    "tool_timeout_sec = 600",
  ];
  if (extraEnv && Object.keys(extraEnv).length) {
    const pairs = Object.entries(extraEnv)
      .map(([k, v]) => `${k} = "${escapeTomlString(v)}"`)
      .join(", ");
    lines.push(`env = { ${pairs} }`);
  }
  return `${lines.join("\n")}\n`;
}

/** Remove [mcp_servers.video] ... until next top-level [section]. */
export function stripSection(toml: string): string {
  const header = sectionHeader().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?:^|\\n)${header}[\\s\\S]*?(?=\\n\\[|$)`, "m");
  let out = toml.replace(re, "\n");
  // tidy extra blank lines
  out = out.replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "");
  if (out && !out.endsWith("\n")) out += "\n";
  return out;
}

export function hasSection(toml: string): boolean {
  return toml.includes(sectionHeader());
}

async function backup(filePath: string): Promise<void> {
  try {
    await copyFile(filePath, `${filePath}.bak`);
  } catch {
    // ignore
  }
}

export async function readToml(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}

export async function installTomlMcp(
  filePath: string,
  extraEnv?: Record<string, string>,
): Promise<"added" | "updated"> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const existing = await readToml(filePath);
  const existed = hasSection(existing);
  let next = stripSection(existing).trimEnd();
  if (next) next += "\n\n";
  next += buildSection(extraEnv);
  await backup(filePath);
  await writeFile(filePath, next, "utf8");
  return existed ? "updated" : "added";
}

export async function uninstallTomlMcp(filePath: string): Promise<boolean> {
  const existing = await readToml(filePath);
  if (!hasSection(existing)) return false;
  const next = stripSection(existing);
  await backup(filePath);
  await writeFile(filePath, next, "utf8");
  return true;
}

export async function isTomlInstalled(filePath: string): Promise<boolean> {
  const existing = await readToml(filePath);
  return hasSection(existing);
}
