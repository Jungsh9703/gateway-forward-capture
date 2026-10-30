import type { GatewayIdentity } from "@cloudflare/zt-types";
import { resolveApp } from "./apps";
import type { Env } from "./env";
import { applyUploadAnswer, attachIdsOf, decompress, parseBody, responseFields, responseSender, uploadAnswer, type ParsedBody } from "./parse";
import { ensureSchema } from "./schema";

export interface CaptureMeta {
  id: string;
  ts: number;
  method: string;
  url: string;
  host: string;
  srcIp: string;
  internalSrcIp: string | null;
  policyId: string;
  contentType: string | null;
  contentEncoding: string | null;
  contentDisposition: string | null;
  contentLength: string | null;
  /** File name from an X-File-Name-style request header, if any. */
  fileNameHeader: string | null;
  userAgent: string | null;
  referer: string | null;
}

export interface ResponseMeta {
  status: number;
  contentType: string | null;
  contentEncoding: string | null;
}

export interface Bounded {
  bytes: Uint8Array;
  total: number;
  truncated: boolean;
}

export const DEFAULT_MAX_CAPTURE_BYTES = 25 * 1024 * 1024;
/** Responses are only kept for what they say (e.g. an upload's file name),
 * so a small cap is enough. */
export const MAX_RESPONSE_BYTES = 64 * 1024;
export const EMPTY: Bounded = { bytes: new Uint8Array(), total: 0, truncated: false };

/** Reads a teed copy up to max bytes, then cancels it -- cancelling one
 * tee branch never affects the branch still flowing on. Counts real bytes
 * rather than trusting Content-Length. */
export async function readBounded(stream: ReadableStream<Uint8Array>, max: number): Promise<Bounded> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let kept = 0;
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (kept + value.byteLength > max) {
      chunks.push(value.subarray(0, max - kept));
      kept = max;
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    kept += value.byteLength;
  }
  const bytes = new Uint8Array(kept);
  let off = 0;
  for (const c of chunks) {
    bytes.set(c, off);
    off += c.byteLength;
  }
  return { bytes, total, truncated };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A response body may still be content-encoded; use it as-is if it
 * already reads as text, otherwise try the declared encoding. */
function responseText(bytes: Uint8Array, encoding: string | null): Uint8Array {
  if (!encoding || bytes.length === 0) return bytes;
  const head = bytes[0];
  if (head === 0x7b || head === 0x5b) return bytes; // "{" or "[" -- already decoded
  try {
    return decompress(bytes, encoding);
  } catch {
    return bytes;
  }
}

