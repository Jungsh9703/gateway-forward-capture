import type { GatewayMiddlewareContext } from "@cloudflare/zt-types";
import type { Env } from "./env";
import { handleApi } from "./api";
import dashboardHtml from "./dashboard.html";
import { GatewayMiddleware } from "./middleware";

// Gateway's Forward action invokes this named entrypoint over RPC.
export { GatewayMiddleware };

/** The page holds no data -- it asks for DASHBOARD_TOKEN and calls /api/*
 * with it. The CSP keeps it from talking to anything but this Worker. */
const DASHBOARD_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy":
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

/**
 * Local-dev only (ENABLE_TEST_FORWARD="true"): runs GatewayMiddleware.handle()
 * with a fake Gateway context, and a fake next() that plays the origin and
 * reports the bytes it received -- so pass-through integrity and capture
 * can be checked without a real Forward policy.
 */
async function testForward(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const target = url.searchParams.get("target") ?? "https://mail.naver.com/json/write/send";
  const t = new URL(target);
  const context = {
    srcIp: "203.0.113.50",
    srcPort: 50000,
    networkProtocol: "tcp",
    host: t.host,
    uri: t.toString(),
    accountId: "test-account",
    policyId: "00000000-0000-0000-0000-000000000000",
    identity: async () => ({ email: url.searchParams.get("user") ?? "tester@example.com", name: "Tester" }),
    devicePosture: async () => ({ checks: { passed: [] } }),
  } satisfies GatewayMiddlewareContext;

  const original = new Request(target, { method: request.method, headers: request.headers, body: request.body });
  // ?respond=<json> makes the fake origin answer with that body (e.g. an
  // upload response naming the file); what it received is always echoed in
  // x-origin-received-* headers too.
  const respond = url.searchParams.get("respond");
  const next = async (upstream: Request): Promise<Response> => {
    const bytes = new Uint8Array(await upstream.arrayBuffer());
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const received = { "x-origin-received-bytes": String(bytes.length), "x-origin-received-sha256": digest };
    const respondCt = url.searchParams.get("respond_ct") ?? "application/json;charset=UTF-8";
    if (respond !== null) return new Response(respond, { headers: { "content-type": respondCt, ...received } });
    return Response.json({ originReceivedBytes: bytes.length, originReceivedSha256: digest, method: upstream.method }, { headers: received });
  };

  const mw = new GatewayMiddleware(ctx, env);
  return mw.handle(original, context, next);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/dashboard")) {
      return new Response(dashboardHtml, { headers: DASHBOARD_HEADERS });
    }

    if (url.pathname === "/__test/forward" && env.ENABLE_TEST_FORWARD === "true") {
      return testForward(request, env, ctx);
    }
    // Fake Resource Library for local tests (point CF_API_BASE at /__test/cfapi).
    if (url.pathname.startsWith("/__test/cfapi/") && env.ENABLE_TEST_FORWARD === "true") {
      const host = (url.searchParams.get("filter") ?? "").replace(/^hostname:/, "");
      const lib = [
        { id: 101, name: "Naver Mail", hostnames: ["mail.naver.com"], support_domains: ["naver.com"], supported: ["GATEWAY"] },
        { id: 102, name: "Gmail", hostnames: ["mail.google.com"], support_domains: [], supported: ["GATEWAY"] },
      ];
      const result = lib.filter((a) => [...a.hostnames, ...a.support_domains].includes(host));
      return Response.json({ success: true, result });
    }

    const api = await handleApi(request, env);
    if (api) return api;

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
