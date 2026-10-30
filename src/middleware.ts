import { WorkerEntrypoint } from "cloudflare:workers";
import type { GatewayIdentity, GatewayMiddlewareContext, GatewayMiddlewareNext } from "@cloudflare/zt-types";
import type { Env } from "./env";
import { DEFAULT_MAX_CAPTURE_BYTES, EMPTY, MAX_RESPONSE_BYTES, readBounded, storeCapture, type Bounded, type CaptureMeta } from "./capture";

/** Identity normally resolves well before the upstream answers; this only
 * bounds the wait if the lookup hangs, so it never holds the response. */
const IDENTITY_WAIT_MS = 1500;

/** Request headers worth keeping. Never cookies or authorization. */
function snapshot(request: Request, context: GatewayMiddlewareContext): CaptureMeta {
  const h = request.headers;
  return {
    id: crypto.randomUUID(),
    ts: Date.now(),
    method: request.method,
    url: context.uri || request.url,
    host: context.host,
    srcIp: context.srcIp,
    internalSrcIp: context.internalSrcIp ?? null,
    policyId: context.policyId,
    contentType: h.get("content-type"),
    contentEncoding: h.get("content-encoding"),
    contentDisposition: h.get("content-disposition"),
    contentLength: h.get("content-length"),
    userAgent: h.get("user-agent"),
    referer: h.get("referer"),
  };
}

/**
 * Gateway Forward entrypoint (HTTP policy action "Forward"). Gateway calls
 * handle() over RPC for every matching request and FAILS CLOSED if it
 * throws -- the user's request would be blocked. So: the original request
 * always goes upstream via next(), unchanged; capture runs on a teed copy
 * of the body in waitUntil(), and any capture-side error is only logged.
 */
export class GatewayMiddleware extends WorkerEntrypoint<Env> {
  async handle(request: Request, context: GatewayMiddlewareContext, next: GatewayMiddlewareNext): Promise<Response> {
    let upstream = request;
    let requestRead: Promise<Bounded> | null = null;
    let meta: CaptureMeta | null = null;
    let identityP: Promise<GatewayIdentity | null> = Promise.resolve(null);

    try {
      meta = snapshot(request, context);
      identityP = context.identity().catch(() => null);
      if (request.body) {
        const [toOrigin, toCapture] = request.body.tee();
        upstream = new Request(request, { body: toOrigin });
        // Read the copy *while* the upload streams, and stop at the cap: an
        // unread tee branch buffers everything the other branch has passed,
        // so waiting until next() resolves would hold a whole large upload
        // in memory (and an out-of-memory Worker fails closed).
        requestRead = readBounded(toCapture, Number(this.env.MAX_CAPTURE_BYTES ?? DEFAULT_MAX_CAPTURE_BYTES)).catch(() => EMPTY);
      }
    } catch (err) {
      console.error("capture setup failed; passing through", err);
    }

    const response = await next(upstream);
    if (!meta) return response;

    // Small JSON/text responses carry what the request doesn't -- e.g.
    // Naver Mail's upload answers {"name":"<file name>","size":...}. Same
    // tee + bounded read; the user's response streams on untouched.
    let out = response;
    let responseRead: Promise<Bounded> | null = null;
    try {
      const ct = (response.headers.get("content-type") ?? "").toLowerCase();
      const declared = Number(response.headers.get("content-length") ?? "");
      if (response.body && (ct.includes("json") || ct.startsWith("text/")) && !(declared > MAX_RESPONSE_BYTES)) {
        const [toUser, toCapture] = response.body.tee();
        out = new Response(toUser, response);
        responseRead = readBounded(toCapture, MAX_RESPONSE_BYTES).catch(() => EMPTY);
      }
    } catch (err) {
      console.error("response capture setup failed; passing through", err);
      out = response;
    }

    const identity = await Promise.race([identityP, new Promise<null>((r) => setTimeout(() => r(null), IDENTITY_WAIT_MS))]);
    const respMeta = {
      status: response.status,
      contentType: response.headers.get("content-type"),
      contentEncoding: response.headers.get("content-encoding"),
    };
    this.ctx.waitUntil(
      storeCapture(this.env, meta, identity, requestRead, respMeta, responseRead).catch((err) => console.error("capture failed", meta!.id, err)),
    );
    return out;
  }
}
