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
  /** "true" only in local dev: enables POST /__test/forward (see index.ts). */
  ENABLE_TEST_FORWARD?: string;
}
