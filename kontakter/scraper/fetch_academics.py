#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Synkar akademiska offentliga yrkeskontakter till D1.

Kontakterna läses från academics.json i källkatalogen (se sources.py); koden
innehåller inga namn eller adresser. Endast e-postadresser som uttryckligen
publiceras av lärosätet används. Adresser konstrueras aldrig från namn eller
kända adressmönster.

Kärnområden:
- statsvetenskap
- offentlig förvaltning
- offentlig rätt / förvaltningsrätt

Varje post har sin officiella käll-URL för spårbarhet, och adressen måste höra
till samma lärosäte som källsidan. E-postverifieringen hanterar leveransstatus
separat.

Skriptet kan antingen skriva direkt via D1 HTTP-klienten eller generera en
idempotent SQL-fil för Wrangler med --sql-file.
"""
from __future__ import annotations

import argparse
import time
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

import sources

POLITICAL_SCIENCE = "political-science"
PUBLIC_ADMINISTRATION = "public-administration"
PUBLIC_LAW = "public-law"
ACADEMIC_FIELDS = {POLITICAL_SCIENCE, PUBLIC_ADMINISTRATION, PUBLIC_LAW}


@dataclass(frozen=True)
class AcademicContact:
    name: str
    email: str
    organisation: str
    unit: str
    title: str
    academic_field: str
    source_url: str


def organisation_domain(host: str) -> str:
    """De två sista leden i ett värdnamn: statsvet.uu.se och www.uu.se ger båda uu.se.

    Räcker för svenska lärosäten under .se, men inte för domäner som co.uk.
    """
    return ".".join(host.lower().rstrip(".").rsplit(".", 2)[-2:])


UPSERT_SQL = (
    "INSERT INTO public_contacts "
    "(id, name, email, area_name, area_type, party, role, last_scraped_at, "
    "organisation, unit, title, academic_field, source_url) "
    "VALUES (lower(hex(randomblob(11))), ?, ?, ?, 'academia', NULL, ?, ?, ?, ?, ?, ?, ?) "
    "ON CONFLICT(email, area_name) DO UPDATE SET "
    "name=excluded.name, role=excluded.role, last_scraped_at=excluded.last_scraped_at, "
    "organisation=excluded.organisation, unit=excluded.unit, title=excluded.title, "
    "academic_field=excluded.academic_field, source_url=excluded.source_url"
)


def validate_contact(contact: AcademicContact) -> None:
    email = contact.email.strip().lower()
    if email != contact.email:
        raise ValueError(f"E-post måste vara normaliserad: {contact.email}")
    if email.count("@") != 1:
        raise ValueError(f"Ogiltig e-postadress: {contact.email}")
    if contact.academic_field not in ACADEMIC_FIELDS:
        raise ValueError(f"Okänt akademiskt område: {contact.academic_field}")
    source = urlparse(contact.source_url)
    if source.scheme != "https" or not source.hostname:
        raise ValueError(f"Ogiltig officiell källa: {contact.source_url}")
    domain = email.rsplit("@", 1)[1]
    if organisation_domain(domain) != organisation_domain(source.hostname):
        raise ValueError(f"Adressen hör inte till källans lärosäte: {email} / {contact.source_url}")
    if not all((contact.name, contact.organisation, contact.unit, contact.title)):
        raise ValueError(f"Ofullständig akademisk kontakt: {contact.email}")


def load_contacts() -> list[AcademicContact]:
    return [AcademicContact(**row) for row in sources.load("academics")]


def validated_contacts(contacts: list[AcademicContact] | None = None) -> list[AcademicContact]:
    seen: set[tuple[str, str]] = set()
    rows: list[AcademicContact] = []
    for contact in load_contacts() if contacts is None else contacts:
        validate_contact(contact)
        key = (contact.email, contact.organisation)
        if key in seen:
            raise ValueError(f"Duplicerad akademisk kontakt: {contact.email} / {contact.organisation}")
        seen.add(key)
        rows.append(contact)
    return rows


def sql_literal(value: str | int | None) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, int):
        return str(value)
    return "'" + value.replace("'", "''") + "'"


def academic_upsert_statement(contact: AcademicContact, now_ms: int) -> str:
    name = sql_literal(contact.name)
    email = sql_literal(contact.email)
    area_name = sql_literal(contact.organisation)
    role = sql_literal(contact.title)
    scraped_at = sql_literal(now_ms)
    organisation = sql_literal(contact.organisation)
    unit = sql_literal(contact.unit)
    title = sql_literal(contact.title)
    academic_field = sql_literal(contact.academic_field)
    source_url = sql_literal(contact.source_url)
    return (
        "INSERT INTO public_contacts "
        "(id, name, email, area_name, area_type, party, role, last_scraped_at, "
        "organisation, unit, title, academic_field, source_url) VALUES "
        f"(lower(hex(randomblob(11))), {name}, {email}, {area_name}, 'academia', NULL, "
        f"{role}, {scraped_at}, {organisation}, {unit}, {title}, {academic_field}, {source_url}) "
        "ON CONFLICT(email, area_name) DO UPDATE SET "
        "name=excluded.name, role=excluded.role, last_scraped_at=excluded.last_scraped_at, "
        "organisation=excluded.organisation, unit=excluded.unit, title=excluded.title, "
        "academic_field=excluded.academic_field, source_url=excluded.source_url"
    )


def write_sql_file(path: Path, rows: list[AcademicContact], now_ms: int) -> None:
    # Wrangler D1 remote file execution rejects explicit SQL transaction-control
    # statements (BEGIN/COMMIT/SAVEPOINT). Each UPSERT is idempotent, so a
    # partially applied file can safely be retried without a manual transaction.
    statements = [academic_upsert_statement(row, now_ms) + ";" for row in rows]
    path.write_text("\n".join(statements) + "\n", encoding="utf-8")


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__)
    mode = p.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", help="Visa urvalet utan skrivning.")
    mode.add_argument("--sql-file", type=Path, help="Skriv idempotent D1-SQL till fil i stället för HTTP-synk.")
    mode.add_argument("--count", action="store_true", help="Skriv endast antal akademikontakter.")
    return p


def main() -> None:
    args = parser().parse_args()
    rows = validated_contacts()

    if args.count:
        print(len(rows))
        return

    print(f"Akademiska kontakter: {len(rows)}")
    for field in sorted(ACADEMIC_FIELDS):
        print(f"  {field}: {sum(row.academic_field == field for row in rows)}")

    if args.dry_run:
        for row in rows:
            print(f"  {row.organisation:<24} {row.academic_field:<24} {row.name} <{row.email}>")
        return

    now_ms = int(time.time() * 1000)
    if args.sql_file:
        write_sql_file(args.sql_file, rows, now_ms)
        print(f"Skrev {len(rows)} idempotenta akademikontakter till {args.sql_file}")
        return

    from d1 import D1Client

    client = D1Client()
    ok = fail = 0
    for row in rows:
        try:
            client.run(
                UPSERT_SQL,
                [
                    row.name,
                    row.email,
                    row.organisation,
                    row.title,
                    now_ms,
                    row.organisation,
                    row.unit,
                    row.title,
                    row.academic_field,
                    row.source_url,
                ],
            )
            ok += 1
        except Exception as exc:
            print(f"FEL {row.name} <{row.email}>: {exc}")
            fail += 1

    print(f"Synkat akademi till D1: {ok} ok, {fail} fel")
    if fail:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
