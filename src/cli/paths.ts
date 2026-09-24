import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type ClientId = "desktop" | "code" | "codex" | "grok";

export const CLIENT_LABELS: Record<ClientId, string> = {
  desktop: "Claude Desktop",
  code: "Claude Code",
  codex: "Codex",
  grok: "Grok",
};

export const ALL_CLIENTS: ClientId[] = ["desktop", "code", "codex", "grok"];

export const MCP_SERVER_KEY = "video";

/** Absolute launch command for this package's MCP entrypoint. */
export function getServerLaunch(): { command: string; args: string[] } {
  // cli/paths.js → ../index.js when built
  const entry = fileURLToPath(new URL("../index.js", import.meta.url));
  return {
    command: process.execPath,
    args: [entry],
  };
}

export function claudeDesktopConfigPath(): string {
  if (process.platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "Claude",
      "claude_desktop_config.json",
    );
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, "Claude", "claude_desktop_config.json");
  }
  return path.join(os.homedir(), ".config", "Claude", "claude_desktop_config.json");
}

export function claudeCodeConfigPath(): string {
  return path.join(os.homedir(), ".claude.json");
}

export function codexConfigPath(): string {
  return path.join(os.homedir(), ".codex", "config.toml");
}

export function grokConfigPath(): string {
  return path.join(os.homedir(), ".grok", "config.toml");
}

export function clientConfigPath(client: ClientId): string {
  switch (client) {
    case "desktop":
      return claudeDesktopConfigPath();
    case "code":
      return claudeCodeConfigPath();
    case "codex":
      return codexConfigPath();
    case "grok":
      return grokConfigPath();
  }
}
