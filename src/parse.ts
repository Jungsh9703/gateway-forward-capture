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
  /** Display name of the sending account, when the service reports one. */
  senderName: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string | null;
}

/** Attachments a request refers to without carrying their bytes (a mail
 * send pointing at files uploaded earlier). */
export interface AttachmentInfo {
  count: number | null;
  /** Total bytes, as the request states it. */
  size: number | null;
  names: string[];
}

export interface ParsedBody {
  kind: "mail_send" | "attachment" | "other";
  mail: MailFields;
  attachments: AttachmentInfo;
  /** Attachment IDs in the request (URL or body), for linking uploads to sends. */
  attachIds: string[];
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
  const mail: MailFields = { sender: null, senderName: null, to: [], cc: [], bcc: [], subject: null };
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
  const ct = contentType.toLowerCase().split(";")[0]!.trim();
  // XML only as its own type or a "+xml" suffix -- not any type mentioning
  // xml: application/vnd.openxmlformats-officedocument.* (docx/xlsx/pptx)
  // are binary files.
  const xml = ct === "application/xml" || ct.endsWith("+xml");
  return ct === "" || ct.startsWith("text/") || ct.includes("json") || xml || ct.includes("x-www-form-urlencoded") || ct.includes("javascript");
}

// Attachment info carried by a mail send that references files uploaded
// earlier (Naver Mail: /json/write/send?aCount=1&aId=...&aSize=1172995).
const ATTACH_COUNT_KEYS = /^(acount|attachcount|attachmentcount|attachcnt|filecount)$/i;
const ATTACH_TOTAL_SIZE_KEYS = /^(asize|totalattachsize|totalattachmentsize|totalsize|totalfilesize)$/i;
const ATTACH_FILE_SIZE_KEYS = /^(filesize|attachsize|attachmentsize|size)$/i;

/** A size/name field only counts when its path is about files/attachments
 * ("attachList.size", "files.fileName") -- or the key itself says so. */
const ATTACH_PATH = /attach|file/i;

function attachmentInfo(fields: [string, string][]): AttachmentInfo {
  let count: number | null = null;
  let total: number | null = null;
  // Per-file sizes, summed per exact key (an array of files repeats one key)
  // but not across spellings of the same key: Naver's bigfile precheck sends
  // both filesize= and fileSize= with the same value.
  const perKey = new Map<string, number>();
  const names: string[] = [];
  for (const [key, value] of fields) {
    const segs = key.split(/[.[\]]/).filter(Boolean).map((s) => s.replace(/[_-]/g, ""));
    const last = segs[segs.length - 1] ?? "";
    const n = Number(value);
    if (ATTACH_COUNT_KEYS.test(last) && Number.isFinite(n)) count = Math.max(count ?? 0, n);
    else if (ATTACH_TOTAL_SIZE_KEYS.test(last) && Number.isFinite(n)) total = Math.max(total ?? 0, n);
    else if (ATTACH_FILE_SIZE_KEYS.test(last) && Number.isFinite(n) && (last.toLowerCase() !== "size" || segs.some((s) => ATTACH_PATH.test(s)))) {
      perKey.set(key, (perKey.get(key) ?? 0) + n);
    } else if (/name$/i.test(last) && segs.some((s) => ATTACH_PATH.test(s)) && value.trim() && !EMAIL_RE.test(value)) {
      names.push(value.trim().slice(0, 300));
    }
    EMAIL_RE.lastIndex = 0;
  }
  const uniqNames = uniq(names);
  return {
    count: count ?? (uniqNames.length || null),
    // Different keys describing the same files (fileSize / filesize / size) -> the largest, never their sum.
    size: total ?? (perKey.size ? Math.max(...perKey.values()) : null),
    names: uniqNames,
  };
}

// IDs that tie an upload to the mail send that later references it
// (Naver Mail: attachID=... when the attachment slot is created / the file
// is uploaded, aId=... on /json/write/send).
const ATTACH_ID_KEYS = /^(aid|attachid|attachmentid|attachkey|attachmentkey)$/i;

