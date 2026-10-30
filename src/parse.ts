import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";

/**
 * Turns one captured request body (already plaintext -- Gateway decrypted
 * TLS before Forward) into mail fields + attached files. Naver Mail's exact
 * request shapes aren't documented, so mail fields are found by key name
 * across urlencoded / JSON / multipart text fields and the URL query; the
 * raw body is always kept so the parsing can be tightened against real
 * captures.
 */

export interface ExtractedFile {
  fileName: string | null;
  contentType: string | null;
  bytes: Uint8Array;
  /** Part ended before its closing boundary (body was over the capture cap). */
  truncated: boolean;
}

export interface MailFields {
  sender: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string | null;
}

export interface ParsedBody {
  kind: "mail_send" | "attachment" | "other";
  mail: MailFields;
  files: ExtractedFile[];
  /** Field names seen in the body, for tuning the extractor against real traffic. */
  fieldNames: string[];
  parseError: string | null;
}

const enc = new TextEncoder();
const EMAIL_RE = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

export function decompress(bytes: Uint8Array, encoding: string | null): Uint8Array {
  switch ((encoding ?? "").trim().toLowerCase()) {
    case "br":
      return new Uint8Array(brotliDecompressSync(bytes));
    case "gzip":
      return new Uint8Array(gunzipSync(bytes));
    case "deflate":
      return new Uint8Array(inflateSync(bytes));
    default:
      return bytes;
  }
}

