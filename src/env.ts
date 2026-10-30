export interface Env {
  /** Private bucket for captured raw bodies (raw/) and extracted files (files/). */
  CAPTURES: R2Bucket;
  /** Searchable capture records (see schema.ts). */
  DB: D1Database;

  /** Bearer token for the dashboard's /api/*. Required -- /api answers 503 without it. */
  DASHBOARD_TOKEN?: string;
  /** Max request-body bytes kept per capture; the rest still reaches the origin. */
  MAX_CAPTURE_BYTES?: string;
  /** "false" skips storing requests that are neither a mail send nor an attachment. */
  CAPTURE_OTHER?: string;
  /** Account ID + API token (Account > Zero Trust > Read) for looking up a
   * host's Gateway application in the Resource Library (apps.ts). Both
   * optional -- without them the application shows as unknown. */
  CF_ACCOUNT_ID?: string;
  CF_API_TOKEN?: string;
  /** Override of https://api.cloudflare.com/client/v4 -- local tests only. */
  CF_API_BASE?: string;

  /** "true" only in local dev: enables POST /__test/forward (see index.ts). */
  ENABLE_TEST_FORWARD?: string;
}
