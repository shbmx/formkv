import { writeFile } from "node:fs/promises";
import { Cloudflare, resolveToken } from "../cf.js";
import { loadConfig, saveConfig } from "../config.js";
import { buildWorker } from "../worker-template.js";

export async function deploy(argv: string[]): Promise<void> {
  const cfg = await loadConfig();
  const script = buildWorker(cfg);

  if (argv.includes("--dry-run")) {
    const out = "formkv-worker.generated.js";
    await writeFile(out, script);
    console.log(`Wrote ${out} (${script.split("\n").length} lines). Nothing deployed.`);
    return;
  }
  if (!cfg.allowedOrigins.length) {
    throw new Error(
      "allowedOrigins is empty — browsers would refuse every request.\n" +
        "Add your site origin to formkv.json, e.g. [\"https://example.com\"].",
    );
  }

  const token = await resolveToken();
  const cf = new Cloudflare(token, cfg.accountId);

  await cf.putWorker(cfg.name, script, cfg.kvNamespaceId);
  console.log(`Deployed Worker "${cfg.name}"`);

  await cf.enableSubdomain(cfg.name);
  const sub = await cf.workersSubdomain();
  const url = `https://${cfg.name}.${sub}.workers.dev`;
  await saveConfig({ ...cfg, workerUrl: url });

  const required = cfg.fields.filter((f) => f.required).map((f) => f.name);
  console.log(`\nEndpoint  ${url}`);
  console.log(`Fields    ${cfg.fields.map((f) => f.name).join(", ")}  (required: ${required.join(", ")})`);
  console.log(`\nPaste into your page:\n`);
  console.log(formSnippet(url, cfg.fields.map((f) => f.name), cfg.honeypot));
}

function formSnippet(url: string, fields: readonly string[], honeypot: string): string {
  const inputs = fields
    .map((f) =>
      f === "email"
        ? `  <input type="email" name="email" required autocomplete="email" placeholder="you@example.com">`
        : `  <input type="text" name="${f}" placeholder="${f}">`,
    )
    .join("\n");
  const hp = honeypot
    ? `\n  <input type="text" name="${honeypot}" tabindex="-1" autocomplete="off" aria-hidden="true"\n         style="position:absolute;left:-9999px">`
    : "";
  return `<form method="POST" action="${url}">
${inputs}${hp}
  <button type="submit">Join the waitlist</button>
</form>

<!-- Works with JavaScript off. With JS on, POST the same fields as JSON to the
     same URL for an inline response instead of a page navigation. -->`;
}
