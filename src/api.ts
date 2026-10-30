import type { Env } from "./env";
import { authorize, fileDownload, json } from "./http_util";
import { ensureSchema } from "./schema";

/**
 * Dashboard API (all token-gated):
 *   GET /api/summary                      totals, per-day counts, top apps/users/recipients/hosts
 *   GET /api/captures                     list
 *   GET /api/captures/<id>                one capture + its files
 *   GET /api/captures/<id>/preview        first 256 KiB of the raw body as text
 *   GET /api/captures/<id>/raw            raw body download
 *   GET /api/captures/<id>/files/<idx>    extracted file download
 *   GET /api/status                       counts + last capture time
 * /api/summary and /api/captures share the same filters (buildFilter).
 */

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const PREVIEW_BYTES = 256 * 1024;
const TOP_N = 5;
const KINDS = new Set(["mail_send", "attachment", "other"]);

/** Every read goes through this join so the application name (host_apps,
 * see apps.ts) is current even for captures made before the mapping existed. */
const FROM = `FROM captures c LEFT JOIN host_apps a ON a.host = lower(c.host)`;

interface CaptureRow {
  id: string;
  ts: number;
  user_email: string | null;
  user_name: string | null;
  src_ip: string | null;
  host: string | null;
  url: string | null;
  method: string | null;
  status: number | null;
  content_type: string | null;
  body_bytes: number | null;
  captured_bytes: number | null;
  truncated: number;
  kind: string;
  sender: string | null;
  to_addrs: string | null;
  cc_addrs: string | null;
  bcc_addrs: string | null;
  subject: string | null;
  file_count: number;
  file_names: string | null;
  field_names: string | null;
  parse_error: string | null;
  raw_key: string | null;
  user_agent: string | null;
  referer: string | null;
  app_name: string | null;
}

interface FileRow {
  idx: number;
  file_name: string | null;
  content_type: string | null;
  size: number;
  sha256: string;
  truncated: number;
  r2_key: string;
}

