-- Bumped whenever an account is disabled or enabled. Sessions are bound to it,
-- so a session verified before a disable stays invalid after re-enabling.
ALTER TABLE accounts ADD COLUMN security_version INTEGER NOT NULL DEFAULT 0;
