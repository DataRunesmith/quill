-- Generalize the shared public recipient registry before adding academic contacts.
-- Existing IDs and recipient verification state are preserved.

ALTER TABLE politicians RENAME TO public_contacts;
ALTER TABLE politician_assignments RENAME TO public_contact_assignments;
ALTER TABLE public_contact_assignments RENAME COLUMN politician_id TO contact_id;

ALTER TABLE public_contacts ADD COLUMN organisation TEXT;
ALTER TABLE public_contacts ADD COLUMN unit TEXT;
ALTER TABLE public_contacts ADD COLUMN title TEXT;
ALTER TABLE public_contacts ADD COLUMN academic_field TEXT;
ALTER TABLE public_contacts ADD COLUMN source_url TEXT;

DROP INDEX IF EXISTS idx_politicians_area;
DROP INDEX IF EXISTS idx_politicians_area_role;
DROP INDEX IF EXISTS idx_politicians_role;
DROP INDEX IF EXISTS idx_politicians_email_normalized;
DROP INDEX IF EXISTS idx_politician_assignments_politician;
DROP INDEX IF EXISTS idx_politician_assignments_area_body;

CREATE INDEX idx_public_contacts_area ON public_contacts(area_type, area_name);
CREATE INDEX idx_public_contacts_area_role ON public_contacts(area_name, role);
CREATE INDEX idx_public_contacts_role ON public_contacts(role);
CREATE INDEX idx_public_contacts_email_normalized ON public_contacts(lower(trim(email)));
CREATE INDEX idx_public_contacts_academic_field ON public_contacts(area_type, academic_field);
CREATE INDEX idx_public_contact_assignments_contact ON public_contact_assignments(contact_id);
CREATE INDEX idx_public_contact_assignments_area_body ON public_contact_assignments(area_name, body);

-- Compatibility layer: the currently deployed Worker may still read the legacy
-- table names while this migration is applied. Keep its read paths and the only
-- runtime write (delivery verification) operational until the new Worker is live.
CREATE VIEW politicians AS
SELECT
  id, name, email, area_name, area_type, party, role, last_scraped_at,
  verification_status, last_verified_at
FROM public_contacts;

CREATE VIEW politician_assignments AS
SELECT
  id, contact_id AS politician_id, area_name, body, role, source, last_scraped_at
FROM public_contact_assignments;

CREATE TRIGGER politicians_compat_verification_update
INSTEAD OF UPDATE OF verification_status, last_verified_at ON politicians
BEGIN
  UPDATE public_contacts
  SET verification_status = NEW.verification_status,
      last_verified_at = NEW.last_verified_at
  WHERE id = OLD.id;
END;
