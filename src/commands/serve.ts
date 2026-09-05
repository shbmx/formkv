import { createServer, type ServerResponse } from "node:http";
import { Cloudflare, resolveToken } from "../cf.js";
import { loadConfig, type Config } from "../config.js";
import { dashboardHtml } from "../dashboard.js";

type Row = Record<string, string | null>;

async function readAll(cf: Cloudflare, nsId: string): Promise<Row[]> {
  const keys = await cf.listKeys(nsId, "email:");
  const rows: Row[] = [];
  for (const k of keys) {
    const raw = await cf.getValue(nsId, k.name);
    if (!raw) continue;
    try {
      rows.push(JSON.parse(raw) as Row);
    } catch {
      /* skip a record we can't parse rather than failing the whole page */
    }
  }
  // Chronological, matching `formkv list`: for a signup list the order people
  // joined is information. The dashboard can reverse it with one click.
  return rows.sort((a, b) => String(a["at"] ?? "").localeCompare(String(b["at"] ?? "")));
}

function json(res: ServerResponse, code: number, body: unknown) {
  const s = JSON.stringify(body);
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(s) });
  res.end(s);
}

export async function serve(argv: string[]): Promise<void> {
  const cfg: Config = await loadConfig();
  const token = await resolveToken();
  const cf = new Cloudflare(token, cfg.accountId);
  const port = Number(argv.find((a) => a.startsWith("--port="))?.split("=")[1] ?? 7399);

  const columns = ["at", ...cfg.fields.map((f) => f.name)];
  const html = dashboardHtml(cfg.name, columns);

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);

      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/rows") {
        return json(res, 200, { rows: await readAll(cf, cfg.kvNamespaceId), columns });
      }
      if (req.method === "POST" && url.pathname === "/api/delete") {
        const body = await new Promise<string>((ok) => {
          let b = "";
          req.on("data", (c) => (b += c));
          req.on("end", () => ok(b));
        });
        const { email } = JSON.parse(body || "{}") as { email?: string };
        if (!email) return json(res, 400, { error: "email required" });
        await cf.deleteKey(cfg.kvNamespaceId, `email:${email.toLowerCase()}`);
        return json(res, 200, { ok: true });
      }
      res.writeHead(404).end("Not found");
    } catch (err) {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  // 127.0.0.1, not 0.0.0.0: the API token lives in this process, and the data is
  // not something to expose on the local network by accident.
  server.listen(port, "127.0.0.1", () => {
    console.log(`formkv dashboard  http://127.0.0.1:${port}`);
    console.log(`namespace         ${cfg.kvNamespaceId}`);
    console.log(`\nCtrl-C to stop.`);
  });
}
