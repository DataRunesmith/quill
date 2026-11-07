-- Native D1 baseline for a new Quill database.
-- Existing production databases are baselined by infra/migrate-d1-native.sh
-- only after the legacy migration chain has been applied and verified.

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_set_by_user INTEGER NOT NULL DEFAULT 0,
  email_verified INTEGER NOT NULL DEFAULT 0,
  verification_code TEXT,
  verification_expires_at INTEGER,
  daily_send_cap INTEGER NOT NULL DEFAULT 200,
  is_admin INTEGER NOT NULL DEFAULT 0,
  reset_token TEXT,
  reset_expires_at INTEGER,
  totp_secret TEXT,
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TRIGGER disable_totp_after_password_reset
AFTER UPDATE OF reset_token ON accounts
WHEN OLD.reset_token IS NOT NULL AND NEW.reset_token IS NULL
BEGIN
  UPDATE accounts SET totp_enabled = 0, totp_secret = NULL WHERE id = NEW.id;
END;

CREATE TRIGGER accounts_email_nocase_insert
BEFORE INSERT ON accounts
WHEN EXISTS (
  SELECT 1 FROM accounts
  WHERE LOWER(TRIM(email)) = LOWER(TRIM(NEW.email))
)
BEGIN
  SELECT RAISE(ABORT, 'E-postadressen är redan registrerad');
END;

CREATE TRIGGER accounts_email_nocase_update
BEFORE UPDATE OF email ON accounts
WHEN EXISTS (
  SELECT 1 FROM accounts
  WHERE id <> OLD.id
    AND LOWER(TRIM(email)) = LOWER(TRIM(NEW.email))
)
BEGIN
  SELECT RAISE(ABORT, 'E-postadressen är redan registrerad');
END;

CREATE TABLE oauth_identities (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  provider TEXT NOT NULL,
  provider_user_id TEXT NOT NULL,
  provider_email TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(provider, provider_user_id),
  UNIQUE(account_id, provider)
);

CREATE TABLE mail_credentials (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  provider TEXT NOT NULL,
  smtp_host TEXT NOT NULL,
  smtp_port INTEGER NOT NULL,
  smtp_user TEXT NOT NULL,
  encrypted_password TEXT NOT NULL,
  from_address TEXT NOT NULL,
  verified_at INTEGER,
  daily_cap INTEGER,
  user_cap_pct INTEGER NOT NULL DEFAULT 100,
  oauth_access_token TEXT,
  oauth_refresh_token TEXT,
  oauth_token_expires_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_mail_credentials_account_active ON mail_credentials(account_id, revoked_at, created_at);

CREATE TABLE politicians (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  area_name TEXT NOT NULL,
  area_type TEXT NOT NULL,
  party TEXT,
  role TEXT,
  last_scraped_at INTEGER NOT NULL,
  verification_status TEXT NOT NULL DEFAULT 'unknown',
  last_verified_at INTEGER,
  UNIQUE(email, area_name)
);
CREATE INDEX idx_politicians_area ON politicians(area_type, area_name);
CREATE INDEX idx_politicians_area_role ON politicians(area_name, role);
CREATE INDEX idx_politicians_role ON politicians(role);
CREATE INDEX idx_politicians_email_normalized ON politicians(lower(trim(email)));

CREATE TABLE politician_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  politician_id TEXT NOT NULL REFERENCES politicians(id) ON DELETE CASCADE,
  area_name TEXT NOT NULL,
  body TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT '',
  source TEXT,
  last_scraped_at INTEGER NOT NULL,
  UNIQUE(politician_id, body, role)
);
CREATE INDEX idx_politician_assignments_politician ON politician_assignments(politician_id);
CREATE INDEX idx_politician_assignments_area_body ON politician_assignments(area_name, body);

