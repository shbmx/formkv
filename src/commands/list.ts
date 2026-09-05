import { writeFile } from "node:fs/promises";
import { Cloudflare, resolveToken } from "../cf.js";
import { loadConfig } from "../config.js";

type Signup = Record<string, string | null> & { email: string; at: string };

async function fetchAll(cf: Cloudflare, nsId: string): Promise<Signup[]> {
  const keys = await cf.listKeys(nsId, "email:");
  const out: Signup[] = [];
  // Sequential on purpose: the KV REST API rate-limits bursts, and a waitlist is
  // small enough that this costs seconds, not minutes.
  for (const k of keys) {
    const raw = await cf.getValue(nsId, k.name);
    if (!raw) continue;
    try {
      out.push(JSON.parse(raw) as Signup);
    } catch {
      console.warn(`skipping unparseable record: ${k.name}`);
    }
  }
  return out.sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""));
}

const csvCell = (v: unknown): string => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export async function list(argv: string[]): Promise<void> {
  const cfg = await loadConfig();
  const cf = new Cloudflare(await resolveToken(), cfg.accountId);
  const rows = await fetchAll(cf, cfg.kvNamespaceId);

  if (argv.includes("--count")) {
    console.log(String(rows.length));
    return;
  }
  if (!rows.length) {
    console.log("No signups yet.");
    return;
  }

  const cols = ["at", ...cfg.fields.map((f) => f.name)];
  const asCsv = argv.includes("--csv");
  const asJson = argv.includes("--json");
  const outFlag = argv.find((a) => a.startsWith("--out="))?.split("=")[1];

  let body: string;
  if (asJson) {
    body = JSON.stringify(rows, null, 2);
  } else if (asCsv || outFlag?.endsWith(".csv")) {
    body = [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\n");
  } else {
    const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)));
    const line = (cells: string[]) => cells.map((s, i) => s.padEnd(w[i]!)).join("  ");
    console.log(line(cols));
    console.log(w.map((n) => "-".repeat(n)).join("  "));
    for (const r of rows) console.log(line(cols.map((c) => String(r[c] ?? ""))));
    console.log(`\n${rows.length} signup${rows.length === 1 ? "" : "s"}`);
    return;
  }

  if (outFlag) {
    await writeFile(outFlag, body.endsWith("\n") ? body : body + "\n");
    console.log(`Wrote ${rows.length} rows to ${outFlag}`);
  } else {
    console.log(body);
  }
}

export async function remove(argv: string[]): Promise<void> {
  const email = argv.find((a) => !a.startsWith("-"))?.toLowerCase().trim();
  if (!email) throw new Error("Usage: formkv remove <email>");
  const cfg = await loadConfig();
  const cf = new Cloudflare(await resolveToken(), cfg.accountId);
  const key = `email:${email}`;
  if (!(await cf.getValue(cfg.kvNamespaceId, key))) {
    console.log(`${email} is not on the list.`);
    return;
  }
  await cf.deleteKey(cfg.kvNamespaceId, key);
  console.log(`Removed ${email}.`);
}
