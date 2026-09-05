import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { Cloudflare, resolveToken } from "../cf.js";
import { loadConfig } from "../config.js";

/**
 * Removes the Worker and the KV namespace this config created. Deleting the
 * namespace deletes every submission in it, so this asks for the project name
 * back rather than a y/n — a reflexive "y" should not be able to do this.
 */
export async function destroy(argv: string[]): Promise<void> {
  const cfg = await loadConfig();
  const cf = new Cloudflare(await resolveToken(), cfg.accountId);

  let count = "an unknown number of";
  try {
    count = String((await cf.listKeys(cfg.kvNamespaceId, "email:")).length);
  } catch {
    // listing is a courtesy; a failure here should not block teardown
  }

  console.log(`This deletes, permanently:`);
  console.log(`  Worker         ${cfg.name}`);
  console.log(`  KV namespace   ${cfg.kvNamespaceId}`);
  console.log(`  submissions    ${count}`);

  if (!argv.includes("--yes")) {
    if (!stdin.isTTY) {
      throw new Error("Refusing to destroy without a TTY. Pass --yes if you mean it.");
    }
    const rl = createInterface({ input: stdin, output: stdout });
    const typed = await rl.question(`\nType the project name (${cfg.name}) to confirm: `);
    rl.close();
    if (typed.trim() !== cfg.name) {
      console.log("Names did not match. Nothing was deleted.");
      return;
    }
  }

  // Worker first: once it is gone nothing can write to the namespace, so a
  // failure on the second step cannot leave a live endpoint writing into a
  // namespace that is about to disappear.
  await cf.deleteWorker(cfg.name);
  console.log(`Deleted Worker ${cfg.name}`);
  await cf.deleteNamespace(cfg.kvNamespaceId);
  console.log(`Deleted KV namespace ${cfg.kvNamespaceId}`);
  console.log(`\nformkv.json is left in place. Delete it yourself if you are done.`);
}