function indexOfBytes(hay: Uint8Array, needle: Uint8Array, from = 0): number {
  const first = needle[0];
  outer: for (let i = from; i <= hay.length - needle.length; i++) {
    if (hay[i] !== first) continue;
    for (let j = 1; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/** RFC 6266/5987: prefer filename*=UTF-8''<pct-encoded> over filename="...". */
function dispositionParam(disposition: string, name: "filename" | "name"): string | null {
  if (name === "filename") {
    const ext = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(disposition);
    if (ext?.[2]) {
      try {
        return decodeURIComponent(ext[2].trim());
      } catch {
        /* fall through */
      }
    }
  }
  const re = new RegExp(`(?:^|;)\\s*${name}\\s*=\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|([^;]+))`, "i");
  const m = re.exec(disposition);
  const v = m?.[1] ?? m?.[2];
  return v !== undefined ? v.replace(/\\(.)/g, "$1").trim() : null;
}

interface MultipartResult {
  files: ExtractedFile[];
  fields: [string, string][];
}

/**
 * Byte-level multipart/form-data parser -- not Response.formData(), which
 * throws on a missing closing boundary; captures over the size cap are cut
 * mid-part and should still yield their filenames.
 */
export function parseMultipart(body: Uint8Array, contentType: string): MultipartResult {
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  const boundary = m ? (m[1] ?? m[2]) : null;
  const out: MultipartResult = { files: [], fields: [] };
  if (!boundary) return out;

  const delim = enc.encode(`--${boundary}`);
  const crlfcrlf = enc.encode("\r\n\r\n");
  const dec = new TextDecoder("utf-8");

  let pos = indexOfBytes(body, delim);
  while (pos !== -1) {
    let start = pos + delim.length;
    if (body[start] === 0x2d && body[start + 1] === 0x2d) break; // closing "--"
    if (body[start] === 0x0d && body[start + 1] === 0x0a) start += 2;

    const next = indexOfBytes(body, delim, start);
    const truncated = next === -1;
    let end = truncated ? body.length : next;
    if (!truncated && body[end - 2] === 0x0d && body[end - 1] === 0x0a) end -= 2;

    const headerEnd = indexOfBytes(body.subarray(start, end), crlfcrlf);
    if (headerEnd !== -1) {
      const headers = new Map<string, string>();
      for (const line of dec.decode(body.subarray(start, start + headerEnd)).split("\r\n")) {
        const i = line.indexOf(":");
        if (i > 0) headers.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
      }
      const disposition = headers.get("content-disposition") ?? "";
      const content = body.subarray(start + headerEnd + crlfcrlf.length, end);
      const fileName = dispositionParam(disposition, "filename");
      if (fileName !== null) {
        out.files.push({ fileName: fileName || null, contentType: headers.get("content-type") ?? null, bytes: content.slice(), truncated });
      } else {
        const name = dispositionParam(disposition, "name");
        if (name) out.fields.push([name, dec.decode(content)]);
      }
    }
    if (truncated) break;
    pos = next;
  }
  return out;
}

/** Flattens JSON into [dotted.key, string] pairs (arrays keep their parent key). */
function flattenJson(v: unknown, prefix: string, out: [string, string][], depth = 0): void {
  if (depth > 6 || out.length > 2000) return;
  if (v === null || v === undefined) return;
  if (Array.isArray(v)) {
    for (const item of v) flattenJson(item, prefix, out, depth + 1);
  } else if (typeof v === "object") {
    for (const [k, child] of Object.entries(v as Record<string, unknown>)) flattenJson(child, prefix ? `${prefix}.${k}` : k, out, depth + 1);
  } else {
    out.push([prefix, String(v)]);
  }
}

// Matched against the last segment of a (possibly dotted) field name.
const TO_KEYS = /^(to|tolist|toaddr|toaddress|toaddresses|receiver|receivers|recipient|recipients|rcpt|rcptto|mailto|senderto)$/i;
const CC_KEYS = /^(cc|cclist|ccaddr|ccaddress|ccaddresses)$/i;
const BCC_KEYS = /^(bcc|bcclist|bccaddr|bccaddress|bccaddresses)$/i;
const FROM_KEYS = /^(from|fromaddr|fromaddress|sender|senderaddr|senderaddress|senderemail|mailfrom)$/i;
const SUBJECT_KEYS = /^(subject|title|mailsubject)$/i;

type Role = "to" | "cc" | "bcc" | "from" | "subject";

/** Classifies a (possibly dotted) field name by its innermost segment that
 * names a role, so "mailData.toList.email" (an array of {email} objects)
 * still counts as a recipient. */
function roleOf(key: string): Role | null {
  const segs = key.split(/[.[\]]/).filter(Boolean).map((s) => s.replace(/[_-]/g, ""));
  for (let i = segs.length - 1; i >= 0; i--) {
    const s = segs[i]!;
    if (TO_KEYS.test(s)) return "to";
    if (CC_KEYS.test(s)) return "cc";
    if (BCC_KEYS.test(s)) return "bcc";
    if (FROM_KEYS.test(s)) return "from";
    if (SUBJECT_KEYS.test(s)) return i === segs.length - 1 ? "subject" : null;
  }
  return null;
}

function emailsIn(value: string): string[] {
  return [...value.matchAll(EMAIL_RE)].map((m) => m[0].toLowerCase());
}

function uniq(xs: string[]): string[] {
  return [...new Set(xs)];
}

export function extractMail(fields: [string, string][]): MailFields {
  const mail: MailFields = { sender: null, to: [], cc: [], bcc: [], subject: null };
  for (const [key, value] of fields) {
    const role = roleOf(key);
    if (role === "to") mail.to.push(...emailsIn(value));
    else if (role === "cc") mail.cc.push(...emailsIn(value));
    else if (role === "bcc") mail.bcc.push(...emailsIn(value));
    else if (role === "from" && !mail.sender) mail.sender = emailsIn(value)[0] ?? null;
    else if (role === "subject" && !mail.subject && value.trim()) mail.subject = value.trim().slice(0, 500);
  }
  mail.to = uniq(mail.to);
  mail.cc = uniq(mail.cc);
  mail.bcc = uniq(mail.bcc);
  return mail;
}

function isTextual(contentType: string): boolean {
  const ct = contentType.toLowerCase();
  return ct === "" || ct.startsWith("text/") || ct.includes("json") || ct.includes("xml") || ct.includes("x-www-form-urlencoded") || ct.includes("javascript");
}

export function parseBody(body: Uint8Array, contentType: string | null, url: string, contentDisposition: string | null): ParsedBody {
  const ct = (contentType ?? "").toLowerCase();
  const fields: [string, string][] = [];
  let files: ExtractedFile[] = [];
  let parseError: string | null = null;

  try {
    for (const [k, v] of new URL(url).searchParams) fields.push([k, v]);
  } catch {
    /* ignore */
  }

  try {
    if (ct.startsWith("multipart/form-data")) {
      const mp = parseMultipart(body, contentType!);
      files = mp.files;
      fields.push(...mp.fields);
      // Text parts can themselves be JSON (e.g. a "mailData" field).
      for (const [, v] of mp.fields) {
        const t = v.trim();
        if (t.startsWith("{") || t.startsWith("[")) {
          try {
            flattenJson(JSON.parse(t), "", fields);
          } catch {
            /* not JSON */
          }
        }
      }
    } else if (ct.includes("x-www-form-urlencoded")) {
      for (const [k, v] of new URLSearchParams(new TextDecoder().decode(body))) fields.push([k, v]);
    } else if (ct.includes("json")) {
      flattenJson(JSON.parse(new TextDecoder().decode(body)), "", fields);
    } else if (!isTextual(ct) && body.length > 0) {
      // Raw upload body (PUT/POST of the file bytes themselves).
      const name = contentDisposition ? dispositionParam(contentDisposition, "filename") : null;
      files = [{ fileName: name, contentType, bytes: body, truncated: false }];
    }
  } catch (err) {
    parseError = err instanceof Error ? err.message : String(err);
  }

  const mail = extractMail(fields);
  const hasRecipients = mail.to.length + mail.cc.length + mail.bcc.length > 0;
  return {
    kind: hasRecipients ? "mail_send" : files.length > 0 ? "attachment" : "other",
    mail,
    files,
    fieldNames: uniq(fields.map(([k]) => k)).slice(0, 200),
    parseError,
  };
}
