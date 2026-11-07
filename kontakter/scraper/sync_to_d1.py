#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Synka skrapad mottagardata till D1.

Applikationsdata innehåller bara det som behövs för mottagarurvalet:
namn, e-post, politisk nivå/område och parti. Detaljerade befattningar
sparas inte i public_contacts; nämnd/organ hanteras separat.
"""

import csv
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests

from d1 import D1Client
from quill_common import normalize_party

RESULTAT_CSV = os.environ.get(
    "RESULTAT_CSV",
    os.path.join(os.path.dirname(__file__), "..", "resultat", "Alla_kommuner_och_regioner.csv"),
)
MAX_WORKERS = 10

UPSERT_SQL = (
    "INSERT INTO public_contacts (id, name, email, area_name, area_type, party, role, last_scraped_at) "
    "VALUES (lower(hex(randomblob(11))), ?, ?, ?, ?, ?, NULL, ?) "
    "ON CONFLICT(email, area_name) DO UPDATE SET "
    "name = excluded.name, party = excluded.party, role = NULL, last_scraped_at = excluded.last_scraped_at"
)

REGION_NAMES = frozenset({
    "Region Blekinge", "Region Dalarna", "Region Gotland", "Region Gävleborg",
    "Region Halland", "Region Jämtland Härjedalen", "Region Jönköpings län",
    "Region Kalmar län", "Region Kronoberg", "Region Norrbotten", "Region Skåne",
    "Region Stockholm", "Region Sörmland", "Region Uppsala", "Region Värmland",
    "Region Västerbotten", "Region Västernorrland", "Region Västmanland",
    "Region Örebro län", "Region Östergötland", "Västra Götalandsregionen",
})


def area_type_for(area_name: str) -> str:
    if area_name in REGION_NAMES or area_name.startswith("Region "):
        return "region"
    if area_name in ("Sveriges riksdag", "Riksdagen"):
        return "riksdag"
    if "departementet" in area_name.lower() or "regeringskansliet" in area_name.lower() or area_name == "Regeringen":
        return "regering"
    return "kommun"


def parse_csv(path: str):
    rows = []
    with open(path, newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            email = (r.get("email") or "").strip()
            if not email:
                continue
            area = (r.get("area_name") or "").strip()
            rows.append(((r.get("name") or "").strip(), email.lower(), area, area_type_for(area), normalize_party(r.get("party"))))
    return rows


def load_rows():
    if not os.path.exists(RESULTAT_CSV):
        sys.exit(f"FEL: {RESULTAT_CSV} saknas. Kör scrapern eller ange RESULTAT_CSV.")
    print(f"Läser {RESULTAT_CSV}")
    return parse_csv(RESULTAT_CSV)


def upsert_row(client: D1Client, row) -> tuple[bool, str]:
    name, email, area_name, area_type, party = row
    try:
        client.run(UPSERT_SQL, [name, email, area_name, area_type, party, int(time.time() * 1000)])
        return True, email
    except (requests.RequestException, RuntimeError) as err:
        return False, f"{email}: {err}"


def sync(rows) -> tuple[int, int]:
    client = D1Client()
    ok_count = fail_count = 0
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        futures = {pool.submit(upsert_row, client, row): row for row in rows}
        for i, future in enumerate(as_completed(futures), 1):
            success, info = future.result()
            if success:
                ok_count += 1
            else:
                fail_count += 1
                print(f"FEL: {info}", file=sys.stderr)
            if i % 200 == 0:
                print(f"{i}/{len(rows)} klara ({ok_count} ok, {fail_count} fel)...")
    return ok_count, fail_count


def main():
    rows = load_rows()
    if not rows:
        sys.exit("Inga rader hittades att synka")
    print(f"Hittade {len(rows)} mottagarrader. Synkar till D1...")
    ok_count, fail_count = sync(rows)
    print(f"Klart. {ok_count} synkade, {fail_count} misslyckades.")
    if fail_count:
        sys.exit(1)


if __name__ == "__main__":
    main()
