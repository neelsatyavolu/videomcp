import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { MCP_SERVER_KEY, getServerLaunch } from "./paths.js";

export interface JsonMcpEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

async function backup(filePath: string): Promise<void> {
  try {
    await copyFile(filePath, `${filePath}.bak`);
  } catch {
    // file may not exist
  }
}

export async function readJsonFile(filePath: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Expected JSON object in ${filePath}`);
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return {};
    throw err;
  }
}

export async function writeJsonFile(
  filePath: string,
  data: Record<string, unknown>,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await backup(filePath);
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

export function makeJsonEntry(extraEnv?: Record<string, string>): JsonMcpEntry {
  const launch = getServerLaunch();
  return {
    command: launch.command,
    args: launch.args,
    ...(extraEnv && Object.keys(extraEnv).length ? { env: extraEnv } : {}),
  };
}

/** Install under top-level mcpServers (Claude Desktop / Claude Code global). */
export async function installJsonMcpServers(
  filePath: string,
  extraEnv?: Record<string, string>,
): Promise<"added" | "updated"> {
  const data = await readJsonFile(filePath);
  const servers =
    data.mcpServers && typeof data.mcpServers === "object" && !Array.isArray(data.mcpServers)
      ? ({ ...(data.mcpServers as Record<string, unknown>) } as Record<string, unknown>)
      : {};
  const existed = MCP_SERVER_KEY in servers;
  servers[MCP_SERVER_KEY] = makeJsonEntry(extraEnv);
  data.mcpServers = servers;
  await writeJsonFile(filePath, data);
  return existed ? "updated" : "added";
}

export async function uninstallJsonMcpServers(filePath: string): Promise<boolean> {
  const data = await readJsonFile(filePath);
  const servers =
    data.mcpServers && typeof data.mcpServers === "object" && !Array.isArray(data.mcpServers)
      ? ({ ...(data.mcpServers as Record<string, unknown>) } as Record<string, unknown>)
      : null;
  if (!servers || !(MCP_SERVER_KEY in servers)) return false;
  delete servers[MCP_SERVER_KEY];
  data.mcpServers = servers;
  await writeJsonFile(filePath, data);
  return true;
}

export async function isJsonInstalled(filePath: string): Promise<boolean> {
  try {
    const data = await readJsonFile(filePath);
    const servers = data.mcpServers as Record<string, unknown> | undefined;
    return Boolean(servers && MCP_SERVER_KEY in servers);
  } catch {
    return false;
  }
}
