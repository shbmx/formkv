// The commands themselves — list, remove, serve, destroy — driven against a
// stubbed fetch. These had never executed outside one manual run.
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0, fail = 0;
const t = (n, c, x = "") => (c ? (pass++, console.log(`  ok   ${n}`)) : (fail++, console.log(`  FAIL ${n} ${x}`)));

const CONFIG = {
  name: "demo", accountId: "acct", kvNamespaceId: "ns",
  allowedOrigins: ["https://a.test"],
  fields: [{ name: "email", type: "email", required: true }, { name: "note", type: "text" }],
  honeypot: "company", rateLimit: { max: 5, windowSeconds: 3600 },
  retentionDays: null, siteUrl: "https://a.test", supportEmail: "",
  messages: { success: "ok", duplicate: "dup", rateLimited: "slow" },
};
const ROWS = [
  { at: "2026-09-02T09:00:00.000Z", email: "b@x.co", note: "second, with a comma" },
  { at: "2026-09-01T09:00:00.000Z", email: "a@x.co", note: null },
];

const dir = mkdtempSync(join(tmpdir(), "formkv-cmd-"));
writeFileSync(join(dir, "formkv.json"), JSON.stringify(CONFIG));
process.chdir(dir);
process.env["CLOUDFLARE_API_TOKEN"] = "test-token";

// keep a handle on the real fetch: the serve test has to reach a real socket
const realFetch = globalThis.fetch.bind(globalThis);
const envelope = (result, extra = {}) => ({ success: true, errors: [], result, ...extra });
let requests = [];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  requests.push({ url: u, method: init.method ?? "GET" });
  const body = (o, s = 200) => new Response(JSON.stringify(o), { status: s });
  if (u.includes("/keys")) {
    return body(envelope(ROWS.map((r) => ({ name: `email:${r.email}` })), { result_info: {} }));
  }
  if (u.includes("/values/")) {
    if (init.method === "DELETE") return body(envelope({}));
    const email = decodeURIComponent(u.split("/values/")[1]).replace("email:", "");
    const row = ROWS.find((r) => r.email === email);
    return row ? new Response(JSON.stringify(row)) : new Response("", { status: 404 });
  }
  if (u.endsWith("/workers/subdomain")) return body(envelope({ subdomain: "testsub" }));
  if (u.endsWith("/accounts")) return body(envelope([{ id: "acct", name: "Test Account" }]));
  if (u.endsWith("/storage/kv/namespaces?per_page=100")) return body(envelope([]));
  if (u.endsWith("/storage/kv/namespaces")) return body(envelope({ id: "newns", title: "formkv-proj" }));
  if (u.includes("/workers/scripts/") || u.includes("/storage/kv/namespaces/")) return body(envelope({}));
  return body(envelope({}));
};

// capture stdout so command output can be asserted on
const realWrite = process.stdout.write.bind(process.stdout);
let captured = "";
const capture = (on) => { process.stdout.write = on ? (c) => (captured += c, true) : realWrite; };
const runCap = async (fn) => { captured = ""; capture(true); try { await fn(); } finally { capture(false); } return captured; };

const { list, remove } = await import("../dist/commands/list.js");
const { destroy } = await import("../dist/commands/destroy.js");
const { serve } = await import("../dist/commands/serve.js");

console.log("list");
{
  const out = await runCap(() => list([]));
  t("table shows both rows", out.includes("a@x.co") && out.includes("b@x.co"));
  t("table has a header", out.includes("email") && out.includes("note"));
  t("reports the count", out.includes("2 signups"));
  t("chronological, oldest first", out.indexOf("a@x.co") < out.indexOf("b@x.co"));
}
{
  const out = await runCap(() => list(["--count"]));
  t("--count prints only a number", out.trim() === "2", JSON.stringify(out));
}
{
  const out = await runCap(() => list(["--json"]));
  const parsed = JSON.parse(out);
  t("--json emits valid JSON", Array.isArray(parsed) && parsed.length === 2);
}
{
  const out = await runCap(() => list(["--csv"]));
  const lines = out.trim().split("\n");
  t("--csv header matches the fields", lines[0] === "at,email,note");
  t("--csv quotes a value containing a comma", out.includes('"second, with a comma"'));
}
{
  const file = join(dir, "out.csv");
  await runCap(() => list([`--out=${file}`]));
  t("--out writes a file", existsSync(file) && readFileSync(file, "utf8").includes("a@x.co"));
}

console.log("\nremove");
{
  requests = [];
  const out = await runCap(() => remove(["b@x.co"]));
  t("issues a DELETE", requests.some((r) => r.method === "DELETE" && r.url.includes("email%3Ab%40x.co")),
    JSON.stringify(requests.map((r) => r.method + " " + r.url)));
  t("confirms removal", out.toLowerCase().includes("removed"));
}
{
  const out = await runCap(() => remove(["ghost@x.co"]));
  t("unknown address says so instead of failing", out.includes("not on the list"));
}
{
  let msg = "";
  try { await remove([]); } catch (e) { msg = e.message; }
  t("no argument is a usage error", msg.includes("Usage"));
}

