import type { Env } from "./env";

/**
 * Host -> Gateway application name. Forward's context carries no
 * application, so a request's host is looked up in Cloudflare's
 * Resource Library (the App Library behind Gateway's "Application"
 * selector): GET /accounts/{id}/resource-library/applications
 * ?filter=hostname:<host>. Results are cached per host in D1 (host_apps)
 * and joined at query time, so a corrected mapping also fixes past rows.
 * Rows with source = 'manual' are never overwritten.
 */

const DEFAULT_API_BASE = "https://api.cloudflare.com/client/v4";
const FRESH_MS = 7 * 86_400_000;
/** "No app for this host" is re-checked sooner, in case the library grows. */
const NEGATIVE_FRESH_MS = 86_400_000;

interface LibraryApp {
  id: number;
  name: string;
  hostnames?: string[];
  support_domains?: string[];
  supported?: string[];
}

interface HostAppRow {
  app_name: string | null;
  source: string;
  fetched_at: number;
}

/** mail.naver.com -> [mail.naver.com, naver.com]; never a bare TLD. */
function candidates(host: string): string[] {
  const labels = host.toLowerCase().replace(/:\d+$/, "").split(".").filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i <= labels.length - 2; i++) out.push(labels.slice(i).join("."));
  return out;
}

async function queryLibrary(env: Env, hostname: string): Promise<LibraryApp[]> {
  const base = env.CF_API_BASE || DEFAULT_API_BASE;
  const url = new URL(`${base}/accounts/${env.CF_ACCOUNT_ID}/resource-library/applications`);
  url.searchParams.set("filter", `hostname:${hostname}`);
  url.searchParams.set("fields", "id,name,hostnames,support_domains,supported");
  url.searchParams.set("limit", "10");
  const res = await fetch(url, { headers: { authorization: `Bearer ${env.CF_API_TOKEN}` } });
  if (!res.ok) throw new Error(`resource-library ${res.status}`);
  const body = (await res.json()) as { result?: LibraryApp[] };
  return body.result ?? [];
}

/**
 * Prefer an app that lists the hostname as its own, and one usable in
 * Gateway. Support domains are shared helpers (e.g. naver.com for Naver
 * Mail), so they only count for an exact host match -- reaching one by
 * walking up from www.naver.com would label search traffic as Naver Mail.
 */
function pick(apps: LibraryApp[], hostname: string, exact: boolean): { app: LibraryApp; via: "hostname" | "support_domain" } | null {
  const norm = (h: string) => h.toLowerCase().replace(/^\*\./, "");
  const own = (a: LibraryApp) => (a.hostnames ?? []).some((h) => norm(h) === hostname);
  const support = (a: LibraryApp) => (a.support_domains ?? []).some((h) => norm(h) === hostname);
  const gw = (a: LibraryApp) => (a.supported ?? []).includes("GATEWAY");
  const ranked = [...apps].sort((a, b) => Number(gw(b)) - Number(gw(a)));
  const byOwn = ranked.find(own);
  if (byOwn) return { app: byOwn, via: "hostname" };
  if (!exact) return null;
  const bySupport = ranked.find(support);
  if (bySupport) return { app: bySupport, via: "support_domain" };
  // The filter matched the exact host but no entry lists it verbatim (e.g. wildcard rules) -- still the library's answer.
  return ranked.find((a) => !support(a)) ? { app: ranked.find((a) => !support(a))!, via: "hostname" } : null;
}

/** Fills host_apps for host if missing or stale. Never throws; a failed
 * lookup just leaves the row absent so the next capture retries. */
export async function resolveApp(env: Env, host: string | null): Promise<void> {
  if (!host || !env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) return;
  const key = host.toLowerCase();
  try {
    const row = await env.DB.prepare(`SELECT app_name, source, fetched_at FROM host_apps WHERE host = ?`).bind(key).first<HostAppRow>();
    if (row) {
      if (row.source === "manual") return;
      const age = Date.now() - row.fetched_at;
      if (age < (row.app_name ? FRESH_MS : NEGATIVE_FRESH_MS)) return;
    }

    let found: { app: LibraryApp; via: string; matched: string } | null = null;
    for (const c of candidates(key)) {
      const hit = pick(await queryLibrary(env, c), c, c === key);
      if (hit) {
        found = { ...hit, matched: c };
        break;
      }
    }

    await env.DB.prepare(
      `INSERT OR REPLACE INTO host_apps (host, app_name, app_id, matched_hostname, matched_via, source, fetched_at)
       VALUES (?, ?, ?, ?, ?, 'api', ?)`,
    )
      .bind(key, found?.app.name ?? null, found?.app.id ?? null, found?.matched ?? null, found?.via ?? null, Date.now())
      .run();
  } catch (err) {
    console.error("app lookup failed", host, err);
  }
}
