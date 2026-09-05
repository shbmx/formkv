/** JSON for embedding inside a <script> block. Escaping "<" stops a value
 *  containing "</script>" from closing the tag early. */
const jsonForScript = (v: unknown): string =>
  JSON.stringify(v).replace(/</g, "\\u003c");

/** The local dashboard page. Self-contained: no CDN, no build step, no fonts to fetch. */
export function dashboardHtml(name: string, columns: readonly string[]): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(name)} · formkv</title>
<style>
:root{color-scheme:light dark;--bg:#fbfaf8;--fg:#16160f;--mut:#6b6b60;--rule:#e4e3dc;
 --card:#fff;--accent:#1d6b4f;--danger:#a33a2a}
@media(prefers-color-scheme:dark){:root{--bg:#131312;--fg:#eeece4;--mut:#9a998e;
 --rule:#2c2c28;--card:#1a1a18;--accent:#5cbf95;--danger:#e0836f}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 ui-sans-serif,system-ui,sans-serif}
header{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;
 padding:22px 24px 16px;border-bottom:1px solid var(--rule)}
h1{margin:0;font-size:17px;letter-spacing:-.01em}
.count{font:12px ui-monospace,Menlo,monospace;color:var(--mut)}
.spacer{flex:1}
input[type=search]{padding:7px 10px;border:1px solid var(--rule);border-radius:4px;
 background:var(--card);color:var(--fg);font-size:14px;min-width:200px}
button{padding:7px 12px;border:1px solid var(--rule);border-radius:4px;background:var(--card);
 color:var(--fg);font-size:13px;cursor:pointer}
button:hover{border-color:var(--mut)}
main{padding:0 24px 60px}
table{border-collapse:collapse;width:100%;font-size:13.5px}
th{text-align:left;font:600 11px/1 ui-monospace,Menlo,monospace;letter-spacing:.08em;
 text-transform:uppercase;color:var(--mut);padding:14px 12px 8px 0;border-bottom:1px solid var(--rule);
 cursor:pointer;white-space:nowrap;user-select:none}
th:hover{color:var(--fg)}
td{padding:9px 12px 9px 0;border-bottom:1px solid var(--rule);vertical-align:top;
 word-break:break-word}
td.mono{font:12.5px ui-monospace,Menlo,monospace;color:var(--mut);white-space:nowrap}
tr:hover td{background:var(--card)}
.del{color:var(--danger);border-color:transparent;background:none;padding:3px 7px;
 font-size:12px;opacity:0;transition:opacity .1s}
tr:hover .del{opacity:1}
.empty{padding:60px 0;text-align:center;color:var(--mut)}
.err{margin:16px 0;padding:11px 14px;border-left:3px solid var(--danger);background:var(--card);
 font:13px ui-monospace,Menlo,monospace;color:var(--danger);white-space:pre-wrap}
</style></head><body>
<header>
  <h1>${esc(name)}</h1>
  <span class="count" id="count">loading…</span>
  <span class="spacer"></span>
  <input type="search" id="q" placeholder="filter…" autocomplete="off">
  <button id="refresh">Refresh</button>
  <button id="csv">Export CSV</button>
</header>
<main><div id="err"></div><div id="out"></div></main>
<script>
const COLS = ${jsonForScript(columns)};
let rows = [], sortKey = "at", sortDir = 1;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) =>
  ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));

async function load() {
  $("#err").innerHTML = "";
  try {
    const r = await fetch("/api/rows");
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    rows = d.rows;
    render();
  } catch (e) {
    $("#err").innerHTML = '<div class="err">' + esc(e.message) + "</div>";
    $("#count").textContent = "";
  }
}

function visible() {
  const q = $("#q").value.trim().toLowerCase();
  const f = q ? rows.filter((r) => COLS.some((c) => String(r[c] ?? "").toLowerCase().includes(q))) : rows;
  return [...f].sort((a, b) =>
    sortDir * String(a[sortKey] ?? "").localeCompare(String(b[sortKey] ?? "")));
}

function render() {
  const list = visible();
  $("#count").textContent = list.length === rows.length
    ? rows.length + (rows.length === 1 ? " submission" : " submissions")
    : list.length + " of " + rows.length;
  if (!rows.length) {
    $("#out").innerHTML = '<p class="empty">Nothing submitted yet.</p>';
    return;
  }
  const head = COLS.map((c) =>
    "<th data-k=\\"" + c + "\\">" + esc(c) + (c === sortKey ? (sortDir > 0 ? " ↑" : " ↓") : "") + "</th>"
  ).join("") + "<th></th>";
  const body = list.map((r) => "<tr>" + COLS.map((c) => {
    const v = r[c] ?? "";
    const mono = c === "at" || c === "email";
    return '<td class="' + (mono ? "mono" : "") + '">' +
      (c === "at" && v ? esc(new Date(v).toLocaleString()) : esc(v)) + "</td>";
  }).join("") +
    '<td><button class="del" data-e="' + esc(r.email) + '">delete</button></td></tr>').join("");
  $("#out").innerHTML = "<table><thead><tr>" + head + "</tr></thead><tbody>" + body + "</tbody></table>";
}

$("#out").addEventListener("click", async (e) => {
  const th = e.target.closest("th[data-k]");
  if (th) {
    const k = th.dataset.k;
    sortDir = k === sortKey ? -sortDir : 1;
    sortKey = k;
    return render();
  }
  const del = e.target.closest(".del");
  if (del) {
    const email = del.dataset.e;
    if (!confirm("Delete " + email + "? This cannot be undone.")) return;
    del.disabled = true;
    const r = await fetch("/api/delete", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const d = await r.json();
    if (d.error) { $("#err").innerHTML = '<div class="err">' + esc(d.error) + "</div>"; del.disabled = false; }
    else { rows = rows.filter((x) => x.email !== email); render(); }
  }
});

$("#q").addEventListener("input", render);
$("#refresh").addEventListener("click", load);
$("#csv").addEventListener("click", () => {
  const cell = (v) => { const s = String(v ?? ""); return /[",\\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const csv = [COLS.join(","), ...visible().map((r) => COLS.map((c) => cell(r[c])).join(","))].join("\\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = ${jsonForScript(name)} + "-submissions.csv";
  a.click();
  URL.revokeObjectURL(a.href);
});

load();
</script></body></html>`;
}

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
