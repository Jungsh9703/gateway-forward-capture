import type { Env } from "./env";

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/** /api/* exposes who-sent-what-to-whom and the raw bodies, so it refuses
 * to run without DASHBOARD_TOKEN configured. Bearer header, not a query
 * param, so the token stays out of access logs. Returns an error Response,
 * or null when authorized. */
export function authorize(request: Request, env: Env): Response | null {
  if (!env.DASHBOARD_TOKEN) return json({ error: "DASHBOARD_TOKEN is not configured" }, 503);
  const given = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(env.DASHBOARD_TOKEN);
  if (a.byteLength !== b.byteLength || !crypto.subtle.timingSafeEqual(a, b)) return json({ error: "Unauthorized" }, 401);
  return null;
}

/** RFC 6266 filename + filename* so non-ASCII (e.g. Korean) names survive. */
function attachmentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** Captured bodies/files are arbitrary user content (could be HTML/JS) --
 * always an octet-stream download, never rendered inline. */
export function fileDownload(body: ReadableStream | Uint8Array, name: string): Response {
  return new Response(body, {
    headers: {
      "content-type": "application/octet-stream",
      "content-disposition": attachmentDisposition(name),
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    },
  });
}
