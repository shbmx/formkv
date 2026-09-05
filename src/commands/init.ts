import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { Cloudflare, resolveToken } from "../cf.js";
import { CONFIG_FILE, defaultConfig, saveConfig, validate, type Config, type Field } from "../config.js";

type Asker = (q: string, fallback?: string) => Promise<string>;

/** One interface for the whole run. Opening and closing one per question tears
 *  down a piped stdin after the first read, which leaves later answers hanging. */
function prompter(): { ask: Asker; done: () => void } {
  // Non-interactive (piped, CI): never prompt. stdin hits EOF, readline closes,
  // and a pending question rejects — so take the flag value or the default.
  if (!stdin.isTTY) {
    return { ask: async (_q, fallback = "") => fallback, done: () => {} };
  }
  const rl = createInterface({ input: stdin, output: stdout });
  const ask: Asker = async (q, fallback = "") => {
    const a = (await rl.question(fallback ? `${q} [${fallback}] ` : `${q} `)).trim();
    return a || fallback;
  };
  return { ask, done: () => rl.close() };
}

const flag = (argv: string[], name: string): string | undefined =>
  argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

/** "building:text:500, referrer:url" -> Field[] */
function parseFields(spec: string): Field[] {
  const out: Field[] = [];
  for (const part of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [name, type = "text", extra] = part.split(":").map((s) => s.trim());
    if (!name) continue;
    const f: Record<string, unknown> = { name, type };
    if (type === "choice" && extra) f["options"] = extra.split("|").map((s) => s.trim());
    else if (extra) f["maxLength"] = Number(extra);
    out.push(f as unknown as Field);
  }
  return out;
}

export async function init(argv: string[]): Promise<void> {
  const { ask, done } = prompter();
  try {
    await runInit(argv, ask);
  } finally {
    done();
  }
}

async function runInit(argv: string[], ask: Asker): Promise<void> {
  const token = await resolveToken();
  const accounts = await Cloudflare.accounts(token);
  if (!accounts.length) throw new Error("That token can't see any Cloudflare accounts.");

  let accountId = accounts[0]!.id;
  if (accounts.length > 1) {
    console.log("\nAccounts this token can reach:");
    accounts.forEach((a, i) => console.log(`  ${i + 1}. ${a.name}  ${a.id}`));
    const pick = Number(flag(argv, "account") ?? (await ask("Which one?", "1")));
    accountId = accounts[Math.max(0, Math.min(accounts.length - 1, pick - 1))]!.id;
  }

  const name = flag(argv, "name") || (await ask("Project name (letters, digits, dashes):", "formkv"));
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new Error("Name must be lowercase letters, digits and dashes.");
  }

  const originsRaw =
    flag(argv, "origins") ?? (await ask("Site origin(s) allowed to post, comma separated:", ""));
  const origins = originsRaw.split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean);

  const extraRaw =
    flag(argv, "fields") ??
    (await ask('Extra fields beyond email (e.g. "building:text:500, source:choice:hn|twitter"):', ""));

  const cf = new Cloudflare(token, accountId);
  const title = `formkv-${name}`;
  const existing = await cf.findNamespace(title);
  const ns = existing ?? (await cf.createNamespace(title));
  console.log(existing ? `Reusing KV namespace ${title}` : `Created KV namespace ${title}`);

  const cfg: Config = {
    ...defaultConfig(name, accountId, ns.id),
    allowedOrigins: origins,
    fields: [...defaultConfig(name, accountId, ns.id).fields, ...parseFields(extraRaw)],
    siteUrl: origins[0] ?? "",
  };
  validate(cfg);
  const path = await saveConfig(cfg);

  console.log(`\nWrote ${CONFIG_FILE}`);
  console.log(`  KV namespace  ${ns.id}`);
  console.log(`  fields        ${cfg.fields.map((f) => f.name).join(", ")}`);
  if (!origins.length) {
    console.log(
      `\n  No origins set. Add them to ${path} before deploying, or the browser\n` +
        "  will refuse the request. The token is not stored in that file.",
    );
  }
  console.log('\nNext:  formkv deploy');
}