const arr = (s: string | null): string[] => {
  try {
    const v = JSON.parse(s ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

function toItem(r: CaptureRow) {
  let path = r.url;
  try {
    const u = new URL(r.url ?? "");
    path = u.pathname + u.search;
  } catch {
    /* keep url */
  }
  return {
    id: r.id,
    time: new Date(r.ts).toISOString(),
    user: r.user_email,
    userName: r.user_name,
    application: r.app_name,
    sender: r.sender,
    to: arr(r.to_addrs),
    cc: arr(r.cc_addrs),
    bcc: arr(r.bcc_addrs),
    subject: r.subject,
    host: r.host,
    path,
    url: r.url,
    method: r.method,
    status: r.status,
    kind: r.kind,
    fileNames: arr(r.file_names),
    fileCount: r.file_count,
    bodyBytes: r.body_bytes,
    capturedBytes: r.captured_bytes,
    truncated: r.truncated === 1,
    contentType: r.content_type,
    srcIp: r.src_ip,
  };
}

function parseBound(v: string | null, endOfDay: boolean): number | null {
  if (!v) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const start = Date.parse(`${v}T00:00:00Z`);
    return Number.isNaN(start) ? NaN : endOfDay ? start + 86_400_000 : start;
  }
  return Date.parse(v);
}

const like = (v: string) => `%${v.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

const TEXT_FILTERS: [param: string, expr: string][] = [
  ["user", "c.user_email"],
  ["app", "COALESCE(a.app_name, '')"],
  ["sender", "c.sender"],
  ["recipient", "(COALESCE(c.to_addrs,'') || COALESCE(c.cc_addrs,'') || COALESCE(c.bcc_addrs,''))"],
  ["host", "c.host"],
  ["path", "c.url"],
  ["subject", "c.subject"],
  ["file", "c.file_names"],
];

interface Filter {
  where: string;
  args: (string | number)[];
}

/** from/to: YYYY-MM-DD (to inclusive of that day) or ISO; kind: comma list;
 * text filters: case-insensitive contains; app=(unknown) matches captures
 * whose host has no known application. */
function buildFilter(p: URLSearchParams): Filter | Response {
  const where: string[] = [];
  const args: (string | number)[] = [];
  const from = parseBound(p.get("from"), false);
  const to = parseBound(p.get("to"), true);
  if (Number.isNaN(from) || Number.isNaN(to)) return json({ error: "from/to must be YYYY-MM-DD or an ISO timestamp" }, 400);
  if (from !== null) where.push("c.ts >= ?"), args.push(from);
  if (to !== null) where.push("c.ts < ?"), args.push(to);

  const kinds = (p.get("kind") ?? "").split(",").filter((k) => KINDS.has(k));
  if (kinds.length) where.push(`c.kind IN (${kinds.map(() => "?").join(",")})`), args.push(...kinds);

  for (const [param, expr] of TEXT_FILTERS) {
    const v = p.get(param)?.trim();
    if (!v) continue;
    if (param === "app" && v === "(unknown)") where.push("a.app_name IS NULL");
    else where.push(`${expr} LIKE ? ESCAPE '\\'`), args.push(like(v));
  }
  return { where: where.length ? `WHERE ${where.join(" AND ")}` : "", args };
}

async function handleList(url: URL, env: Env): Promise<Response> {
  const p = url.searchParams;
  const f = buildFilter(p);
  if (f instanceof Response) return f;
  const limit = Math.min(Math.max(Number(p.get("limit") ?? DEFAULT_LIMIT) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offset = Math.max(Number(p.get("offset") ?? 0) || 0, 0);

  const [rows, totals] = await env.DB.batch([
    env.DB.prepare(`SELECT c.*, a.app_name ${FROM} ${f.where} ORDER BY c.ts DESC LIMIT ? OFFSET ?`).bind(...f.args, limit, offset),
    env.DB.prepare(`SELECT count(*) AS total ${FROM} ${f.where}`).bind(...f.args),
  ]);
  const total = (totals!.results[0] as { total: number }).total;
  return json({ total, limit, offset, items: (rows!.results as CaptureRow[]).map(toItem) });
}

/** Recipients are JSON arrays per row; json_each fans them out for ranking. */
async function handleSummary(url: URL, env: Env): Promise<Response> {
  const f = buildFilter(url.searchParams);
  if (f instanceof Response) return f;
  const and = f.where ? `${f.where} AND` : "WHERE";

  const [totals, byDay, apps, users, recipients, hosts] = await env.DB.batch([
    env.DB.prepare(
      `SELECT count(*) AS captures, COALESCE(sum(c.kind = 'mail_send'), 0) AS mails, COALESCE(sum(c.kind = 'attachment'), 0) AS attachments,
              COALESCE(sum(c.file_count), 0) AS files, count(DISTINCT c.user_email) AS users,
              count(DISTINCT a.app_name) AS apps, COALESCE(sum(c.body_bytes), 0) AS bytes
       ${FROM} ${f.where}`,
    ).bind(...f.args),
    env.DB.prepare(`SELECT strftime('%Y-%m-%d', c.ts / 1000, 'unixepoch') AS day, count(*) AS n ${FROM} ${f.where} GROUP BY day ORDER BY day`).bind(...f.args),
    env.DB.prepare(
      `SELECT COALESCE(a.app_name, '(unknown)') AS label, count(*) AS n ${FROM} ${f.where} GROUP BY label ORDER BY n DESC, label LIMIT ${TOP_N}`,
    ).bind(...f.args),
    env.DB.prepare(`SELECT c.user_email AS label, count(*) AS n ${FROM} ${and} c.user_email IS NOT NULL GROUP BY label ORDER BY n DESC, label LIMIT ${TOP_N}`).bind(
      ...f.args,
    ),
    env.DB.prepare(
      `WITH m AS (SELECT c.to_addrs, c.cc_addrs, c.bcc_addrs ${FROM} ${f.where})
       SELECT label, count(*) AS n FROM (
         SELECT j.value AS label FROM m, json_each(COALESCE(m.to_addrs, '[]')) j
         UNION ALL SELECT j.value FROM m, json_each(COALESCE(m.cc_addrs, '[]')) j
         UNION ALL SELECT j.value FROM m, json_each(COALESCE(m.bcc_addrs, '[]')) j
       ) GROUP BY label ORDER BY n DESC, label LIMIT ${TOP_N}`,
    ).bind(...f.args),
    env.DB.prepare(`SELECT c.host AS label, count(*) AS n ${FROM} ${and} c.host IS NOT NULL GROUP BY label ORDER BY n DESC, label LIMIT ${TOP_N}`).bind(...f.args),
  ]);

  return json({
    ...(totals!.results[0] as Record<string, number>),
    byDay: byDay!.results,
    topApps: apps!.results,
    topUsers: users!.results,
    topRecipients: recipients!.results,
    topHosts: hosts!.results,
  });
}

async function getCapture(env: Env, id: string): Promise<CaptureRow | null> {
  return env.DB.prepare(`SELECT c.*, a.app_name ${FROM} WHERE c.id = ?`).bind(id).first<CaptureRow>();
}

async function handleOne(env: Env, id: string): Promise<Response> {
  const row = await getCapture(env, id);
  if (!row) return json({ error: "not found" }, 404);
  const files = await env.DB.prepare(`SELECT idx, file_name, content_type, size, sha256, truncated, r2_key FROM capture_files WHERE capture_id = ? ORDER BY idx`)
    .bind(id)
    .all<FileRow>();
  return json({
    ...toItem(row),
    fieldNames: arr(row.field_names),
    parseError: row.parse_error,
    userAgent: row.user_agent,
    referer: row.referer,
    files: files.results.map((f) => ({
      idx: f.idx,
      fileName: f.file_name,
      contentType: f.content_type,
      size: f.size,
      sha256: f.sha256,
      truncated: f.truncated === 1,
      downloadPath: `/api/captures/${id}/files/${f.idx}`,
    })),
  });
}

async function handlePreview(env: Env, id: string): Promise<Response> {
  const row = await getCapture(env, id);
  if (!row?.raw_key) return json({ error: "not found" }, 404);
  const obj = await env.CAPTURES.get(row.raw_key, { range: { offset: 0, length: PREVIEW_BYTES } });
  if (!obj) return json({ error: "raw body missing from R2" }, 404);
  const bytes = new Uint8Array(await obj.arrayBuffer());
  const text = new TextDecoder("utf-8").decode(bytes);
  // Mostly-unprintable bodies (binary uploads) aren't worth showing as text.
  const unprintable = [...text.slice(0, 4096)].filter((c) => c === "�" || (c < " " && !"\n\r\t".includes(c))).length;
  const isText = text.length === 0 || unprintable / Math.min(text.length, 4096) < 0.1;
  return json({ isText, text: isText ? text : null, shownBytes: bytes.length, totalBytes: obj.size });
}

async function handleRaw(env: Env, id: string): Promise<Response> {
  const row = await getCapture(env, id);
  if (!row?.raw_key) return json({ error: "not found" }, 404);
  const obj = await env.CAPTURES.get(row.raw_key);
  if (!obj) return json({ error: "raw body missing from R2" }, 404);
  return fileDownload(obj.body, `${row.host ?? "request"}-${id}.txt`);
}

async function handleFile(env: Env, id: string, idx: number): Promise<Response> {
  const f = await env.DB.prepare(`SELECT file_name, r2_key FROM capture_files WHERE capture_id = ? AND idx = ?`)
    .bind(id, idx)
    .first<{ file_name: string | null; r2_key: string }>();
  if (!f) return json({ error: "not found" }, 404);
  const obj = await env.CAPTURES.get(f.r2_key);
  if (!obj) return json({ error: "file missing from R2" }, 404);
  return fileDownload(obj.body, f.file_name ?? `${id}-${idx}.bin`);
}

async function handleStatus(env: Env): Promise<Response> {
  const r = await env.DB.prepare(
    `SELECT count(*) AS captures, COALESCE(sum(kind = 'mail_send'), 0) AS mails, COALESCE(sum(kind = 'attachment'), 0) AS attachments,
            COALESCE(sum(kind = 'other'), 0) AS other, max(ts) AS last_ts FROM captures`,
  ).first<{ captures: number; mails: number; attachments: number; other: number; last_ts: number | null }>();
  return json({
    ...r,
    lastCapture: r?.last_ts ? new Date(r.last_ts).toISOString() : null,
    appLookup: Boolean(env.CF_ACCOUNT_ID && env.CF_API_TOKEN),
  });
}

export async function handleApi(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/")) return null;
  const denied = authorize(request, env);
  if (denied) return denied;
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
  await ensureSchema(env.DB);

  if (url.pathname === "/api/summary") return handleSummary(url, env);
  if (url.pathname === "/api/captures") return handleList(url, env);
  if (url.pathname === "/api/status") return handleStatus(env);
  const m = /^\/api\/captures\/([0-9a-f-]{36})(?:\/(preview|raw|files\/(\d+)))?$/.exec(url.pathname);
  if (m) {
    const id = m[1]!;
    if (!m[2]) return handleOne(env, id);
    if (m[2] === "preview") return handlePreview(env, id);
    if (m[2] === "raw") return handleRaw(env, id);
    return handleFile(env, id, Number(m[3]));
  }
  return json({ error: "Not found" }, 404);
}
