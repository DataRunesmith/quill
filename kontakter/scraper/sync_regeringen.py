#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Synkar regeringens 11 departement (registratorsadresser) till D1-tabellen
`public_contacts` (area_type='regering').

Det finns medvetet INGA personliga mailadresser till enskilda statsråd —
all formell kontakt med regeringen sker via departementets registrator
(bekräftat på regeringen.se/kontaktuppgifter/). Varje rad representerar
därför ett departement, inte en enskild person.

Källa: ~/Regeringen.txt (en registratorsadress per rad, redan skrapad
tidigare i projektet).
"""

import os
import time

import requests

from d1 import D1Client

DEPARTMENT_NAMES = {
    "arbetsmarknadsdepartementet": "Arbetsmarknadsdepartementet",
    "finansdepartementet": "Finansdepartementet",
    "forsvarsdepartementet": "Försvarsdepartementet",
    "justitiedepartementet": "Justitiedepartementet",
    "klimat-naringslivsdepartementet": "Klimat- och näringslivsdepartementet",
    "kulturdepartementet": "Kulturdepartementet",
    "landsbygds-infrastrukturdepartementet": "Landsbygds- och infrastrukturdepartementet",
    "socialdepartementet": "Socialdepartementet",
    "statsradsberedningen": "Statsrådsberedningen",
    "utbildningsdepartementet": "Utbildningsdepartementet",
    "utrikesdepartementet": "Utrikesdepartementet",
}

UPSERT_SQL = (
    "INSERT INTO public_contacts (id, name, email, area_name, area_type, last_scraped_at) "
    "VALUES (lower(hex(randomblob(11))), ?, ?, ?, 'regering', ?) "
    "ON CONFLICT(email, area_name) DO UPDATE SET name = excluded.name, last_scraped_at = excluded.last_scraped_at"
)


def main():
    client = D1Client()

    path = os.path.join(os.path.dirname(__file__), "..", "..", "Regeringen.txt")
    path = os.path.expanduser("~/Regeringen.txt") if not os.path.exists(path) else path
    with open(path, encoding="utf-8") as f:
        emails = [line.strip() for line in f if line.strip()]

    now_ms = int(time.time() * 1000)
    ok = fail = 0
    for email in emails:
        prefix = email.split(".registrator@")[0]
        name = DEPARTMENT_NAMES.get(prefix, prefix.capitalize())
        try:
            client.run(UPSERT_SQL, [name, email, name, now_ms])
            ok += 1
            print(f"OK: {name} <{email}>")
        except (requests.RequestException, RuntimeError) as err:
            fail += 1
            print(f"FEL: {name} <{email}>: {err}")

    print(f"Klart. {ok} synkade, {fail} misslyckades.")


if __name__ == "__main__":
    main()
