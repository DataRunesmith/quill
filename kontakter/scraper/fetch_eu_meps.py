#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Hämtar Sveriges nuvarande ledamöter i Europaparlamentet via parlamentets
öppna data-API och synkar dem till D1-tabellen `public_contacts` som
area_type='eu', area_name='Europaparlamentet (Sverige)'.

Quill är inriktat på svenska politiska företrädare. Därför importeras
inte längre Europaparlamentets ledamöter från övriga 26 medlemsländer. Svenska
MEP:ars politiska grupp behålls i `party` eftersom den är relevant i just EU-
kontexten.

Mail-adresser finns inte i API-svaret utan hämtas från respektive officiell
profilsida.

Miljövariabler som krävs (läses ur processmiljön, se d1.py):
  CLOUDFLARE_ACCOUNT_ID
  CLOUDFLARE_API_TOKEN
  D1_DATABASE_UUID
"""

import re
import sys
import time

import requests

from d1 import D1Client

EP_API_BASE = "https://data.europarl.europa.eu/api/v2"
SWEDISH_EU_AREA = "Europaparlamentet (Sverige)"

UPSERT_SQL = (
    "INSERT INTO public_contacts (id, name, email, area_name, area_type, party, role, last_scraped_at) "
    "VALUES (lower(hex(randomblob(11))), ?, ?, ?, 'eu', ?, ?, ?) "
    "ON CONFLICT(email, area_name) DO UPDATE SET name = excluded.name, party = excluded.party, role = excluded.role, "
    "last_scraped_at = excluded.last_scraped_at, verification_status = NULL"
)

ROLE_TRANSLATION = {"Chair": "Ordförande", "Vice-Chair": "Vice ordförande", "Member": "Ledamot", "Substitute": "Suppleant"}
ROLE_PRIORITY = {"Chair": 0, "Vice-Chair": 1, "Member": 2, "Substitute": 3}


def fetch_all_current_meps() -> list[dict]:
    meps = []
    offset = 0
    while True:
        resp = requests.get(
            f"{EP_API_BASE}/meps/show-current",
            params={"limit": 100, "offset": offset},
            headers={"Accept": "application/ld+json"},
            timeout=30,
        )
        resp.raise_for_status()
        page = resp.json()["data"]
        if not page:
            break
        meps.extend(page)
        if len(page) < 100:
            break
        offset += 100
    return meps


def fetch_email_and_role(mep_id: str) -> tuple[str | None, str | None]:
    resp = requests.get(f"https://www.europarl.europa.eu/meps/en/{mep_id}/x/home", timeout=20)
    resp.raise_for_status()
    html = resp.text

    email = None
    match = re.search(r'class="link_email[^"]*"\s+href="([^"]+)"', html)
    if match:
        encoded = match.group(1)
        email = encoded.replace("[dot]", ".").replace("[at]", "@")[::-1]

    role = None
    best_rank = 99
    for m in re.finditer(r'<h4 class="es_title-h4">([^<]+)</h4>', html):
        rank = ROLE_PRIORITY.get(m.group(1), 99)
        if rank < best_rank:
            role, best_rank = m.group(1), rank
    role = ROLE_TRANSLATION.get(role)
    return email, role


def sync_one(client: D1Client, name: str, email: str, party: str | None, role: str | None, now_ms: int) -> bool:
    try:
        client.run(UPSERT_SQL, [name, email, SWEDISH_EU_AREA, party, role, now_ms])
        return True
    except (requests.RequestException, RuntimeError) as err:
        print(f"FEL: {name} <{email}>: {err}", file=sys.stderr)
        return False


def main():
    client = D1Client()
    meps = [m for m in fetch_all_current_meps() if m.get("api:country-of-representation") == "SE"]
    print(f"Hittade {len(meps)} svenska EU-parlamentariker.", flush=True)

    now_ms = int(time.time() * 1000)
    ok = fail = skipped = 0
    for i, m in enumerate(meps, 1):
        mep_id = m["id"].rstrip("/").split("/")[-1]
        name = f"{m['givenName']} {m['familyName']}"
        party = m.get("api:political-group")

        try:
            email, role = fetch_email_and_role(mep_id)
        except requests.HTTPError as err:
            print(f"FEL (HTTP) för {name} (id {mep_id}): {err}", file=sys.stderr, flush=True)
            fail += 1
            continue
        if not email:
            print(f"VARNING: ingen email hittad för {name} (id {mep_id})", file=sys.stderr, flush=True)
            skipped += 1
            continue

        if sync_one(client, name, email, party, role, now_ms):
            ok += 1
        else:
            fail += 1

        if i % 10 == 0:
            print(f"{i}/{len(meps)} klara ({ok} ok, {fail} fel, {skipped} utan email)...", flush=True)
        time.sleep(0.3)

    print(f"Klart. {ok} synkade, {fail} misslyckades, {skipped} utan email.", flush=True)
    if fail > 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