async function fileStatements(env: Env, id: string, parsed: ParsedBody, bodyTruncated: boolean): Promise<D1PreparedStatement[]> {
  const stmts: D1PreparedStatement[] = [];
  for (const [idx, f] of parsed.files.entries()) {
    const key = `files/${id}/${idx}`;
    await env.CAPTURES.put(key, f.bytes, { httpMetadata: { contentType: "application/octet-stream" } });
    stmts.push(
      env.DB.prepare(
        `INSERT OR REPLACE INTO capture_files (capture_id, idx, file_name, content_type, size, sha256, truncated, r2_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(id, idx, f.fileName, f.contentType, f.bytes.length, await sha256Hex(f.bytes), f.truncated || bodyTruncated ? 1 : 0, key),
    );
  }
  return stmts;
}

function refStatements(db: D1Database, id: string, ids: string[]): D1PreparedStatement[] {
  return ids.map((a) => db.prepare(`INSERT OR IGNORE INTO capture_refs (capture_id, attach_id) VALUES (?, ?)`).bind(id, a));
}

export async function storeCapture(
  env: Env,
  meta: CaptureMeta,
  identity: GatewayIdentity | null,
  requestRead: Promise<Bounded> | null,
  resp: ResponseMeta,
  responseRead: Promise<Bounded> | null,
): Promise<void> {
  const { bytes: raw, total: read, truncated } = requestRead ? await requestRead : EMPTY;
  // Reading stops at the cap, so for a truncated body the real size comes
  // from Content-Length when the client sent one (otherwise it's a floor).
  const declared = Number(meta.contentLength);
  const total = truncated && Number.isFinite(declared) && declared > read ? declared : read;

  // A cut-off compressed body can't be inflated -- parse what we have as-is then.
  let body = raw;
  let decodeError: string | null = null;
  if (meta.contentEncoding && !truncated) {
    try {
      body = decompress(raw, meta.contentEncoding);
    } catch (err) {
      decodeError = `decompress ${meta.contentEncoding}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  const respBody = responseRead ? responseText((await responseRead).bytes, resp.contentEncoding) : null;
  const respFields = respBody ? responseFields(respBody) : [];

  const parsed = parseBody(body, meta.contentType, meta.url, meta.contentDisposition, meta.fileNameHeader);
  applyUploadAnswer(parsed, body, meta.contentType, total, truncated, uploadAnswer(respFields));
  fillSender(parsed, respFields, meta.host);
  const attachIds = [...new Set([...parsed.attachIds, ...attachIdsOf(respFields)])];
  if (parsed.kind === "other" && env.CAPTURE_OTHER === "false" && attachIds.length === 0) return;

  await ensureSchema(env.DB);
  const day = new Date(meta.ts).toISOString().slice(0, 10);
  const rawKey = `raw/${day}/${meta.id}`;
  await env.CAPTURES.put(rawKey, body, {
    httpMetadata: { contentType: "application/octet-stream" },
    customMetadata: { host: meta.host, method: meta.method, contentType: meta.contentType ?? "" },
  });
  let respKey: string | null = null;
  if (respBody && respBody.length > 0) {
    respKey = `resp/${day}/${meta.id}`;
    await env.CAPTURES.put(respKey, respBody, { httpMetadata: { contentType: "application/octet-stream" } });
  }

  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR REPLACE INTO captures
        (id, ts, user_email, user_name, src_ip, internal_src_ip, host, url, method, status, content_type, content_encoding,
         body_bytes, captured_bytes, truncated, kind, file_count, file_names, parse_error, raw_key, policy_id, user_agent, referer,
         resp_key, resp_bytes, resp_content_type, req_file_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      meta.id,
      meta.ts,
      identity?.email ?? null,
      identity?.name ?? null,
      meta.srcIp,
      meta.internalSrcIp,
      meta.host,
      meta.url,
      meta.method,
      resp.status,
      meta.contentType,
      meta.contentEncoding,
      total,
      raw.length,
      truncated ? 1 : 0,
      parsed.kind,
      parsed.files.length,
      JSON.stringify(parsed.files.map((f) => f.fileName)),
      [decodeError, parsed.parseError].filter(Boolean).join("; ") || null,
      rawKey,
      meta.policyId,
      meta.userAgent,
      meta.referer,
      respKey,
      respBody?.length ?? null,
      resp.contentType,
      meta.fileNameHeader,
    ),
    parsedUpdate(env.DB, meta.id, parsed),
    ...(await fileStatements(env, meta.id, parsed, truncated)),
    ...refStatements(env.DB, meta.id, attachIds),
  ]);

  await resolveApp(env, meta.host);
}

/** A send request rarely says who sends; the service's answer does (Naver:
 * UserName / UserId in the send response). Only fills what the request lacked. */
function fillSender(parsed: ParsedBody, respFields: [string, string][], host: string | null): void {
  if (parsed.kind !== "mail_send" || (parsed.mail.sender && parsed.mail.senderName)) return;
  const fromResp = responseSender(respFields, host);
  parsed.mail.sender ??= fromResp.email;
  parsed.mail.senderName ??= fromResp.name;
}

/** Everything derived from parsing the body -- shared by first capture and
 * reparseCaptures(), so improved parsing rules can be re-applied to stored
 * raw bodies. */
function parsedUpdate(db: D1Database, id: string, parsed: ParsedBody): D1PreparedStatement {
  const m = parsed.mail;
  const a = parsed.attachments;
  return db
    .prepare(
      `UPDATE captures SET kind = ?, sender = ?, sender_name = ?, to_addrs = ?, cc_addrs = ?, bcc_addrs = ?, subject = ?, field_names = ?,
         attach_count = ?, attach_size = ?, attach_names = ?, file_count = ?, file_names = ? WHERE id = ?`,
    )
    .bind(
      parsed.kind,
      m.sender,
      m.senderName,
      JSON.stringify(m.to),
      JSON.stringify(m.cc),
      JSON.stringify(m.bcc),
      m.subject,
      JSON.stringify(parsed.fieldNames),
      a.count,
      a.size,
      JSON.stringify(a.names),
      parsed.files.length,
      JSON.stringify(parsed.files.map((f) => f.fileName)),
      id,
    );
}

interface StoredRow {
  id: string;
  url: string;
  host: string | null;
  req_file_name: string | null;
  content_type: string | null;
  raw_key: string | null;
  resp_key: string | null;
  body_bytes: number | null;
  truncated: number;
}

/** Re-runs parsing over stored raw request + response bodies, oldest first,
 * one page per call (POST /api/reparse?offset=...). Rewrites each capture's
 * files and attachment IDs too, so uploads recognised by a newer rule get
 * their file stored and linked. Returns the next offset, or null when done. */
export async function reparseCaptures(env: Env, offset: number, limit: number): Promise<{ processed: number; nextOffset: number | null }> {
  await ensureSchema(env.DB);
  const rows = await env.DB.prepare(`SELECT id, url, host, req_file_name, content_type, raw_key, resp_key, body_bytes, truncated FROM captures ORDER BY ts LIMIT ? OFFSET ?`)
    .bind(limit, offset)
    .all<StoredRow>();
  for (const r of rows.results) {
    const reqObj = r.raw_key ? await env.CAPTURES.get(r.raw_key) : null;
    const body = reqObj ? new Uint8Array(await reqObj.arrayBuffer()) : new Uint8Array();
    const respObj = r.resp_key ? await env.CAPTURES.get(r.resp_key) : null;
    const respFields = respObj ? responseFields(new Uint8Array(await respObj.arrayBuffer())) : [];

    const parsed = parseBody(body, r.content_type, r.url, null, r.req_file_name);
    applyUploadAnswer(parsed, body, r.content_type, r.body_bytes ?? body.length, r.truncated === 1, uploadAnswer(respFields));
    fillSender(parsed, respFields, r.host);
    const attachIds = [...new Set([...parsed.attachIds, ...attachIdsOf(respFields)])];
    await env.DB.batch([
      parsedUpdate(env.DB, r.id, parsed),
      env.DB.prepare(`DELETE FROM capture_files WHERE capture_id = ?`).bind(r.id),
      ...(await fileStatements(env, r.id, parsed, r.truncated === 1)),
      env.DB.prepare(`DELETE FROM capture_refs WHERE capture_id = ?`).bind(r.id),
      ...refStatements(env.DB, r.id, attachIds),
    ]);
  }
  return { processed: rows.results.length, nextOffset: rows.results.length === limit ? offset + limit : null };
}
