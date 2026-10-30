/** D1 schema, applied by the Worker itself on first use (idempotent), so an
 * auto-provisioned database needs no separate migration step. */
const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS captures (
    id               TEXT PRIMARY KEY,
    ts               INTEGER NOT NULL,      -- epoch ms, when the Worker saw the request
    user_email       TEXT,                  -- Gateway identity (Zero Trust user)
    user_name        TEXT,
    src_ip           TEXT,
    internal_src_ip  TEXT,
    host             TEXT,
    url              TEXT,
    method           TEXT,
    status           INTEGER,               -- origin response status
    content_type     TEXT,
    content_encoding TEXT,
    body_bytes       INTEGER,               -- full request body size
    captured_bytes   INTEGER,               -- bytes kept (<= MAX_CAPTURE_BYTES)
    truncated        INTEGER NOT NULL DEFAULT 0,
    kind             TEXT NOT NULL,         -- mail_send | attachment | other
    sender           TEXT,                  -- from the body, e.g. the Naver account
    to_addrs         TEXT,                  -- JSON array
    cc_addrs         TEXT,                  -- JSON array
    bcc_addrs        TEXT,                  -- JSON array
    subject          TEXT,
    file_count       INTEGER NOT NULL DEFAULT 0,
    file_names       TEXT,                  -- JSON array
    field_names      TEXT,                  -- JSON array of body field names (for tuning the parser)
    parse_error      TEXT,
    raw_key          TEXT,                  -- R2 key of the (decompressed) request body
    policy_id        TEXT,
    user_agent       TEXT,
    referer          TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_captures_ts ON captures (ts)`,
  `CREATE INDEX IF NOT EXISTS idx_captures_user ON captures (user_email)`,
  `CREATE INDEX IF NOT EXISTS idx_captures_kind ON captures (kind)`,
  `CREATE TABLE IF NOT EXISTS capture_files (
    capture_id   TEXT NOT NULL,
    idx          INTEGER NOT NULL,
    file_name    TEXT,
    content_type TEXT,
    size         INTEGER NOT NULL,
    sha256       TEXT NOT NULL,
    truncated    INTEGER NOT NULL DEFAULT 0,
    r2_key       TEXT NOT NULL,
    PRIMARY KEY (capture_id, idx)
  )`,
  // Host -> Gateway application (see apps.ts). Joined at read time, so a
  // fixed mapping also relabels past captures. Add your own with
  // INSERT OR REPLACE ... source = 'manual' (never overwritten by lookups).
  `CREATE TABLE IF NOT EXISTS host_apps (
    host             TEXT PRIMARY KEY,      -- lowercased request host
    app_name         TEXT,                  -- NULL = looked up, no application known
    app_id           INTEGER,
    matched_hostname TEXT,                  -- which of host / parent domain matched
    matched_via      TEXT,                  -- hostname | support_domain
    source           TEXT NOT NULL,         -- api | manual
    fetched_at       INTEGER NOT NULL
  )`,
];

/** Columns added after the first release. CREATE TABLE IF NOT EXISTS won't
 * add them to an existing table, so each is ALTERed in on its own and a
 * "duplicate column" error just means it's already there. */
const ADDED_COLUMNS = [
  `ALTER TABLE captures ADD COLUMN attach_count INTEGER`, // attachments the request refers to (e.g. Naver aCount)
  `ALTER TABLE captures ADD COLUMN attach_size INTEGER`, // their total bytes as stated by the request (e.g. aSize)
  `ALTER TABLE captures ADD COLUMN attach_names TEXT`, // JSON array of names found in the body
];

let schemaReady = false;

export async function ensureSchema(db: D1Database): Promise<void> {
  if (schemaReady) return;
  await db.batch(STATEMENTS.map((s) => db.prepare(s)));
  for (const sql of ADDED_COLUMNS) {
    try {
      await db.prepare(sql).run();
    } catch (err) {
      if (!/duplicate column/i.test(String(err))) throw err;
    }
  }
  schemaReady = true;
}
