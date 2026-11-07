CREATE TABLE account_contact_lists (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL COLLATE NOCASE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(account_id, name),
  UNIQUE(id, account_id)
);

CREATE TABLE account_contacts (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  email TEXT NOT NULL COLLATE NOCASE,
  name TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(account_id, email),
  UNIQUE(id, account_id)
);

CREATE TRIGGER account_contacts_cap_insert
BEFORE INSERT ON account_contacts
WHEN NOT EXISTS (
  SELECT 1 FROM account_contacts
  WHERE account_id = NEW.account_id AND email = NEW.email COLLATE NOCASE
)
AND (
  SELECT COUNT(*) FROM account_contacts WHERE account_id = NEW.account_id
) >= 10000
BEGIN
  SELECT RAISE(ABORT, 'Kontot kan ha högst 10000 sparade mottagare');
END;

CREATE TABLE account_contact_list_members (
  account_id TEXT NOT NULL,
  list_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(account_id, list_id, contact_id),
  FOREIGN KEY(list_id, account_id) REFERENCES account_contact_lists(id, account_id) ON DELETE CASCADE,
  FOREIGN KEY(contact_id, account_id) REFERENCES account_contacts(id, account_id) ON DELETE CASCADE
);
CREATE INDEX idx_account_contact_members_contact ON account_contact_list_members(account_id, contact_id);
