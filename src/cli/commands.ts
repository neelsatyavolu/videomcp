import { access } from "node:fs/promises";
import { checkDeps } from "../media/deps.js";
import { SERVER_NAME, SERVER_VERSION } from "../constants.js";
import {
  installJsonMcpServers,
  isJsonInstalled,
  uninstallJsonMcpServers,
} from "./json-config.js";
import {
  ALL_CLIENTS,
  CLIENT_LABELS,
  type ClientId,
  MCP_SERVER_KEY,
  clientConfigPath,
  getServerLaunch,
} from "./paths.js";
import {
  installTomlMcp,
  isTomlInstalled,
  uninstallTomlMcp,
} from "./toml-config.js";

function isTomlClient(client: ClientId): boolean {
  return client === "codex" || client === "grok";
}

export function parseClients(raw?: string): ClientId[] {
  if (!raw || raw === "all") return [...ALL_CLIENTS];
  const parts = raw.split(",").map((s) => s.trim().toLowerCase());
  const out: ClientId[] = [];
  for (const p of parts) {
    if (p === "claude-desktop" || p === "desktop") out.push("desktop");
    else if (p === "claude-code" || p === "code" || p === "claude") out.push("code");
    else if (p === "codex") out.push("codex");
    else if (p === "grok") out.push("grok");
    else {
      throw new Error(
        `Unknown client "${p}". Use: desktop, code, codex, grok, or all`,
      );
    }
  }
  return [...new Set(out)];
}

export async function cmdInstall(clients: ClientId[]): Promise<void> {
  console.log(`${SERVER_NAME} v${SERVER_VERSION} — install\n`);
  const launch = getServerLaunch();
  console.log(`Server: ${launch.command} ${launch.args.join(" ")}\n`);

  for (const client of clients) {
    const label = CLIENT_LABELS[client];
    const configPath = clientConfigPath(client);
    try {
      const result = isTomlClient(client)
        ? await installTomlMcp(configPath)
        : await installJsonMcpServers(configPath);
      console.log(`✓ ${label} (${result})`);
      console.log(`  ${configPath}`);
      console.log(`  key: ${isTomlClient(client) ? `mcp_servers.${MCP_SERVER_KEY}` : `mcpServers.${MCP_SERVER_KEY}`}`);
    } catch (err) {
      console.error(`✗ ${label}: ${err instanceof Error ? err.message : err}`);
    }
  }

  console.log(`
Next steps:
  • Claude Desktop — restart the app
  • Claude Code  — start a new session (or restart)
  • Codex        — start a new session
  • Grok         — start a new session (or /mcp reload if available)

If whisper/tesseract missing:
  video-mcp setup

Check setup:  video-mcp doctor
`);
}

export async function cmdUninstall(clients: ClientId[]): Promise<void> {
  console.log(`${SERVER_NAME} — uninstall\n`);
  for (const client of clients) {
    const label = CLIENT_LABELS[client];
    const configPath = clientConfigPath(client);
    try {
      const removed = isTomlClient(client)
        ? await uninstallTomlMcp(configPath)
        : await uninstallJsonMcpServers(configPath);
      console.log(
        removed ? `✓ ${label} removed` : `· ${label} was not installed`,
      );
      console.log(`  ${configPath}`);
    } catch (err) {
      console.error(`✗ ${label}: ${err instanceof Error ? err.message : err}`);
    }
  }
}

export async function cmdStatus(clients: ClientId[]): Promise<void> {
  console.log(`${SERVER_NAME} v${SERVER_VERSION} — status\n`);
  const launch = getServerLaunch();
  console.log(`Launch: ${launch.command} ${launch.args.join(" ")}`);
  try {
    await access(launch.args[0]!);
    console.log(`Entry:  OK\n`);
  } catch {
    console.log(`Entry:  MISSING (run npm run build)\n`);
  }

  for (const client of clients) {
    const label = CLIENT_LABELS[client];
    const configPath = clientConfigPath(client);
    const installed = isTomlClient(client)
      ? await isTomlInstalled(configPath)
      : await isJsonInstalled(configPath);
    console.log(`${installed ? "✓" : "·"} ${label.padEnd(16)} ${installed ? "installed" : "not installed"}`);
    console.log(`  ${configPath}`);
  }
}

export async function cmdDoctor(): Promise<void> {
  console.log(`${SERVER_NAME} v${SERVER_VERSION} — doctor\n`);
  const launch = getServerLaunch();
  console.log(`MCP entry: ${launch.args[0]}`);
  try {
    await access(launch.args[0]!);
    console.log(`  status: OK\n`);
  } catch {
    console.log(`  status: MISSING — run: npm run build\n`);
  }

  const deps = await checkDeps();
  for (const d of deps) {
    const mark = d.available ? "✓" : "✗";
    console.log(`${mark} ${d.name}${d.path ? ` — ${d.path}` : ""}`);
    if (d.version) console.log(`    ${d.version}`);
    if (d.note) console.log(`    ${d.note}`);
  }

  console.log("\nClients:");
  for (const client of ALL_CLIENTS) {
    const label = CLIENT_LABELS[client];
    const configPath = clientConfigPath(client);
    const installed = isTomlClient(client)
      ? await isTomlInstalled(configPath)
      : await isJsonInstalled(configPath);
    console.log(
      `  ${installed ? "✓" : "·"} ${label.padEnd(16)} ${installed ? "installed" : "not installed"}`,
    );
  }
}

export function printHelp(): void {
  console.log(`video-mcp — local video understanding for AI agents

Usage:
  video-mcp setup [--model base|small|base.en]  Install ffmpeg, tesseract, whisper-cpp + model
  video-mcp install [--client <name>]           Wire into agent clients
  video-mcp uninstall [--client <name>]         Remove from clients
  video-mcp status [--client <name>]            Show install status
  video-mcp doctor                              Check deps + client installs
  video-mcp serve                               Run MCP server (stdio)
  video-mcp help                                Show this help

Clients (--client):
  all (default) | desktop | code | codex | grok

Quick start:
  video-mcp setup
  video-mcp install

Needed for full understanding:
  ffmpeg (frames) · whisper-cpp + model (speech) · tesseract (on-screen text)

When run with no args (or as the MCP entrypoint), starts the MCP server on stdio.
`);
}
