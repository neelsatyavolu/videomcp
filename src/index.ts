#!/usr/bin/env node
/**
 * Dual entrypoint:
 * - No args / unknown → MCP stdio server (what agents launch)
 * - install|uninstall|status|doctor|sort|help|serve|version → CLI
 */
import { runCli } from "./cli.js";
import start from "./serve.js";

const CLI_COMMANDS = new Set([
  "setup",
  "install",
  "uninstall",
  "remove",
  "status",
  "list",
  "doctor",
  "check",
  "help",
  "--help",
  "-h",
  "version",
  "--version",
  "-v",
  "serve",
  "sort",
]);

async function main(): Promise<void> {
  const first = process.argv[2];
  if (first && CLI_COMMANDS.has(first)) {
    await runCli(process.argv);
    return;
  }
  await start();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
