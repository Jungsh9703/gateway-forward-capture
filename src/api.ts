import type { Env } from "./env";
import { reparseCaptures } from "./capture";
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
 *   POST /api/reparse?offset=N            re-apply parsing rules to stored raw bodies (one page)
 * /api/summary and /api/captures share the same filters (buildFilter).
 */

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const PREVIEW_BYTES = 256 * 1024;
const TOP_N = 5;
const KINDS = new Set(["mail_send", "attachment", "other"]);

/** Every read goes through this join so the application name (host_apps,
 * see apps.ts) is current even for captures made before the mapping existed. */
/** Bytes of files actually extracted from the body (multipart/raw uploads). */
const FILES_BYTES = `(SELECT sum(f.size) FROM capture_files f WHERE f.capture_id = c.id)`;

/**
 * Files a mail send refers to but doesn't carry -- the ones uploaded
 * earlier (Naver Mail uploads first, then sends with aId=...). Linked by a
 * shared attachment ID (capture_refs); when no ID links up, by the same
 * user's single upload in the 30 minutes before a one-attachment send
 * whose size equals the send's stated size (aSize). JSON array of
 * {name, size, sha256, captureId, idx, via}.
 */
const LINKED_FILES = `(SELECT json_group_array(json_object('name', l.file_name, 'size', l.size, 'sha256', l.sha256, 'captureId', l.capture_id, 'idx', l.idx, 'via', l.via)) FROM (
    SELECT DISTINCT cf.capture_id, cf.idx, cf.file_name, cf.size, cf.sha256, 'attach_id' AS via
    FROM capture_refs s
    JOIN capture_refs u ON u.attach_id = s.attach_id AND u.capture_id <> s.capture_id
    JOIN capture_files cf ON cf.capture_id = u.capture_id
    WHERE s.capture_id = c.id
    UNION ALL
    SELECT cf.capture_id, cf.idx, cf.file_name, cf.size, cf.sha256, 'size_time'
    FROM captures u JOIN capture_files cf ON cf.capture_id = u.id
    WHERE c.kind = 'mail_send' AND c.attach_count = 1 AND c.attach_size IS NOT NULL
      AND u.id <> c.id AND u.kind <> 'mail_send' AND u.user_email IS c.user_email
      AND u.ts BETWEEN c.ts - 1800000 AND c.ts AND cf.size = c.attach_size
      AND NOT EXISTS (
        SELECT 1 FROM capture_refs s2 JOIN capture_refs u2 ON u2.attach_id = s2.attach_id AND u2.capture_id <> s2.capture_id
        JOIN capture_files cf2 ON cf2.capture_id = u2.capture_id WHERE s2.capture_id = c.id)
  ) l)`;

/** Every read goes through this so the application name (host_apps, see
 * apps.ts) and linked files are current even for older captures; filters
 * and aggregates refer to these columns as c.*. */
const FROM = `FROM (SELECT c.*, a.app_name, ${FILES_BYTES} AS files_bytes, ${LINKED_FILES} AS linked_files
  FROM captures c LEFT JOIN host_apps a ON a.host = lower(c.host)) c`;
const COLS = `c.*`;

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
  sender_name: string | null;
  to_addrs: string | null;
  cc_addrs: string | null;
  bcc_addrs: string | null;
  subject: string | null;
  file_count: number;
  file_names: string | null;
  attach_count: number | null;
  attach_size: number | null;
  attach_names: string | null;
  files_bytes: number | null;
  linked_files: string | null;
  resp_key: string | null;
  resp_content_type: string | null;
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

interface LinkedFile {
  name: string | null;
  size: number;
  sha256: string;
  captureId: string;
  idx: number;
  via: "attach_id" | "size_time";
}

