#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Hämtar Svenska kyrkans kyrkovalda förtroendevalda till D1-tabellen
`public_contacts` (area_type='kyrka').

Kyrkovalet är allmänna val (nomineringsgrupperna är ofta partilistor: S, C,
SD-nära grupper, POSK m.fl.) men kyrkans folkvalda saknades i databasen.

Sidorna som läses, och vilket area_name varje sida får, står i kyrka.json i
källkatalogen (se sources.py). Parsern förutsätter server-renderad HTML i
Svenska kyrkans sidstruktur.

MEDVETET UTANFÖR (inga personliga mejl publiceras -> inget att hämta, och vi
GISSAR ALDRIG adresser eftersom SMTP-verifiering inte längre är möjlig och
studsar skadar avsändarreputationen):
- Stiftsstyrelser som bara listar namn; kontakt går via stiftskansliet. En
  sida läggs till i kyrka.json om stiftet börjar publicera adresser.
- Kyrkomötets 251 enskilda ledamöter: bara presidium/gruppledare har publik mejl.
- Gruppledarlistan: ostrukturerad (grupp/mejl utan namnrader), överlappar
  dessutom kyrkostyrelsen.

Sidstrukturen är konsekvent: [namnrad, uppdragsrad, "E-post:", mejlrad].
Personal (sekreterare, "Direkt:", växel) filtreras bort av kravet att
uppdragsraden nämner styrelsen/presidiet.
"""

import html
import re
import sys
import time

import requests

import sources
from d1 import D1Client


EMAIL_RE = re.compile(r"[\w.+-]+@[\w.-]+\.\w{2,}")
GROUP_RE = re.compile(r"\(([A-Za-zÅÄÖåäö]{1,10})\)")

# Uppdragsraden måste nämna något av detta — annars är det personal/adressrader.
ROLE_KEYWORDS = ("stiftsstyrelsen", "kyrkostyrelsen", "kyrkomötets ordförande",
                 "kyrkomötets förste vice", "kyrkomötets andre vice")

UPSERT_SQL = (
    "INSERT INTO public_contacts (id, name, email, area_name, area_type, party, role, last_scraped_at) "
    "VALUES (lower(hex(randomblob(11))), ?, ?, ?, 'kyrka', ?, ?, ?) "
    "ON CONFLICT(email, area_name) DO UPDATE SET name = excluded.name, "
    "party = excluded.party, role = excluded.role, last_scraped_at = excluded.last_scraped_at"
)


def page_lines(base_url: str, path: str) -> list[str]:
    resp = requests.get(base_url + path, headers={"User-Agent": "Mozilla/5.0"}, timeout=30)
    resp.raise_for_status()
    text = html.unescape(re.sub(r"<[^>]+>", "\n", resp.text))
    return [ln.strip() for ln in text.split("\n") if ln.strip()]


def clean_name(raw: str) -> str:
    name = GROUP_RE.sub("", raw)  # bort med "(posk)" etc.
    name = re.sub(r",.*$", "", name)  # bort med ", Stockholms stift"
    name = re.sub(r"^Biskop\s+", "", name)  # biskopen sitter som ordförande ex officio
    name = name.replace(" .", " ")  # källslarv: "Roberth .Krantz"
    return re.sub(r"\s+", " ", name).strip().strip(",")


def role_from(roles_line: str) -> str:
    s = roles_line.lower()
    if "ordförande" in s:
        if "1:e vice" in s or "förste vice" in s:
            return "1:e vice ordförande"
        if "2:e vice" in s or "andre vice" in s:
            return "2:e vice ordförande"
        if "vice ordförande" in s:
            return "Vice ordförande"
        return "Ordförande"
    if re.search(r"(stiftsstyrelsen|kyrkostyrelsen)\s*\(ersättare\)", s):
        return "Ersättare"
    return "Ledamot"


def extract(lines: list[str], area_name: str) -> list[tuple[str, str, str, str]]:
    """-> [(name, email, party, role)]. Mönster: namn / uppdrag / 'E-post:' / mejl."""
    rows = []
    for i, line in enumerate(lines):
        m = EMAIL_RE.search(line)
        if not m or i < 3:
            continue
        if not lines[i - 1].lower().startswith("e-post"):
            continue
        name_line, roles_line = lines[i - 3], lines[i - 2]
        if not any(k in roles_line.lower() for k in ROLE_KEYWORDS):
            continue
        name = clean_name(name_line)
        # Namnrad ska se ut som ett namn, inte etikett/telefonnummer.
        if not name or any(ch.isdigit() for ch in name) or name.endswith(":"):
            continue
        gm = GROUP_RE.search(name_line)
        party = gm.group(1).upper() if gm else None
        rows.append((name, m.group(0), party, role_from(roles_line)))
    return rows


def main() -> None:
    dry_run = "--dry-run" in sys.argv
    all_rows: list[tuple[str, str, str, str, str]] = []
    seen: set[tuple[str, str]] = set()

    config = sources.load("kyrka")
    for page in config["pages"]:
        area = page["area"]
        try:
            rows = extract(page_lines(config["base_url"], page["path"]), area)
        except Exception as exc:  # en trasig stiftsida ska inte fälla resten
            print(f"FEL {area}: {exc}", file=sys.stderr)
            continue
        fresh = [(n, e, area, p, r) for n, e, p, r in rows if (e.lower(), area) not in seen]
        seen.update((e.lower(), area) for _, e, _, _ in rows)
        print(f"{area}: {len(fresh)} personer")
        all_rows.extend(fresh)

    print(f"\nTotalt: {len(all_rows)} kyrkovalda")
    if dry_run:
        for n, e, area, p, r in all_rows:
            print(f"  {area:<18} {r:<22} {p or '-':<6} {n} <{e}>")
        return

    client = D1Client()
    now_ms = int(time.time() * 1000)
    ok = fail = 0
    for name, email, area, party, role in all_rows:
        try:
            client.run(UPSERT_SQL, [name, email, area, party, role, now_ms])
            ok += 1
        except Exception as exc:
            print(f"FEL {name} <{email}>: {exc}", file=sys.stderr)
            fail += 1
    print(f"Synkat till D1: {ok} ok, {fail} fel")


if __name__ == "__main__":
    main()