export function attachIdsOf(fields: [string, string][]): string[] {
  const lasts = fields.map(([key]) => (key.split(/[.[\]]/).filter(Boolean).pop() ?? key).replace(/[_-]/g, "").toLowerCase());
  // Naver large-file ("bigfile") attachments are tied together by the bigfile
  // session instead: precheck (fileName + fileSize + sessionid) and the send
  // (bigfile... + sessionID). A session ID only counts in those two shapes --
  // elsewhere a session is shared by everything a user does.
  const bigfileShaped = lasts.some((k) => k.startsWith("bigfile")) || (lasts.includes("filename") && lasts.includes("filesize"));
  const ids: string[] = [];
  for (const [i, [, value]] of fields.entries()) {
    const last = lasts[i]!;
    const v = value.trim();
    if (v.length < 4 || v.length > 512) continue;
    if (ATTACH_ID_KEYS.test(last) || (bigfileShaped && last === "sessionid")) ids.push(v);
  }
  return uniq(ids);
}

/** Fields of a small JSON / urlencoded / text response, flattened like a
 * request body's. */
export function responseFields(body: Uint8Array): [string, string][] {
  const text = new TextDecoder("utf-8").decode(body).trim();
  const fields: [string, string][] = [];
  if (!text) return fields;
  try {
    if (text.startsWith("{") || text.startsWith("[")) flattenJson(JSON.parse(text), "", fields);
    else if (/^[^=&\s]+=[^&]*(&[^=&\s]+=[^&]*)*$/.test(text)) for (const [k, v] of new URLSearchParams(text)) fields.push([k, v]);
  } catch {
    /* not plain JSON -- tried below */
  }
  if (fields.length === 0) {
    // JSONP (cb({...});) or JSON inside an HTML/script wrapper, as iframe/legacy
    // upload endpoints answer: parse the outermost {...} found in the text.
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        flattenJson(JSON.parse(text.slice(start, end + 1)), "", fields);
      } catch {
        /* not structured */
      }
    }
  }
  return fields;
}

/**
 * Sending account from a mail-send response -- Naver Mail's send answer
 * carries UserName / UserId (the Naver ID, whose address is <id>@naver.com)
 * rather than the request saying who sends.
 */
/** Path segments of a response section listing recipients. */
const RECIPIENT_SECTION = /^(to|tolist|toaddr|cc|cclist|bcc|bcclist|recipient|recipients|receiver|receivers|receiverlist|rcpt|rcptto|rcptlist)$/;

export function responseSender(fields: [string, string][], host: string | null): { email: string | null; name: string | null } {
  let explicit: string | null = null; // keys that can only mean the sender
  let generic: string | null = null; // a top-level "email" -- often the account, never certain
  let id: string | null = null;
  let name: string | null = null;
  for (const [key, value] of fields) {
    const segs = key.split(/[.[\]]/).filter(Boolean).map((s) => s.replace(/[_-]/g, "").toLowerCase());
    // A send answer may echo the recipients (toList[].email, receivers...):
    // nothing inside such a section describes the sender.
    if (segs.some((s) => RECIPIENT_SECTION.test(s))) continue;
    const last = segs[segs.length - 1] ?? "";
    const v = value.trim();
    if (!v) continue;
    if (!explicit && ["senderemail", "senderaddress", "fromaddress", "fromemail", "useremail", "myemail", "accountemail"].includes(last)) explicit = emailsIn(v)[0] ?? null;
    else if (!generic && segs.length === 1 && ["email", "mailaddress"].includes(last)) generic = emailsIn(v)[0] ?? null;
    else if (!id && ["userid", "loginid", "naverid", "accountid"].includes(last) && /^[A-Za-z0-9._@-]{2,64}$/.test(v)) id = v.toLowerCase();
    else if (!name && ["username", "sendername", "displayname", "fromname"].includes(last)) name = v.slice(0, 100);
  }
  let fromId: string | null = null;
  if (id) {
    if (id.includes("@")) fromId = id;
    else if ((host ?? "").toLowerCase().endsWith("naver.com")) fromId = `${id}@naver.com`;
  }
  // Explicit sender keys, then the account ID (Naver's UserId -- what the
  // send answer is known to carry), and only then a bare top-level email.
  return { email: explicit ?? fromId ?? generic, name };
}

/** Browsers name JS-built multipart parts "blob"; Gateway logs use
 * "<unknown file name>" -- neither is a real filename. */
export function isRealFileName(n: string | null | undefined): n is string {
  return !!n && n.trim() !== "" && !/^<.*>$/.test(n) && n.toLowerCase() !== "blob";
}

export interface UploadAnswer {
  name: string | null;
  size: number | null;
}

/** An upload endpoint's answer naming the stored file, e.g. Naver Mail's
 * {"realIndex":1,"size":5242880,"Message":"","name":"x.txt","Result":"OK"}:
 * a top-level-ish name/fileName plus (optionally) its size. */
