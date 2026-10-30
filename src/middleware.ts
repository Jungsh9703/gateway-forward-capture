import { WorkerEntrypoint } from "cloudflare:workers";
import type { GatewayIdentity, GatewayMiddlewareContext, GatewayMiddlewareNext } from "@cloudflare/zt-types";
import type { Env } from "./env";
import { storeCapture, type CaptureMeta } from "./capture";

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
    let copy: ReadableStream<Uint8Array> | null = null;
    let meta: CaptureMeta | null = null;
    let identityP: Promise<GatewayIdentity | null> = Promise.resolve(null);

    try {
      meta = snapshot(request, context);
      identityP = context.identity().catch(() => null);
      if (request.body) {
        const [toOrigin, toCapture] = request.body.tee();
        upstream = new Request(request, { body: toOrigin });
        copy = toCapture;
      }
    } catch (err) {
      console.error("capture setup failed; passing through", err);
      copy = null;
    }

    const response = await next(upstream);

    if (meta) {
      const identity = await Promise.race([identityP, new Promise<null>((r) => setTimeout(() => r(null), IDENTITY_WAIT_MS))]);
      this.ctx.waitUntil(
        storeCapture(this.env, meta, identity, copy, response.status).catch((err) => console.error("capture failed", meta!.id, err)),
      );
    } else if (copy) {
      copy.cancel().catch(() => {});
    }
    return response;
  }
}
