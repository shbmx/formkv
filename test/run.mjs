// Runs every suite. Exits non-zero if any fails.
import { execFileSync } from "node:child_process";
import { mkdtempSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const suites = [];

// 1. the fixture suite — generates a Worker, runs it against a stub KV
suites.push(["worker (fixture)", () => {
  const dir = mkdtempSync(join(tmpdir(), "formkv-test-"));
  copyFileSync(join(root, "test/fixture.json"), join(dir, "formkv.json"));
  execFileSync("node", [join(root, "dist/cli.js"), "deploy", "--dry-run"], { cwd: dir, stdio: "pipe" });
  copyFileSync(join(root, "test/worker.test.mjs"), join(dir, "test.mjs"));
  execFileSync("node", ["test.mjs"], { cwd: dir, stdio: "inherit" });
}]);

// 2. every other config shape: field types, disabled features, TTL, bad input
suites.push(["worker (variants)", () =>
  execFileSync("node", [join(root, "test/variants.test.mjs")], { stdio: "inherit" })]);

// 3. the Cloudflare client and the dashboard page, against a stubbed fetch
suites.push(["cloudflare client + dashboard", () =>
  execFileSync("node", [join(root, "test/cf.test.mjs")], { stdio: "inherit" })]);

// 4. the commands themselves against a stubbed fetch
suites.push(["commands", () =>
  execFileSync("node", [join(root, "test/commands.test.mjs")], { stdio: "inherit" })]);

// 5. the config validation rules
suites.push(["config validation", () =>
  execFileSync("node", [join(root, "test/config.test.mjs")], { stdio: "inherit" })]);

let failed = 0;
for (const [name, run] of suites) {
  console.log(`\n\x1b[1m── ${name} ─────────────────────────────\x1b[0m`);
  try { run(); } catch { failed++; }
}
console.log(failed ? `\n${failed} suite(s) failed` : "\nall suites passed");
process.exit(failed ? 1 : 0);