export function uploadAnswer(fields: [string, string][]): UploadAnswer {
  let name: string | null = null;
  let size: number | null = null;
  for (const [key, value] of fields) {
    const last = (key.split(/[.[\]]/).filter(Boolean).pop() ?? key).replace(/[_-]/g, "").toLowerCase();
    if (!name && ["name", "filename", "orgname", "orgfilename", "originalname", "originalfilename", "attachname", "realname"].includes(last) && isRealFileName(value.trim())) {
      name = value.trim().slice(0, 300);
    } else if (size === null && ["size", "filesize", "totalsize"].includes(last) && Number.isFinite(Number(value))) {
      size = Number(value);
    }
  }
  // Fallback for unfamiliar answers: any *name field whose value looks like a
  // file name (has an extension).
  if (!name) {
    for (const [key, value] of fields) {
      const last = (key.split(/[.[\]]/).filter(Boolean).pop() ?? key).toLowerCase();
      const v = value.trim();
      if (last.endsWith("name") && isRealFileName(v) && /\.[A-Za-z0-9]{1,8}$/.test(v) && !EMAIL_RE.test(v)) {
        name = v.slice(0, 300);
        break;
      }
      EMAIL_RE.lastIndex = 0;
    }
    EMAIL_RE.lastIndex = 0;
  }
  return { name, size };
}

/**
 * Folds an upload answer into a parsed request: a raw request body (Naver
 * sends the file itself as e.g. text/plain) becomes the named file; an
 * unnamed file (multipart "blob", raw octet-stream) gets the answer's name.
 * The answer's size isn't required to match the body: large files can go up
 * in chunks, each answered with the whole file's name and size. Structured
 * bodies (forms/JSON) are never turned into files.
 */
export function applyUploadAnswer(parsed: ParsedBody, body: Uint8Array, contentType: string | null, _bodyBytes: number, truncated: boolean, answer: UploadAnswer): void {
  if (!answer.name) return;
  const ct = (contentType ?? "").toLowerCase();
  if (parsed.files.length === 1 && !isRealFileName(parsed.files[0]!.fileName)) {
    parsed.files[0]!.fileName = answer.name;
  } else if (
    parsed.files.length === 0 &&
    body.length > 0 &&
    !ct.startsWith("multipart/") &&
    !ct.includes("x-www-form-urlencoded") &&
    !ct.includes("json")
  ) {
    parsed.files = [{ fileName: answer.name, contentType, bytes: body, truncated }];
  } else {
    return;
  }
  if (parsed.kind === "other") parsed.kind = "attachment";
}

/** Field values that are themselves JSON (common in form posts: e.g.
 * attachList=[{...}]) are flattened too, under the field's own name. */
function expandJsonValues(fields: [string, string][]): void {
  const n = fields.length;
  for (let i = 0; i < n; i++) {
    const [k, v] = fields[i]!;
    const t = v.trim();
    if (!(t.startsWith("{") || t.startsWith("["))) continue;
    try {
      flattenJson(JSON.parse(t), k, fields);
    } catch {
      /* not JSON */
    }
  }
}

/** `headerFileName`: a name sent in a request header such as X-File-Name
 * (some raw-upload endpoints do this instead of Content-Disposition). */
export function parseBody(body: Uint8Array, contentType: string | null, url: string, contentDisposition: string | null, headerFileName?: string | null): ParsedBody {
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
    } else if (ct.includes("x-www-form-urlencoded")) {
      for (const [k, v] of new URLSearchParams(new TextDecoder().decode(body))) fields.push([k, v]);
    } else if (ct.includes("json")) {
      flattenJson(JSON.parse(new TextDecoder().decode(body)), "", fields);
    } else if ((!isTextual(ct) || isRealFileName(headerFileName)) && body.length > 0) {
      // Raw upload body (PUT/POST of the file bytes themselves).
      const name = (contentDisposition ? dispositionParam(contentDisposition, "filename") : null) ?? headerFileName ?? null;
      files = [{ fileName: name, contentType, bytes: body, truncated: false }];
    }
  } catch (err) {
    parseError = err instanceof Error ? err.message : String(err);
  }
  expandJsonValues(fields);

  const mail = extractMail(fields);
  const hasRecipients = mail.to.length + mail.cc.length + mail.bcc.length > 0;
  return {
    kind: hasRecipients ? "mail_send" : files.length > 0 ? "attachment" : "other",
    mail,
    attachments: attachmentInfo(fields),
    attachIds: attachIdsOf(fields),
    files,
    fieldNames: uniq(fields.map(([k]) => k)).slice(0, 200),
    parseError,
  };
}
