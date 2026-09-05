// The Cloudflare client, against a stubbed fetch. Covers the logic that is ours
// — envelope handling, the pagination loop, 404 semantics, multipart assembly —
// without touching the network or needing an account.
import { Cloudflare } from "../dist/cf.js";
import { dashboardHtml } from "../dist/dashboard.js";

let pass = 0, fail = 0;
const t = (n, c, x = "") => (c ? (pass++, console.log(`  ok   ${n}`)) : (fail++, console.log(`  FAIL ${n} ${x}`)));

const real = globalThis.fetch;
/** Queue of responses; each call shifts one. Records every request. */
function stub(responses) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const r = responses.shift();
    if (!r) throw new Error("stub ran out of responses for " + url);
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), {
      status: r.status ?? 200,
    });
  };
  return calls;
}
const envelope = (result, extra = {}) => ({ success: true, errors: [], result, ...extra });

console.log("error handling");
{
  stub([{ body: { success: false, errors: [{ code: 10000, message: "Authentication error" }], result: null } }]);
  const cf = new Cloudflare("bad-token", "acct");
  let msg = "";
  try { await cf.createNamespace("x"); } catch (e) { msg = e.message; }
  t("surfaces the Cloudflare error message", msg.includes("Authentication error"), msg);
  t("names the failing path", msg.includes("/storage/kv/namespaces"), msg);
}
{
  stub([{ body: "<html>502 Bad Gateway</html>" }]);
  const cf = new Cloudflare("t", "acct");
  let msg = "";
  try { await cf.createNamespace("x"); } catch (e) { msg = e.message; }
  t("non-JSON response does not throw a parse error", msg.includes("non-JSON"), msg);
}
{
  const calls = stub([{ body: envelope([{ id: "a1", name: "Acme" }]) }]);
  const accts = await Cloudflare.accounts("tok");
  t("accounts() returns the list", accts[0].id === "a1");
  t("accounts() sends a bearer token", calls[0].init.headers.Authorization === "Bearer tok");
}

console.log("\npagination");
{
  // Two pages, then a page with no cursor to end the loop.
  stub([
    { body: envelope([{ name: "email:a@x.co" }], { result_info: { cursor: "c1" } }) },
    { body: envelope([{ name: "email:b@x.co" }], { result_info: { cursor: "c2" } }) },
    { body: envelope([{ name: "email:c@x.co" }], { result_info: {} }) },
  ]);
  const cf = new Cloudflare("t", "acct");
  const keys = await cf.listKeys("ns", "email:");
  t("follows the cursor across pages", keys.length === 3, `got ${keys.length}`);
  t("preserves order across pages", keys[0].name.endsWith("a@x.co") && keys[2].name.endsWith("c@x.co"));
}
{
  const calls = stub([{ body: envelope([], { result_info: {} }) }]);
  await new Cloudflare("t", "acct").listKeys("ns", "email:");
  t("passes the prefix as a query param", calls[0].url.includes("prefix=email%3A"), calls[0].url);
  t("asks for a full page", calls[0].url.includes("limit=1000"));
}

console.log("\nvalues");
{
  stub([{ status: 404, body: "" }]);
  const v = await new Cloudflare("t", "acct").getValue("ns", "email:missing@x.co");
  t("missing key returns null rather than throwing", v === null);
}
{
  stub([{ body: '{"email":"a@x.co"}' }]);
  const v = await new Cloudflare("t", "acct").getValue("ns", "email:a@x.co");
  t("existing key returns the raw body", v === '{"email":"a@x.co"}');
}
{
  const calls = stub([{ body: '{}' }]);
  await new Cloudflare("t", "acct").getValue("ns", "email:a+b@x.co");
  t("encodes keys containing +", calls[0].url.includes("%2B"), calls[0].url);
}

console.log("\nworker upload");
{
  const calls = stub([{ body: envelope({}) }]);
  await new Cloudflare("t", "acct").putWorker("w", "export default {}", "NSID");
  const body = calls[0].init.body;
  t("uploads as multipart FormData", body instanceof FormData);
  const meta = JSON.parse(await body.get("metadata").text());
  t("declares the module entrypoint", meta.main_module === "worker.js");
  t("binds KV under the expected name", meta.bindings[0].name === "FORM_KV");
  t("binds the right namespace id", meta.bindings[0].namespace_id === "NSID");
  t("sends a compatibility date", typeof meta.compatibility_date === "string");
  t("uses PUT", calls[0].init.method === "PUT");
}

console.log("\ndashboard page");
{
  const html = dashboardHtml("my project", ["at", "email", "note"]);
  t("renders the project name", html.includes("my project"));
  t("embeds the column list", html.includes('["at","email","note"]'));
  t("is a complete document", html.startsWith("<!doctype html>") && html.trimEnd().endsWith("</html>"));
  t("pulls in no external resources", !/src="http|href="http/.test(html));
  const evil = dashboardHtml('x"><script>alert(1)</script>', ["at"]);
  t("escapes the name into the title", !evil.includes("<script>alert(1)"));
}

globalThis.fetch = real;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