console.log("\ndestroy");
{
  let msg = "";
  try { await destroy([]); } catch (e) { msg = e.message; }
  t("refuses without a TTY unless --yes", msg.includes("Refusing"), msg);
}
{
  requests = [];
  const out = await runCap(() => destroy(["--yes"]));
  t("--yes deletes the Worker", requests.some((r) => r.method === "DELETE" && r.url.includes("/workers/scripts/demo")));
  t("--yes deletes the namespace", requests.some((r) => r.method === "DELETE" && r.url.includes("/namespaces/ns")));
  t("names what it will delete first", out.includes("submissions"));
  t("leaves formkv.json alone", existsSync(join(dir, "formkv.json")));
}

console.log("\nserve");
{
  const port = 7411;
  await serve([`--port=${port}`]);
  // serve() returns once listen() has been called, not once the socket is up
  await new Promise((r) => setTimeout(r, 250));
  const page = await (await realFetch(`http://127.0.0.1:${port}/`)).text();
  t("serves the dashboard", page.includes("<!doctype html>") && page.includes("demo"));
  const api = await (await realFetch(`http://127.0.0.1:${port}/api/rows`)).json();
  t("api/rows returns the rows", api.rows.length === 2);
  t("api/rows matches list ordering", api.rows[0].email === "a@x.co");
  t("api/rows returns the columns", api.columns.join() === "at,email,note");
  const four = await realFetch(`http://127.0.0.1:${port}/nope`);
  t("unknown path 404s", four.status === 404);
}

console.log("\ninit");
{
  const { init } = await import("../dist/commands/init.js");
  const fresh = mkdtempSync(join(tmpdir(), "formkv-init-"));
  const cwd = process.cwd();
  process.chdir(fresh);
  requests = [];
  const out = await runCap(() =>
    init(["--name=proj", "--origins=https://x.test,https://y.test", "--fields=note:text:50,src:choice:hn|tw"]));
  const written = JSON.parse(readFileSync(join(fresh, "formkv.json"), "utf8"));
  t("writes a config", written.name === "proj");
  t("parses origins", written.allowedOrigins.join() === "https://x.test,https://y.test");
  t("parses a field with maxLength", written.fields.find((f) => f.name === "note").maxLength === 50);
  t("parses a choice field's options",
    written.fields.find((f) => f.name === "src").options.join() === "hn,tw");
  t("keeps email as the first field", written.fields[0].name === "email");
  t("never writes the token to the config", !JSON.stringify(written).includes("test-token"));
  t("creates a namespace when none exists",
    requests.some((r) => r.method === "POST" && r.url.endsWith("/storage/kv/namespaces")));
  t("tells the user what is next", out.includes("formkv deploy"));

  // second run: the namespace now exists, so it should be reused not recreated
  requests = [];
  globalThis.fetch = (() => {
    const prev = globalThis.fetch;
    return async (url, init = {}) => {
      const u = String(url);
      if (u.endsWith("/storage/kv/namespaces?per_page=100")) {
        requests.push({ url: u, method: "GET" });
        return new Response(JSON.stringify(envelope([{ id: "existing", title: "formkv-proj" }])));
      }
      return prev(url, init);
    };
  })();
  const again = await runCap(() => init(["--name=proj", "--origins=https://x.test"]));
  t("reuses an existing namespace", again.includes("Reusing"), again.trim());
  t("does not create a second namespace",
    !requests.some((r) => r.method === "POST"));
  process.chdir(cwd);
}

console.log("\ndeploy");
{
  const { deploy } = await import("../dist/commands/deploy.js");
  requests = [];
  const out = await runCap(() => deploy([]));
  t("uploads the Worker",
    requests.some((r) => r.method === "PUT" && r.url.includes("/workers/scripts/demo")));
  t("enables the workers.dev route",
    requests.some((r) => r.url.includes("/subdomain")));
  t("prints the endpoint", out.includes("workers.dev") || out.includes("Endpoint"));
  t("prints a paste-ready form", out.includes("<form") && out.includes('name="email"'));
  t("includes the honeypot in the form", out.includes('name="company"'));
  t("records the URL in the config",
    JSON.parse(readFileSync(join(dir, "formkv.json"), "utf8")).workerUrl?.includes("http"));
}
{
  const { deploy } = await import("../dist/commands/deploy.js");
  const noOrigin = mkdtempSync(join(tmpdir(), "formkv-noorigin-"));
  writeFileSync(join(noOrigin, "formkv.json"), JSON.stringify({ ...CONFIG, allowedOrigins: [] }));
  const cwd = process.cwd();
  process.chdir(noOrigin);
  let msg = "";
  try { await deploy([]); } catch (e) { msg = e.message; }
  t("refuses to deploy with an empty origin list", msg.includes("allowedOrigins"), msg);
  process.chdir(cwd);
}
{
  const { deploy } = await import("../dist/commands/deploy.js");
  requests = [];
  await runCap(() => deploy(["--dry-run"]));
  t("--dry-run uploads nothing", !requests.some((r) => r.method === "PUT"));
  t("--dry-run writes the Worker locally",
    existsSync(join(process.cwd(), "formkv-worker.generated.js")));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
