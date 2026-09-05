# formkv

Collect form submissions into Cloudflare KV. One command sets it up, another gives
you an endpoint to post to.

```
formkv init      # create the KV namespace, write formkv.json
formkv deploy    # upload the Worker, print your endpoint and a form to paste
formkv serve     # open a local dashboard to read the submissions
```

It runs on your own Cloudflare account. The data is in your KV namespace, and you
read it from your terminal.

## Install

```bash
pnpm install && pnpm build
node dist/cli.js help
```

Node 20+. No `wrangler` needed — it talks to the Cloudflare REST API directly.

## The token

formkv never writes your API token to disk. It reads, in order:

1. `CLOUDFLARE_API_TOKEN` (or `CF_API_TOKEN`) from the environment
2. `FORMKV_TOKEN_CMD` — a shell command that prints the token, for helpers that
   are shell functions rather than binaries
3. the macOS keychain, account `cloudflare-api-token`

Create the token at <https://dash.cloudflare.com/profile/api-tokens> with
**Account → Workers Scripts → Edit** and **Account → Workers KV Storage → Edit**.

```fish
set -x CLOUDFLARE_API_TOKEN <token>
# or, if you keep secrets behind a shell helper:
set -x FORMKV_TOKEN_CMD "secret get cloudflare-api-token"
# or in the keychain:
security add-generic-password -s formkv -a cloudflare-api-token -w <token>
```

## Configuring the form

`formkv init` writes `formkv.json`. Edit it, run `formkv deploy` again, and the
Worker is regenerated — you never hand-edit the Worker.

```json
{
  "name": "signups",
  "accountId": "…",
  "kvNamespaceId": "…",
  "allowedOrigins": ["https://example.com"],
  "fields": [
    { "name": "email",    "type": "email",  "required": true },
    { "name": "building", "type": "text",   "maxLength": 200 },
    { "name": "source",   "type": "choice", "options": ["hn", "twitter", "friend"] }
  ],
  "honeypot": "company",
  "rateLimit": { "max": 5, "windowSeconds": 3600 },
  "retentionDays": null,
  "siteUrl": "https://example.com",
  "supportEmail": "hello@example.com"
}
```

| Key | What it does |
|---|---|
| `fields` | Declared fields, validated in the Worker. Types: `email`, `text`, `url`, `number`, `choice`. Exactly one `email` field is required — it is the storage key, which is what makes duplicate detection a single read. |
| `allowedOrigins` | Origins allowed to post. `"*"` is rejected. |
| `honeypot` | Hidden input name. A submission that fills it is told it succeeded and is not stored. `""` disables. |
| `rateLimit` | Per IP, expiring by TTL. `null` disables. |
| `retentionDays` | `null` keeps submissions forever, which is the default. |
| `supportEmail` | Shown on the error page only, so a failed submission is not a dead end. `""` omits it. |

## Posting to it

Both shapes hit the same endpoint. `fetch()` gets JSON back:

```js
await fetch(endpoint, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email, building, source }),
});
// 201 {"status":"ok"}  ·  200 {"status":"duplicate"}  ·  400/429 {"error":"…"}
```

A native form POST gets a rendered HTML page instead, because a form post
navigates and someone ends up reading the response. `formkv deploy` prints a
ready-to-paste form that works with JavaScript off.

## Reading the data

A local dashboard — filter, sort by any column, export CSV, delete a row:

```bash
formkv serve              # http://127.0.0.1:7399
formkv serve --port=8080
```

It binds to `127.0.0.1` only. The API token stays in the CLI process and is never
sent to the browser, and nothing is exposed on your network or the internet.

Or stay in the terminal:

```bash
formkv list                    # a table
formkv list --count            # just the number
formkv list --csv --out=x.csv  # a spreadsheet
formkv list --json             # everything
formkv remove someone@x.com
formkv destroy                 # delete the Worker and the namespace
```

`destroy` asks you to type the project name back rather than accepting a `y`,
because it deletes every submission with it. `--yes` skips the prompt for scripts.

## Worth knowing

**KV is eventually consistent.** Reads can be stale for up to about a minute, so the
duplicate check and the rate limit are best-effort — two simultaneous posts of the
same address can both be stored. Fine for a signup list. If you need writes that
cannot double, use D1 or Durable Objects instead.

**The free tier is 1,000 KV writes a day.** An accepted submission is one write, and
the rate-limit counter is another. Rejected requests cost nothing, and the checks
are ordered so that spam is rejected before anything is written.

**Rate limiting is per IP**, so people behind one office gateway share a bucket.

**There is no query.** Counting means listing every key and reading each value,
which is what `formkv list` does. Fine at thousands.

## Testing

```bash
pnpm test
```

Five suites, 130 assertions, no network — Workers are generated from configs and
run against a stub KV.

| Suite | Covers |
|---|---|
| worker (fixture) | the happy path: validation, normalisation, duplicates, the honeypot storing nothing, the rate limit tripping, CORS, the form-vs-JSON split, method rejection |
| worker (variants) | every field type, `rateLimit: null`, `honeypot: ""`, `retentionDays` TTL, undeclared fields being dropped, forged timestamps, malformed and non-object bodies, and that submitted values never reach the HTML page |
| cloudflare client + dashboard | error envelopes, the pagination cursor loop, 404-as-null, multipart upload shape, and the dashboard page against a stubbed `fetch` |
| commands | `init`, `deploy`, `list` in every format, `remove`, `serve` and `destroy`, driven against a stubbed Cloudflare |
| config validation | each rule that rejects a config which would build a broken or unsafe Worker |

```bash
pnpm coverage
```

Coverage is 91.7%. CI runs the suite on Node 20, 22 and 24.

The deploy path has also been run once end to end against a real Cloudflare
account: namespace created, Worker uploaded, `workers.dev` route enabled, CORS
verified from an allowed origin, a second allowed origin and a disallowed one,
then everything torn down.

## Licence

MIT.
