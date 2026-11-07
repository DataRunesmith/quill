CREATE TABLE letter_intro_presets (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 80),
  body_text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_letter_intro_presets_account
  ON letter_intro_presets(account_id, created_at);

ALTER TABLE send_jobs ADD COLUMN intro_text TEXT;
