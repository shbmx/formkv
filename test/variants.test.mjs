// Exercises the code paths the single-fixture suite never reaches: every field
// type, the disabled-feature branches, TTL, and hostile input.
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const ROOT = new URL("..", import.meta.url).pathname;
let pass = 0, fail = 0;
const t = (n, c, x = "") => (c ? (pass++, console.log(`  ok   ${n}`)) : (fail++, console.log(`  FAIL ${n} ${x}`)));

const base = {
  name: "v", accountId: "a", kvNamespaceId: "k",
  allowedOrigins: ["https://a.test", "https://b.test"],
  honeypot: "company", rateLimit: { max: 5, windowSeconds: 3600 },
  retentionDays: null, siteUrl: "https://a.test", supportEmail: "",
  messages: { success: "ok", duplicate: "dup", rateLimited: "slow" },
  fields: [{ name: "email", type: "email", required: true }],
};

/** Generates a Worker for a config and returns { worker, puts }. */
async function build(cfg, tag) {
  const dir = mkdtempSync(join(tmpdir(), `fk-${tag}-`));
  writeFileSync(join(dir, "formkv.json"), JSON.stringify(cfg));
  execFileSync("node", [join(ROOT, "dist/cli.js"), "deploy", "--dry-run"], { cwd: dir, stdio: "pipe" });
  const mod = await import(pathToFileURL(join(dir, "formkv-worker.generated.js")).href);
  const store = new Map();
  const puts = [];
  const env = { FORM_KV: {
    async get(k) { return store.get(k) ?? null; },
    async put(k, v, opts) { store.set(k, v); puts.push({ k, opts }); },
  }};
  const post = (body, o = {}) => mod.default.fetch(new Request("https://x/", {
    method: "POST",
    headers: { "content-type": o.ct ?? "application/json",
               origin: o.origin ?? "https://a.test", "cf-connecting-ip": o.ip ?? "1.1.1.1" },
    body: o.rawBody ?? JSON.stringify(body),
  }), env);
  return { post, store, puts };
}

console.log("field types");
{
  const { post, store } = await build({ ...base, fields: [
    ...base.fields,
    { name: "site", type: "url" },
    { name: "qty", type: "number" },
    { name: "role", type: "text", required: true },
  ]}, "types");
  t("url rejects a non-URL", (await post({ email: "a@b.co", role: "x", site: "notaurl" })).status === 400);
  t("url accepts https", (await post({ email: "c@b.co", role: "x", site: "https://ok.dev" })).status === 201);
  t("number rejects letters", (await post({ email: "d@b.co", role: "x", qty: "many" })).status === 400);
  t("number accepts digits", (await post({ email: "e@b.co", role: "x", qty: "42" })).status === 201);
  t("required non-email field enforced", (await post({ email: "f@b.co" })).status === 400);
  t("optional field stored as null when absent",
    JSON.parse(store.get("email:c@b.co")).qty === null);
}

console.log("\ndisabled features");
{
  const { post } = await build({ ...base, rateLimit: null }, "norl");
  const codes = [];
  for (let i = 0; i < 8; i++) codes.push((await post({ email: `n${i}@b.co` }, { ip: "7.7.7.7" })).status);
  t("rateLimit:null never returns 429", !codes.includes(429), `got ${codes}`);
}
{
  const { post, store } = await build({ ...base, honeypot: "" }, "nohp");
  await post({ email: "h@b.co", company: "Acme" });
  t('honeypot:"" stores the record anyway', store.has("email:h@b.co"));
}

console.log("\nretention");
{
  const { post, puts } = await build({ ...base, retentionDays: 30 }, "ttl");
  await post({ email: "r@b.co" });
  const signup = puts.find((p) => p.k.startsWith("email:"));
  t("retentionDays sets expirationTtl", signup?.opts?.expirationTtl === 30 * 86400,
    JSON.stringify(signup?.opts));
}
{
  const { post, puts } = await build({ ...base }, "nottl");
  await post({ email: "s@b.co" });
  const signup = puts.find((p) => p.k.startsWith("email:"));
  t("retentionDays:null sets no TTL", signup?.opts === undefined, JSON.stringify(signup?.opts));
}

console.log("\nhostile and malformed input");
{
  const { post, store } = await build({ ...base, fields: [
    ...base.fields, { name: "note", type: "text" },
  ]}, "hostile");

  await post({ email: "x@b.co", note: "hi", extra: "sneaky", at: "1999-01-01" });
  const rec = JSON.parse(store.get("email:x@b.co"));
  t("undeclared fields are dropped", !("extra" in rec));
  t("client cannot forge the timestamp", rec.at !== "1999-01-01");

  const r1 = await post(null, { rawBody: "{not json" });
  t("malformed JSON does not 500", r1.status !== 500, `got ${r1.status}`);

  const r2 = await post(null, { rawBody: '"a string"' });
  t("non-object JSON rejected", r2.status === 400, `got ${r2.status}`);

  const r3 = await post(null, { rawBody: "[]" });
  t("array body rejected", r3.status === 400, `got ${r3.status}`);

  const r4 = await post({ email: "y@b.co" }, { ct: "text/plain" });
  t("wrong content-type rejected", r4.status === 415);

  const xss = '<script>alert(1)</script>';
  const r5 = await post({ email: "z@b.co", note: xss },
    { ct: "application/x-www-form-urlencoded", rawBody: `email=z@b.co&note=${encodeURIComponent(xss)}` });
  const html = await r5.text();
  t("submitted values are not echoed into the HTML page", !html.includes("<script>alert"));

  t("second origin in the allowlist is honoured",
    (await post({ email: "w@b.co" }, { origin: "https://b.test" }))
      .headers.get("access-control-allow-origin") === "https://b.test");
}

console.log("\nunicode and size");
{
  const { post, store } = await build({ ...base, fields: [
    ...base.fields, { name: "note", type: "text", maxLength: 100 },
  ]}, "uni");
  await post({ email: "u@b.co", note: "café ☕ — naïve 日本語 🇮🇳" });
  t("unicode survives the round trip",
    JSON.parse(store.get("email:u@b.co")).note === "café ☕ — naïve 日本語 🇮🇳");
  await post({ email: "É@B.CO" });
  t("uppercase unicode local part lowercased", store.has("email:é@b.co"));
  t("maxLength counts characters, not bytes",
    (await post({ email: "v@b.co", note: "☕".repeat(101) })).status === 400);
  t("a value at the limit is accepted",
    (await post({ email: "w@b.co", note: "x".repeat(100) })).status === 201);
  const big = await post({ email: "big@b.co", note: "x".repeat(50_000) });
  t("an oversized field is rejected, not stored", big.status === 400 && !store.has("email:big@b.co"));
}

console.log("\nemail edge cases");
{
  const { post, store } = await build({ ...base }, "email");
  t("rejects address with no TLD", (await post({ email: "a@b" })).status === 400);
  t("rejects spaces inside", (await post({ email: "a b@c.co" })).status === 400);
  t("rejects empty string", (await post({ email: "" })).status === 400);
  t("rejects missing key", (await post({})).status === 400);
  await post({ email: "  MiXeD@CaSe.CO  " });
  t("trims and lowercases", store.has("email:mixed@case.co"));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
