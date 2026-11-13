-- Quota held for a recipient from the moment a consumer decides to send until
-- the result is logged. Rows are inserted atomically against the daily caps, so
-- concurrent consumers (and aborted jobs with sends still in flight) cannot
-- spend the same remaining capacity. Expired rows are ignored and cleaned up.
CREATE TABLE send_reservations (
  send_job_id TEXT NOT NULL,
  recipient_email TEXT NOT NULL,
  account_id TEXT NOT NULL,
  mail_credential_id TEXT NOT NULL,
  reserved_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (send_job_id, recipient_email)
);
CREATE INDEX idx_send_reservations_account ON send_reservations (account_id, expires_at);
CREATE INDEX idx_send_reservations_credential ON send_reservations (mail_credential_id, expires_at);
