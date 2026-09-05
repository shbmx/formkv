// The validation rules in config.ts guard against configs that would produce a
// broken or unsafe Worker. None of them were exercised until this file.
import { validate, defaultConfig } from "../dist/config.js";

let pass = 0, fail = 0;
const t = (n, c, x = "") => (c ? (pass++, console.log(`  ok   ${n}`)) : (fail++, console.log(`  FAIL ${n} ${x}`)));

const ok = defaultConfig("demo", "acc", "ns");
const rejects = (name, mutate) => {
  const cfg = structuredClone(ok);
  mutate(cfg);
  let threw = null;
  try { validate(cfg); } catch (e) { threw = e; }
  t(name, threw !== null, "expected validate() to throw");
};
const accepts = (name, mutate) => {
  const cfg = structuredClone(ok);
  mutate(cfg);
  try { validate(cfg); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name} — threw: ${e.message}`); }
};

console.log("accepts a sane config");
accepts("the default config validates", () => {});
accepts("origins with a scheme and no trailing slash", (c) => {
  c.allowedOrigins = ["https://a.test", "http://localhost:3000"];
});

console.log("\nrejects unsafe or broken configs");
rejects("wildcard origin", (c) => { c.allowedOrigins = ["*"]; });
rejects("origin without a scheme", (c) => { c.allowedOrigins = ["example.com"]; });
rejects("origin with a trailing slash", (c) => { c.allowedOrigins = ["https://a.test/"]; });
rejects("no email field", (c) => { c.fields = [{ name: "name", type: "text" }]; });
rejects("two email fields", (c) => {
  c.fields = [{ name: "email", type: "email" }, { name: "alt", type: "email" }];
});
rejects("email field renamed", (c) => { c.fields = [{ name: "addr", type: "email" }]; });
rejects("field name with a dash", (c) => {
  c.fields = [...c.fields, { name: "first-name", type: "text" }];
});
rejects("field name starting with a digit", (c) => {
  c.fields = [...c.fields, { name: "1st", type: "text" }];
});
rejects("choice field with no options", (c) => {
  c.fields = [...c.fields, { name: "src", type: "choice" }];
});
rejects("honeypot colliding with a real field", (c) => {
  c.fields = [...c.fields, { name: "company", type: "text" }];
  c.honeypot = "company";
});
rejects("empty accountId", (c) => { c.accountId = ""; });
rejects("empty kvNamespaceId", (c) => { c.kvNamespaceId = ""; });
rejects("rateLimit window under a minute", (c) => { c.rateLimit = { max: 5, windowSeconds: 10 }; });
rejects("rateLimit max of zero", (c) => { c.rateLimit = { max: 0, windowSeconds: 3600 }; });
rejects("negative retentionDays", (c) => { c.retentionDays = -1; });
accepts("retentionDays null", (c) => { c.retentionDays = null; });
accepts("rateLimit null", (c) => { c.rateLimit = null; });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
