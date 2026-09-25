#!/usr/bin/env node
import {
  cmdDoctor,
  cmdInstall,
  cmdStatus,
  cmdUninstall,
  parseClients,
  printHelp,
} from "./cli/commands.js";
import { enrichPath } from "./utils/env.js";

enrichPath();

function getFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  return args[i + 1];
}

export async function runCli(argv: string[]): Promise<void> {
  const args = argv.slice(2);
  const cmd = args[0] ?? "help";

  try {
    switch (cmd) {
      case "setup": {
        const { cmdSetup } = await import("./cli/setup.js");
        const modelIdx = args.indexOf("--model");
        const model = modelIdx >= 0 ? args[modelIdx + 1] : undefined;
        await cmdSetup({ model, skipBrew: args.includes("--skip-brew") });
        break;
      }
      case "install": {
        const clients = parseClients(getFlag(args, "--client") ?? getFlag(args, "-c"));
        await cmdInstall(clients);
        break;
      }
      case "uninstall":
      case "remove": {
        const clients = parseClients(getFlag(args, "--client") ?? getFlag(args, "-c"));
        await cmdUninstall(clients);
        break;
      }
      case "status":
      case "list": {
        const clients = parseClients(getFlag(args, "--client") ?? getFlag(args, "-c"));
        await cmdStatus(clients);
        break;
      }
      case "doctor":
      case "check":
        await cmdDoctor();
        break;
      case "help":
      case "--help":
      case "-h":
        printHelp();
        break;
      case "version":
      case "--version":
      case "-v": {
        const { SERVER_VERSION } = await import("./constants.js");
        console.log(SERVER_VERSION);
        break;
      }
      case "sort": {
        const { cmdSort } = await import("./sort/index.js");
        process.exitCode = await cmdSort(args.slice(1));
        break;
      }
      case "serve": {
        const { default: start } = await import("./serve.js");
        await start();
        break;
      }
      default:
        console.error(`Unknown command: ${cmd}\n`);
        printHelp();
        process.exitCode = 1;
    }
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  }
}

// Direct execution (`node dist/cli.js …`). The installed `video-mcp` bin runs index.js,
// which calls runCli itself, so matching the bin name here would run every command twice.
const isDirect =
  process.argv[1] && (process.argv[1].endsWith("/cli.js") || process.argv[1].endsWith("/cli.ts"));

if (isDirect) {
  runCli(process.argv);
}