CREATE TABLE letters (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  html_body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE letter_attachments (
  id TEXT PRIMARY KEY,
  letter_id TEXT NOT NULL REFERENCES letters(id),
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  mode TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE send_jobs (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  letter_id TEXT NOT NULL REFERENCES letters(id),
  mail_credential_id TEXT NOT NULL REFERENCES mail_credentials(id),
  total_recipients INTEGER NOT NULL,
  sent_count INTEGER NOT NULL DEFAULT 0,
  bounce_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  daily_limit INTEGER,
  next_daily_limit INTEGER,
  limit_switch_at INTEGER,
  content_retention_ms INTEGER NOT NULL DEFAULT 300000,
  content_delete_at INTEGER,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX idx_send_jobs_status_created ON send_jobs(status, created_at);
CREATE INDEX idx_send_jobs_account_created ON send_jobs(account_id, created_at DESC);
CREATE INDEX idx_send_jobs_mail_credential ON send_jobs(mail_credential_id);

CREATE TRIGGER trg_send_jobs_content_retention
AFTER UPDATE OF status, finished_at ON send_jobs
WHEN NEW.finished_at IS NOT NULL
 AND NEW.status IN ('done','aborted','cancelled')
BEGIN
  UPDATE send_jobs
  SET content_delete_at = NEW.finished_at +
      CASE NEW.content_retention_ms
        WHEN 300000 THEN 300000
        WHEN 86400000 THEN 86400000
        WHEN 259200000 THEN 259200000
        WHEN 604800000 THEN 604800000
        ELSE 300000
      END
  WHERE id = NEW.id;
END;

CREATE TRIGGER trg_send_jobs_clear_content_retention
AFTER UPDATE OF status ON send_jobs
WHEN NEW.status IN ('pending','sending') AND OLD.status != NEW.status
BEGIN
  UPDATE send_jobs SET content_delete_at = NULL WHERE id = NEW.id;
END;

CREATE TABLE send_job_recipients (
  send_job_id TEXT NOT NULL REFERENCES send_jobs(id) ON DELETE CASCADE,
  recipient_email TEXT NOT NULL COLLATE NOCASE,
  recipient_name TEXT NOT NULL,
  subject TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  queued_at INTEGER,
  finished_at INTEGER,
  error TEXT,
  PRIMARY KEY (send_job_id, recipient_email)
);
CREATE INDEX idx_send_job_recipients_pending ON send_job_recipients(send_job_id, status);
CREATE INDEX idx_send_job_recipients_queued ON send_job_recipients(status, queued_at);

CREATE TABLE send_log (
  id TEXT PRIMARY KEY,
  send_job_id TEXT NOT NULL REFERENCES send_jobs(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  recipient_email TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  sent_at INTEGER NOT NULL
);
CREATE INDEX idx_send_log_account_date ON send_log(account_id, sent_at);
CREATE INDEX idx_send_log_job_date_status ON send_log(send_job_id, sent_at, status);

CREATE TABLE feedback (
  id TEXT PRIMARY KEY,
  account_id TEXT,
  message TEXT NOT NULL,
  github_issue_url TEXT,
  reply_to TEXT,
  wants_reply INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL DEFAULT 'feedback',
  created_at INTEGER NOT NULL
);

CREATE TABLE worker_errors (
  id TEXT PRIMARY KEY,
  account_id TEXT,
  method TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  status INTEGER NOT NULL,
  error_message TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_worker_errors_account ON worker_errors(account_id, created_at);

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  key_hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);

CREATE TABLE visits (
  id TEXT PRIMARY KEY,
  visitor_hash TEXT NOT NULL,
  visited_at INTEGER NOT NULL,
  country TEXT
);
CREATE INDEX idx_visits_visited_at ON visits(visited_at);
CREATE INDEX idx_visits_hash ON visits(visitor_hash);

CREATE TABLE client_errors (
  signature TEXT PRIMARY KEY,
  message TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  email_notified_at INTEGER,
  github_issue_url TEXT
);
CREATE INDEX idx_client_errors_first_seen ON client_errors(first_seen);
CREATE INDEX idx_client_errors_email_notified_at ON client_errors(email_notified_at);
