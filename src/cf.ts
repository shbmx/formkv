import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const API = "https://api.cloudflare.com/client/v4";

type CfEnvelope<T> = {
  success: boolean;
  errors: { code: number; message: string }[];
  result: T;
  result_info?: { cursor?: string };
};

/**
 * The token is never written to formkv.json. It comes from the environment, or
 * from the macOS keychain via the `secret` helper if one is configured there.
 */
/**
 * The token is never written to formkv.json. Resolution order:
 *   1. CLOUDFLARE_API_TOKEN / CF_API_TOKEN
 *   2. FORMKV_TOKEN_CMD — a shell command that prints the token
 *   3. macOS keychain, any service, account "cloudflare-api-token"
 *
 * (2) exists because helpers like `secret get` are often shell functions rather
 * than binaries, so they cannot be exec'd directly. Naming the command works
 * whatever the helper is.
 */
export async function resolveToken(): Promise<string> {
  const env = process.env["CLOUDFLARE_API_TOKEN"] ?? process.env["CF_API_TOKEN"];
  if (env?.trim()) return env.trim();

  const cmd = process.env["FORMKV_TOKEN_CMD"];
  if (cmd) {
    try {
      const { stdout } = await run(process.env["SHELL"] || "/bin/sh", ["-c", cmd]);
      if (stdout.trim()) return stdout.trim();
    } catch {
      throw new Error(`FORMKV_TOKEN_CMD failed: ${cmd}`);
    }
  }

  if (process.platform === "darwin") {
    try {
      const { stdout } = await run("security", [
        "find-generic-password", "-a", "cloudflare-api-token", "-w",
      ]);
      if (stdout.trim()) return stdout.trim();
    } catch {
      // not in the keychain — fall through to the guidance below
    }
  }

  throw new Error(
    "No Cloudflare API token found. Any one of these works:\n" +
      "  export CLOUDFLARE_API_TOKEN=<token>\n" +
      '  export FORMKV_TOKEN_CMD="secret get cloudflare-api-token"   (any shell helper)\n' +
      "  security add-generic-password -s formkv -a cloudflare-api-token -w <token>\n\n" +
      "Create the token at https://dash.cloudflare.com/profile/api-tokens with\n" +
      "Account > Workers Scripts > Edit and Account > Workers KV Storage > Edit.",
  );
}

export class Cloudflare {
  constructor(
    private readonly token: string,
    readonly accountId: string,
  ) {}

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${this.token}`, ...(init.headers ?? {}) },
    });
    const text = await res.text();
    let body: CfEnvelope<T>;
    try {
      body = JSON.parse(text) as CfEnvelope<T>;
    } catch {
      throw new Error(`Cloudflare returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
    }
    if (!body.success) {
      const msg = body.errors?.map((e) => `${e.code} ${e.message}`).join("; ") || res.statusText;
      throw new Error(`Cloudflare API error on ${path}: ${msg}`);
    }
    return body.result;
  }

  /** Verifies the token and returns the accounts it can reach. */
  static async accounts(token: string): Promise<{ id: string; name: string }[]> {
    const res = await fetch(`${API}/accounts`, { headers: { Authorization: `Bearer ${token}` } });
    const body = (await res.json()) as CfEnvelope<{ id: string; name: string }[]>;
    if (!body.success) {
      const msg = body.errors?.map((e) => e.message).join("; ") || res.statusText;
      throw new Error(`Could not list accounts — is the token valid? (${msg})`);
    }
    return body.result;
  }

  async createNamespace(title: string): Promise<{ id: string; title: string }> {
    return this.call(`/accounts/${this.accountId}/storage/kv/namespaces`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
  }

  async findNamespace(title: string): Promise<{ id: string; title: string } | undefined> {
    const all = await this.call<{ id: string; title: string }[]>(
      `/accounts/${this.accountId}/storage/kv/namespaces?per_page=100`,
    );
    return all.find((n) => n.title === title);
  }

  /** Uploads an ES-module Worker with a single KV binding. */
  async putWorker(name: string, script: string, kvNamespaceId: string): Promise<void> {
    const metadata = {
      main_module: "worker.js",
      compatibility_date: "2026-01-01",
      bindings: [{ type: "kv_namespace", name: "FORM_KV", namespace_id: kvNamespaceId }],
    };
    const form = new FormData();
    form.set("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
    form.set(
      "worker.js",
      new Blob([script], { type: "application/javascript+module" }),
      "worker.js",
    );
    await this.call(`/accounts/${this.accountId}/workers/scripts/${name}`, {
      method: "PUT",
      body: form,
    });
  }

  /** Turns on the <name>.<subdomain>.workers.dev route. */
  async enableSubdomain(name: string): Promise<void> {
    await this.call(`/accounts/${this.accountId}/workers/scripts/${name}/subdomain`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
  }

  async workersSubdomain(): Promise<string> {
    const r = await this.call<{ subdomain: string }>(`/accounts/${this.accountId}/workers/subdomain`);
    return r.subdomain;
  }

  /** Pages through every key under a prefix. KV list is paginated at 1000. */
  async listKeys(nsId: string, prefix: string): Promise<{ name: string; expiration?: number }[]> {
    const out: { name: string; expiration?: number }[] = [];
    let cursor: string | undefined;
    do {
      const q = new URLSearchParams({ prefix, limit: "1000" });
      if (cursor) q.set("cursor", cursor);
      const res = await fetch(
        `${API}/accounts/${this.accountId}/storage/kv/namespaces/${nsId}/keys?${q}`,
        { headers: { Authorization: `Bearer ${this.token}` } },
      );
      const body = (await res.json()) as CfEnvelope<{ name: string; expiration?: number }[]>;
      if (!body.success) throw new Error(body.errors?.map((e) => e.message).join("; "));
      out.push(...body.result);
      cursor = body.result_info?.cursor || undefined;
    } while (cursor);
    return out;
  }

  async getValue(nsId: string, key: string): Promise<string | null> {
    const res = await fetch(
      `${API}/accounts/${this.accountId}/storage/kv/namespaces/${nsId}/values/${encodeURIComponent(key)}`,
      { headers: { Authorization: `Bearer ${this.token}` } },
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`KV read failed for ${key}: ${res.status}`);
    return res.text();
  }

  async deleteWorker(name: string): Promise<void> {
    await this.call(`/accounts/${this.accountId}/workers/scripts/${name}`, { method: "DELETE" });
  }

  async deleteNamespace(nsId: string): Promise<void> {
    await this.call(`/accounts/${this.accountId}/storage/kv/namespaces/${nsId}`, { method: "DELETE" });
  }

  async deleteKey(nsId: string, key: string): Promise<void> {
    await this.call(
      `/accounts/${this.accountId}/storage/kv/namespaces/${nsId}/values/${encodeURIComponent(key)}`,
      { method: "DELETE" },
    );
  }
}
