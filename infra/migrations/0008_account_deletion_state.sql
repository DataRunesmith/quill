-- Set when an account deletion starts. The account is disabled and its jobs are
-- stopped immediately; the scheduled worker resumes cleanup until the account
-- row is gone, so a failed R2 or D1 step never leaves a live account behind.
ALTER TABLE accounts ADD COLUMN deletion_requested_at INTEGER;
