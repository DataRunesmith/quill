-- A client-supplied key makes starting a send idempotent: a retry after a lost
-- response returns the existing job instead of mailing every recipient twice.
ALTER TABLE send_jobs ADD COLUMN idempotency_key TEXT;
CREATE UNIQUE INDEX idx_send_jobs_idempotency
  ON send_jobs(account_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- Daily caps count send_log rows, which reference their job. A job that sent
-- today is hidden and stripped of recipient data instead of being deleted, so
-- removing it neither keeps personal data nor resets the quota.
ALTER TABLE send_jobs ADD COLUMN deleted_at INTEGER;
