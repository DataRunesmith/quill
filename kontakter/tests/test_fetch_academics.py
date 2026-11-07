from pathlib import Path
import importlib.util
import sqlite3
import sys

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRAPER = ROOT / "scraper"
sys.path.insert(0, str(SCRAPER))


def load_module():
    path = SCRAPER / "fetch_academics.py"
    spec = importlib.util.spec_from_file_location("fetch_academics_test", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


academics = load_module()


def contact(**changes):
    row = academics.load_contacts()[0]
    return academics.AcademicContact(**{**row.__dict__, **changes})


def test_example_sources_cover_all_core_fields():
    rows = academics.validated_contacts()
    assert {row.academic_field for row in rows} == academics.ACADEMIC_FIELDS
    for row in rows:
        assert row.email == row.email.lower()
        assert row.source_url.startswith("https://")


def test_address_must_belong_to_the_source_institution():
    assert academics.organisation_domain("statsvet.uni.example") == "uni.example"
    assert academics.organisation_domain("www.uni.example") == "uni.example"
    academics.validate_contact(contact(email="a@statsvet.uni.example", source_url="https://www.uni.example/p"))
    with pytest.raises(ValueError, match="lärosäte"):
        academics.validate_contact(contact(email="a@other.example", source_url="https://www.uni.example/p"))
    with pytest.raises(ValueError, match="källa"):
        academics.validate_contact(contact(source_url="http://www.uni.example/p"))


def test_rejects_unnormalised_unknown_and_duplicate_contacts():
    with pytest.raises(ValueError, match="normaliserad"):
        academics.validate_contact(contact(email="A@uni.example"))
    with pytest.raises(ValueError, match="område"):
        academics.validate_contact(contact(academic_field="astrology"))
    row = academics.load_contacts()[0]
    with pytest.raises(ValueError, match="Duplicerad"):
        academics.validated_contacts([row, row])


def test_academic_upsert_targets_general_public_contact_registry():
    assert "INSERT INTO public_contacts" in academics.UPSERT_SQL
    assert "'academia'" in academics.UPSERT_SQL
    assert "academic_field" in academics.UPSERT_SQL
    assert "source_url" in academics.UPSERT_SQL


def test_academic_sql_export_is_idempotent_and_sqlite_valid(tmp_path):
    rows = academics.validated_contacts()
    sql_path = tmp_path / "academics.sql"
    academics.write_sql_file(sql_path, rows, 123456789)
    sql = sql_path.read_text(encoding="utf-8")

    assert not sql.startswith("BEGIN;\n")
    assert "BEGIN;" not in sql
    assert "COMMIT;" not in sql
    assert "SAVEPOINT" not in sql
    assert sql.endswith(";\n")
    assert sql.count("INSERT INTO public_contacts") == len(rows)

    db = sqlite3.connect(":memory:")
    db.execute(
        """
        CREATE TABLE public_contacts (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          email TEXT NOT NULL,
          area_name TEXT NOT NULL,
          area_type TEXT NOT NULL,
          party TEXT,
          role TEXT,
          last_scraped_at INTEGER NOT NULL,
          organisation TEXT,
          unit TEXT,
          title TEXT,
          academic_field TEXT,
          source_url TEXT,
          UNIQUE(email, area_name)
        )
        """
    )
    db.executescript(sql)
    db.executescript(sql)

    count = db.execute("SELECT COUNT(*) FROM public_contacts WHERE area_type='academia'").fetchone()[0]
    fields = db.execute("SELECT COUNT(DISTINCT academic_field) FROM public_contacts WHERE area_type='academia'").fetchone()[0]
    assert count == len(rows)
    assert fields == len(academics.ACADEMIC_FIELDS)


def test_sql_literal_escapes_apostrophes_without_guessing():
    assert academics.sql_literal("O'Brien") == "'O''Brien'"
