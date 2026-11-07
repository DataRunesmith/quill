-- Remove the temporary D1 compatibility layer from the public-contact cutover.
-- Current Worker code reads and writes public_contacts/public_contact_assignments.
-- The public HTTP alias /api/politicians/search is intentionally unaffected.

DROP TRIGGER IF EXISTS politicians_compat_verification_update;
DROP VIEW IF EXISTS politician_assignments;
DROP VIEW IF EXISTS politicians;