const linkedCache = new WeakMap<CaptureRow, LinkedFile[]>();
function linked(r: CaptureRow): LinkedFile[] {
  let v = linkedCache.get(r);
  if (!v) {
    v = (arr(r.linked_files) as unknown as LinkedFile[]).filter((f) => f && f.captureId);
    linkedCache.set(r, v);
  }
  return v;
}

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
    senderName: r.sender_name,
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
    // Files carried in this body, ones it names, and uploads linked to it (see LINKED_FILES).
    fileNames: [...new Set([...linked(r).map((f) => f.name), ...arr(r.file_names), ...arr(r.attach_names)].filter((n): n is string => !!n))],
    fileCount: Math.max(r.file_count, r.attach_count ?? 0, linked(r).length),
    attachSize: r.attach_size ?? r.files_bytes ?? (linked(r).length ? linked(r).reduce((n, f) => n + f.size, 0) : null),
    linkedFiles: linked(r).map((f) => ({ ...f, downloadPath: `/api/captures/${f.captureId}/files/${f.idx}` })),
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
  ["app", "COALESCE(c.app_name, '')"],
  ["sender", "(COALESCE(c.sender,'') || ' ' || COALESCE(c.sender_name,''))"],
  ["recipient", "(COALESCE(c.to_addrs,'') || COALESCE(c.cc_addrs,'') || COALESCE(c.bcc_addrs,''))"],
  ["host", "c.host"],
  ["path", "c.url"],
  ["subject", "c.subject"],
  ["file", "(COALESCE(c.file_names,'') || COALESCE(c.attach_names,'') || COALESCE(c.linked_files,''))"],
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
    if (param === "app" && v === "(unknown)") where.push("c.app_name IS NULL");
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
    env.DB.prepare(`SELECT ${COLS} ${FROM} ${f.where} ORDER BY c.ts DESC LIMIT ? OFFSET ?`).bind(...f.args, limit, offset),
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
              COALESCE(sum(max(c.file_count, COALESCE(c.attach_count, 0))), 0) AS files, count(DISTINCT c.user_email) AS users,
              count(DISTINCT c.app_name) AS apps, COALESCE(sum(COALESCE(c.attach_size, c.files_bytes)), 0) AS bytes
       ${FROM} ${f.where}`,
    ).bind(...f.args),
    env.DB.prepare(`SELECT strftime('%Y-%m-%d', c.ts / 1000, 'unixepoch') AS day, count(*) AS n ${FROM} ${f.where} GROUP BY day ORDER BY day`).bind(...f.args),
    env.DB.prepare(
      `SELECT COALESCE(c.app_name, '(unknown)') AS label, count(*) AS n ${FROM} ${f.where} GROUP BY label ORDER BY n DESC, label LIMIT ${TOP_N}`,
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
  return env.DB.prepare(`SELECT ${COLS} ${FROM} WHERE c.id = ?`).bind(id).first<CaptureRow>();
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
  // The captured response (small JSON/text only) -- where e.g. Naver's upload answer carries the file name.
  const respObj = row.resp_key ? await env.CAPTURES.get(row.resp_key) : null;
  const response = respObj ? { text: new TextDecoder("utf-8").decode(await respObj.arrayBuffer()), contentType: row.resp_content_type } : null;
  return json({ isText, text: isText ? text : null, shownBytes: bytes.length, totalBytes: obj.size, response });
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

const DEBUG_MAX_ROWS = 80;
const DEBUG_RESPONSE_CHARS = 500;

/**
 * GET /api/debug?minutes=N -- every capture (all kinds, including the
 * "other" POSTs the dashboard hides) in the last N minutes, oldest first,
 * for working out where a service puts what (e.g. a large-file name). URL
 * query *values* are left out -- only parameter names -- and responses are
 * cut to their first 500 characters.
 */
async function handleDebug(url: URL, env: Env): Promise<Response> {
  const minutes = Math.min(Math.max(Number(url.searchParams.get("minutes") ?? 15) || 15, 1), 24 * 60);
  const since = Date.now() - minutes * 60_000;
  const rows = await env.DB.prepare(
    `SELECT c.id, c.ts, c.kind, c.method, c.host, c.url, c.content_type, c.body_bytes, c.captured_bytes, c.truncated, c.field_names,
            c.file_names, c.attach_names, c.attach_count, c.attach_size, c.resp_key, c.resp_content_type, c.status,
            (SELECT json_group_array(r.attach_id) FROM capture_refs r WHERE r.capture_id = c.id) AS attach_ids,
            (SELECT json_group_array(json_object('name', f.file_name, 'size', f.size, 'sha256', f.sha256)) FROM capture_files f WHERE f.capture_id = c.id) AS files
     FROM captures c WHERE c.ts >= ? ORDER BY c.ts LIMIT ${DEBUG_MAX_ROWS}`,
  )
    .bind(since)
    .all<Record<string, string | number | null>>();

  const items = [];
  for (const r of rows.results) {
    let path = String(r.url ?? "");
    let queryKeys: string[] = [];
    try {
      const u = new URL(path);
      path = u.pathname;
      queryKeys = [...new Set([...u.searchParams.keys()])];
    } catch {
      /* keep raw */
    }
    let response: string | null = null;
    if (r.resp_key) {
      const obj = await env.CAPTURES.get(String(r.resp_key), { range: { offset: 0, length: DEBUG_RESPONSE_CHARS * 4 } });
      if (obj) response = new TextDecoder("utf-8").decode(await obj.arrayBuffer()).slice(0, DEBUG_RESPONSE_CHARS);
    }
    items.push({
      id: r.id,
      time: new Date(Number(r.ts)).toISOString(),
      kind: r.kind,
      method: r.method,
      host: r.host,
      path,
      queryKeys,
      status: r.status,
      contentType: r.content_type,
      bodyBytes: r.body_bytes,
      capturedBytes: r.captured_bytes,
      truncated: r.truncated === 1,
      fieldNames: arr(r.field_names as string | null),
      attachIds: arr(r.attach_ids as string | null),
      files: arr(r.files as string | null),
      attachNames: arr(r.attach_names as string | null),
      attachCount: r.attach_count,
      attachSize: r.attach_size,
      responseType: r.resp_content_type,
      response,
    });
  }
  return json({ minutes, since: new Date(since).toISOString(), count: items.length, capped: items.length === DEBUG_MAX_ROWS, items });
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
  await ensureSchema(env.DB);
  if (url.pathname === "/api/reparse") {
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
    const offset = Math.max(Number(url.searchParams.get("offset") ?? 0) || 0, 0);
    return json(await reparseCaptures(env, offset, 100));
  }
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);

  if (url.pathname === "/api/summary") return handleSummary(url, env);
  if (url.pathname === "/api/captures") return handleList(url, env);
  if (url.pathname === "/api/status") return handleStatus(env);
  if (url.pathname === "/api/debug") return handleDebug(url, env);
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
