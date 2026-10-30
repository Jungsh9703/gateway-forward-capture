import type { GatewayIdentity } from "@cloudflare/zt-types";
import { resolveApp } from "./apps";
import type { Env } from "./env";
import { decompress, parseBody } from "./parse";
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
  userAgent: string | null;
  referer: string | null;
}

const DEFAULT_MAX_CAPTURE_BYTES = 25 * 1024 * 1024;

/** Reads the teed copy up to max bytes, then cancels it -- cancelling one
 * tee branch never affects the branch still flowing to the origin. Counts
 * real bytes rather than trusting Content-Length. */
async function readBounded(stream: ReadableStream<Uint8Array>, max: number): Promise<{ bytes: Uint8Array; total: number; truncated: boolean }> {
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

export async function storeCapture(
  env: Env,
  meta: CaptureMeta,
  identity: GatewayIdentity | null,
  copy: ReadableStream<Uint8Array> | null,
  status: number,
): Promise<void> {
  const max = Number(env.MAX_CAPTURE_BYTES ?? DEFAULT_MAX_CAPTURE_BYTES);
  const { bytes: raw, total: read, truncated } = copy ? await readBounded(copy, max) : { bytes: new Uint8Array(), total: 0, truncated: false };
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

  const parsed = parseBody(body, meta.contentType, meta.url, meta.contentDisposition);
  if (parsed.kind === "other" && env.CAPTURE_OTHER === "false") return;

  await ensureSchema(env.DB);
  const day = new Date(meta.ts).toISOString().slice(0, 10);
  const rawKey = `raw/${day}/${meta.id}`;
  await env.CAPTURES.put(rawKey, body, {
    httpMetadata: { contentType: "application/octet-stream" },
    customMetadata: { host: meta.host, method: meta.method, contentType: meta.contentType ?? "" },
  });

  const fileStmts: D1PreparedStatement[] = [];
  for (const [idx, f] of parsed.files.entries()) {
    const key = `files/${meta.id}/${idx}`;
    await env.CAPTURES.put(key, f.bytes, { httpMetadata: { contentType: "application/octet-stream" } });
    fileStmts.push(
      env.DB.prepare(
        `INSERT OR REPLACE INTO capture_files (capture_id, idx, file_name, content_type, size, sha256, truncated, r2_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(meta.id, idx, f.fileName, f.contentType, f.bytes.length, await sha256Hex(f.bytes), f.truncated || truncated ? 1 : 0, key),
    );
  }

  const m = parsed.mail;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR REPLACE INTO captures
        (id, ts, user_email, user_name, src_ip, internal_src_ip, host, url, method, status, content_type, content_encoding,
         body_bytes, captured_bytes, truncated, kind, sender, to_addrs, cc_addrs, bcc_addrs, subject,
         file_count, file_names, field_names, parse_error, raw_key, policy_id, user_agent, referer)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      status,
      meta.contentType,
      meta.contentEncoding,
      total,
      raw.length,
      truncated ? 1 : 0,
      parsed.kind,
      m.sender,
      JSON.stringify(m.to),
      JSON.stringify(m.cc),
      JSON.stringify(m.bcc),
      m.subject,
      parsed.files.length,
      JSON.stringify(parsed.files.map((f) => f.fileName)),
      JSON.stringify(parsed.fieldNames),
      [decodeError, parsed.parseError].filter(Boolean).join("; ") || null,
      rawKey,
      meta.policyId,
      meta.userAgent,
      meta.referer,
    ),
    ...fileStmts,
  ]);

  await resolveApp(env, meta.host);
}
