import worker from "./formkv-worker.generated.js";

// Minimal KV stub with the same surface the Worker uses.
const store = new Map();
const env = { FORM_KV: {
  async get(k) { const v = store.get(k); return v === undefined ? null : v; },
  async put(k, v) { store.set(k, v); },
}};
const post = (body, { form = false, origin = "https://example.com", ip = "1.1.1.1" } = {}) =>
  worker.fetch(new Request("https://w.dev/", {
    method: "POST",
    headers: {
      "content-type": form ? "application/x-www-form-urlencoded" : "application/json",
      origin, "cf-connecting-ip": ip,
    },
    body: form ? new URLSearchParams(body).toString() : JSON.stringify(body),
  }), env);

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
};

let r = await post({ email: "A@Example.COM ", building: "a keyboard", source: "hn" });
check("accepts a valid signup", r.status === 201);
check("normalises the email key", store.has("email:a@example.com"));
check("stores extra fields", JSON.parse(store.get("email:a@example.com")).building === "a keyboard");
check("stamps a timestamp", !!JSON.parse(store.get("email:a@example.com")).at);
check("CORS echoes the caller origin",
  r.headers.get("access-control-allow-origin") === "https://example.com");
check("sets Vary: Origin", r.headers.get("vary") === "Origin");

r = await post({ email: "a@example.com" });
check("second signup is a duplicate, not an error", r.status === 200 && (await r.clone().json()).status === "duplicate");

r = await post({ email: "nope" });
check("rejects a malformed email", r.status === 400);

r = await post({ email: "c@example.com", source: "myspace" });
check("rejects a value outside choice options", r.status === 400);

r = await post({ email: "d@example.com", building: "x".repeat(201) });
check("rejects an over-long field", r.status === 400);

const before = store.size;
r = await post({ email: "bot@example.com", company: "AcmeBot" });
check("honeypot returns success", r.status === 200);
check("honeypot writes nothing", store.size === before, `(size ${before} -> ${store.size})`);

r = await post({ email: "e@example.com" }, { form: true });
const html = await r.text();
check("form post gets HTML, not JSON", r.headers.get("content-type").startsWith("text/html"));
check("HTML page renders the message", html.includes("You&#x27;re on the list") || html.includes("You're on the list"));

// rate limit is max 3 per IP
store.clear();
const codes = [];
for (let i = 0; i < 5; i++) codes.push((await post({ email: `r${i}@example.com` }, { ip: "9.9.9.9" })).status);
check("rate limit trips after 3", codes.filter((c) => c === 429).length === 2, `got ${codes}`);

r = await post({ email: "f@example.com" }, { origin: "https://evil.com" });
check("unknown origin does not get an allow header for itself",
  r.headers.get("access-control-allow-origin") !== "https://evil.com");

r = await worker.fetch(new Request("https://w.dev/", { method: "OPTIONS", headers: { origin: "https://example.com" } }), env);
check("preflight returns 204", r.status === 204);

r = await worker.fetch(new Request("https://w.dev/", { method: "GET" }), env);
check("GET is rejected", r.status === 405);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
