import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export const CONFIG_FILE = "formkv.json";

/** A field collected by the form. `email` is always present and always the key. */
export type Field = {
  readonly name: string;
  readonly type: "email" | "text" | "url" | "number" | "choice";
  readonly required?: boolean;
  /** Rejected above this many characters. Ignored for `number`. */
  readonly maxLength?: number;
  /** Allowed values for `choice`. */
  readonly options?: readonly string[];
};

export type Config = {
  /** Used to name the Worker and the KV namespace. */
  readonly name: string;
  readonly accountId: string;
  readonly kvNamespaceId: string;
  /** Browser origins allowed to POST. Never "*" — that lets any site sign people up. */
  readonly allowedOrigins: readonly string[];
  readonly fields: readonly Field[];
  /** Hidden input a bot fills and a human never sees. Empty string disables it. */
  readonly honeypot: string;
  readonly rateLimit: { readonly max: number; readonly windowSeconds: number } | null;
  /**
   * Days before a signup is deleted. `null` keeps signups forever, which is the
   * default on purpose — a waitlist that silently forgets people is a data-loss bug,
   * not a retention policy.
   */
  readonly retentionDays: number | null;
  readonly messages: {
    readonly success: string;
    readonly duplicate: string;
    readonly rateLimited: string;
  };
  /** Where the "back" link on the no-JS confirmation page points. */
  readonly siteUrl: string;
  /**
   * Shown on the error page only, so a failed submission is not a dead end:
   * "…or email <address> and we'll add you by hand." Empty string omits it.
   */
  readonly supportEmail: string;
  readonly workerUrl?: string;
};

export const DEFAULT_FIELDS: readonly Field[] = [
  { name: "email", type: "email", required: true },
];

export function defaultConfig(name: string, accountId: string, kvNamespaceId: string): Config {
  return {
    name,
    accountId,
    kvNamespaceId,
    allowedOrigins: [],
    fields: DEFAULT_FIELDS,
    honeypot: "company",
    rateLimit: { max: 5, windowSeconds: 3600 },
    retentionDays: null,
    messages: {
      success: "You're on the waitlist.",
      duplicate: "You're already on the waitlist.",
      rateLimited: "Too many attempts. Please try again later.",
    },
    siteUrl: "",
    supportEmail: "",
  };
}

const IDENT = /^[a-z][a-z0-9_]*$/;

/** Throws on anything that would produce a broken or unsafe Worker. */
export function validate(c: Config): void {
  const bad: string[] = [];
  if (!c.accountId) bad.push("accountId is empty");
  if (!c.kvNamespaceId) bad.push("kvNamespaceId is empty");
  if (!c.name) bad.push("name is empty");

  const emails = c.fields.filter((f) => f.type === "email");
  if (emails.length !== 1 || emails[0]?.name !== "email") {
    bad.push('fields must contain exactly one field named "email" of type "email"');
  }
  for (const f of c.fields) {
    if (!IDENT.test(f.name)) bad.push(`field "${f.name}": name must match ${IDENT}`);
    if (f.type === "choice" && !f.options?.length) {
      bad.push(`field "${f.name}": type "choice" needs a non-empty options list`);
    }
  }
  if (c.honeypot && c.fields.some((f) => f.name === c.honeypot)) {
    bad.push(`honeypot "${c.honeypot}" collides with a real field name`);
  }
  if (c.allowedOrigins.includes("*")) {
    bad.push('allowedOrigins must not contain "*" — any site could then sign people up');
  }
  for (const o of c.allowedOrigins) {
    if (!/^https?:\/\//.test(o)) bad.push(`allowedOrigins: "${o}" must include a scheme`);
    if (o.endsWith("/")) bad.push(`allowedOrigins: "${o}" must not end with a slash`);
  }
  if (c.rateLimit && (c.rateLimit.max < 1 || c.rateLimit.windowSeconds < 60)) {
    bad.push("rateLimit.max must be >= 1 and windowSeconds >= 60");
  }
  if (c.retentionDays !== null && c.retentionDays < 1) {
    bad.push("retentionDays must be null or >= 1");
  }
  if (bad.length) throw new Error(`${CONFIG_FILE} is invalid:\n  - ${bad.join("\n  - ")}`);
}

export async function loadConfig(dir = process.cwd()): Promise<Config> {
  const path = resolve(dir, CONFIG_FILE);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new Error(`no ${CONFIG_FILE} here. Run "formkv init" first.`);
  }
  const cfg = JSON.parse(raw) as Config;
  validate(cfg);
  return cfg;
}

export async function saveConfig(c: Config, dir = process.cwd()): Promise<string> {
  const path = resolve(dir, CONFIG_FILE);
  await writeFile(path, JSON.stringify(c, null, 2) + "\n");
  return path;
}
