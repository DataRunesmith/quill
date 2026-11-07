from pathlib import Path
import sqlite3

ROOT = Path(__file__).resolve().parents[2]
MIGRATION = ROOT / "infra" / "migrations" / "0003_generalize_public_contacts.sql"


def pre_migration_db() -> sqlite3.Connection:
    db = sqlite3.connect(":memory:")
    db.execute("PRAGMA foreign_keys = ON")
    db.executescript(
        """
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

        INSERT INTO politicians
          (id, name, email, area_name, area_type, party, role, last_scraped_at)
        VALUES
          ('p1', 'Test Person', 'test@example.com', 'Testkommun', 'kommun', 'X', NULL, 1);

        INSERT INTO politician_assignments
          (politician_id, area_name, body, role, source, last_scraped_at)
        VALUES
          ('p1', 'Testkommun', 'Kommunstyrelsen', '', 'test', 1);
        """
    )
    return db


def test_public_contact_migration_preserves_data_and_legacy_worker_reads():
    db = pre_migration_db()
    db.executescript(MIGRATION.read_text(encoding="utf-8"))

    row = db.execute(
        "SELECT id, email, area_type FROM public_contacts WHERE id='p1'"
    ).fetchone()
    assert row == ("p1", "test@example.com", "kommun")

    legacy = db.execute(
        "SELECT id, email, area_type FROM politicians WHERE id='p1'"
    ).fetchone()
    assert legacy == row

    assignment = db.execute(
        "SELECT politician_id, body FROM politician_assignments WHERE politician_id='p1'"
    ).fetchone()
    assert assignment == ("p1", "Kommunstyrelsen")


def test_legacy_worker_verification_update_reaches_public_contacts():
    db = pre_migration_db()
    db.executescript(MIGRATION.read_text(encoding="utf-8"))

    db.execute(
        "UPDATE politicians SET verification_status='valid_via_send', last_verified_at=123 WHERE email='test@example.com'"
    )

    row = db.execute(
        "SELECT verification_status, last_verified_at FROM public_contacts WHERE id='p1'"
    ).fetchone()
    assert row == ("valid_via_send", 123)


def test_assignment_foreign_key_tracks_renamed_table_and_column():
    db = pre_migration_db()
    db.executescript(MIGRATION.read_text(encoding="utf-8"))

    fks = db.execute("PRAGMA foreign_key_list(public_contact_assignments)").fetchall()
    assert any(row[2] == "public_contacts" and row[3] == "contact_id" and row[4] == "id" for row in fks)

    columns = {row[1] for row in db.execute("PRAGMA table_info(public_contacts)")}
    assert {"organisation", "unit", "title", "academic_field", "source_url"} <= columns
