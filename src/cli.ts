#!/usr/bin/env node
import { init } from "./commands/init.js";
import { deploy } from "./commands/deploy.js";
import { list, remove } from "./commands/list.js";
import { serve } from "./commands/serve.js";
import { destroy } from "./commands/destroy.js";

const HELP = `formkv — collect form submissions into Cloudflare KV. No server, no database.

Usage:
  formkv init [flags]           Create the KV namespace and write formkv.json
                                 --name= --origins=a,b --fields="n:type:opt"
                                 Prompts only when interactive; flags make it scriptable.
  formkv deploy [--dry-run]     Generate and upload the Worker, print the endpoint and a form
  formkv list [options]         Show submissions in the terminal
  formkv serve [--port=7399]    Open a local dashboard in the browser
  formkv remove <email>         Delete one submission
  formkv destroy [--yes]        Delete the Worker and the KV namespace
  formkv help

list options:
  --csv --json          output format (default: a table)
  --out=<file>          write to a file instead of stdout
  --count               print only the number of signups

The Cloudflare API token is never written to formkv.json. formkv reads
CLOUDFLARE_API_TOKEN from the environment, or "secret get cloudflare-api-token"
if you keep it in the macOS keychain.

Token needs: Account > Workers Scripts > Edit, Account > Workers KV Storage > Edit.
`;

const commands: Record<string, (argv: string[]) => Promise<void>> = {
  init,
  deploy,
  list,
  serve,
  remove,
  destroy,
};

async function main(): Promise<void> {
  const [cmd, ...argv] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    process.stdout.write(HELP);
    return;
  }
  const fn = commands[cmd];
  if (!fn) {
    process.stderr.write(`Unknown command "${cmd}".\n\n${HELP}`);
    process.exitCode = 1;
    return;
  }
  await fn(argv);
}

main().catch((err: unknown) => {
  process.stderr.write(`\n${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
