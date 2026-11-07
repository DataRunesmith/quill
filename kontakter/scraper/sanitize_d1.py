#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Sanitera befintlig mottagardata i D1 utan att skrapa nya källor.

Behåller endast information som behövs för mottagarurvalet: person, område,
politisk nivå, parti och relevanta huvudnämnder/organ. Detaljerade befattningar,
fullmäktige, utskott, beredningar, råd och andra sidouppdrag tas bort.
Standardläget är dry-run; ``--apply`` krävs för skrivningar.
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import subprocess
import sys
import tempfile

DB_NAME = os.environ.get("D1_DATABASE_NAME", "quill")
SWEDISH_EU_AREA = "Europaparlamentet (Sverige)"
REPO_ROOT = Path(__file__).resolve().parents[2]

IRRELEVANT_ROLE_SQL = """
(
  LOWER(role) LIKE '%revisor%'
  OR LOWER(role) LIKE '%nämndeman%'
  OR LOWER(role) LIKE '%nämndemän%'
  OR LOWER(role) LIKE '%vigselförrätt%'
  OR LOWER(role) LIKE '%partnerskapsförrätt%'
  OR LOWER(role) = 'god man'
  OR LOWER(role) LIKE 'gode män%'
)
""".strip()

RELEVANT_BODY_SQL = """
(
  LOWER(TRIM(body)) IN ('kommunstyrelse', 'kommunstyrelsen', 'regionstyrelse', 'regionstyrelsen')
  OR (
    LOWER(body) LIKE '%nämnd%'
    AND LOWER(body) NOT LIKE '%fullmäktige%'
    AND LOWER(body) NOT LIKE '%utskott%'
    AND LOWER(body) NOT LIKE '%beredning%'
    AND LOWER(body) NOT LIKE '%nämndeman%'
    AND LOWER(body) NOT LIKE '%nämndemän%'
    AND LOWER(body) NOT LIKE '%vigselförrätt%'
    AND LOWER(body) NOT LIKE '%kommunalförbund%'
  )
)
""".strip()

# Endast partier som är användbara som publika filter behålls. Lokala och
# okända råvärden ska inte ligga kvar gömda i databasen.
KNOWN_PARTIES_SQL = "'S','M','SD','V','C','L','KD','MP','FI','MED','AFS','ÖP','PP'"

APPLY_SQL = f"""
DELETE FROM public_contacts
WHERE area_type = 'eu'
  AND area_name <> '{SWEDISH_EU_AREA}';

DELETE FROM public_contacts
WHERE area_type IN ('kommun', 'region')
  AND role IS NOT NULL
  AND TRIM(role) <> ''
  AND {IRRELEVANT_ROLE_SQL};

UPDATE public_contacts
SET party = CASE LOWER(TRIM(party))
  WHEN 's' THEN 'S'
  WHEN 'socialdemokraterna' THEN 'S'
  WHEN 'socialdemokratiska arbetarepartiet' THEN 'S'
  WHEN 'm' THEN 'M'
  WHEN 'moderaterna' THEN 'M'
  WHEN 'moderata samlingspartiet' THEN 'M'
  WHEN 'sd' THEN 'SD'
  WHEN 'sverigedemokraterna' THEN 'SD'
  WHEN 'v' THEN 'V'
  WHEN 'vänsterpartiet' THEN 'V'
  WHEN 'c' THEN 'C'
  WHEN 'centerpartiet' THEN 'C'
  WHEN 'l' THEN 'L'
  WHEN 'liberalerna' THEN 'L'
  WHEN 'folkpartiet liberalerna' THEN 'L'
  WHEN 'kd' THEN 'KD'
  WHEN 'kristdemokraterna' THEN 'KD'
  WHEN 'mp' THEN 'MP'
  WHEN 'miljöpartiet' THEN 'MP'
  WHEN 'miljöpartiet de gröna' THEN 'MP'
  WHEN 'fi' THEN 'FI'
  WHEN 'feministiskt initiativ' THEN 'FI'
  WHEN 'med' THEN 'MED'
  WHEN 'medborgerlig samling' THEN 'MED'
  WHEN 'afs' THEN 'AFS'
  WHEN 'alternativ för sverige' THEN 'AFS'
  WHEN 'alternativ för sverige (afs)' THEN 'AFS'
  WHEN 'öp' THEN 'ÖP'
  WHEN 'örebropartiet' THEN 'ÖP'
  WHEN 'örebropartiet (öp)' THEN 'ÖP'
  WHEN 'pp' THEN 'PP'
  WHEN 'piratpartiet' THEN 'PP'
  ELSE TRIM(party)
END
WHERE party IS NOT NULL;

-- Allt utanför den avsiktliga filterlistan tas bort i stället för att döljas.
UPDATE public_contacts
SET party = NULL
WHERE party IS NOT NULL
  AND party NOT IN ({KNOWN_PARTIES_SQL});

UPDATE public_contacts SET role = NULL WHERE area_type NOT IN ('media', 'academia') AND role IS NOT NULL;
UPDATE public_contact_assignments SET role = '' WHERE role <> '';

DELETE FROM public_contact_assignments
WHERE NOT {RELEVANT_BODY_SQL};

INSERT OR IGNORE INTO public_contact_assignments
  (contact_id, area_name, body, role, source, last_scraped_at)
SELECT contact_id, area_name, 'Kommunstyrelsen', role, source, last_scraped_at
FROM public_contact_assignments
WHERE LOWER(TRIM(body)) IN ('kommunstyrelse', 'kommunstyrelsen');
DELETE FROM public_contact_assignments
WHERE LOWER(TRIM(body)) IN ('kommunstyrelse', 'kommunstyrelsen')
  AND body <> 'Kommunstyrelsen';

INSERT OR IGNORE INTO public_contact_assignments
  (contact_id, area_name, body, role, source, last_scraped_at)
SELECT contact_id, area_name, 'Regionstyrelsen', role, source, last_scraped_at
FROM public_contact_assignments
WHERE LOWER(TRIM(body)) IN ('regionstyrelse', 'regionstyrelsen');
DELETE FROM public_contact_assignments
WHERE LOWER(TRIM(body)) IN ('regionstyrelse', 'regionstyrelsen')
  AND body <> 'Regionstyrelsen';

INSERT OR IGNORE INTO public_contact_assignments
  (contact_id, area_name, body, role, source, last_scraped_at)
SELECT contact_id, area_name, TRIM(body) || 'en', role, source, last_scraped_at
FROM public_contact_assignments
WHERE LOWER(TRIM(body)) LIKE '%nämnd'
  AND LOWER(TRIM(body)) NOT LIKE '%nämnden';
DELETE FROM public_contact_assignments
WHERE LOWER(TRIM(body)) LIKE '%nämnd'
  AND LOWER(TRIM(body)) NOT LIKE '%nämnden';
""".strip()


def wrangler(*args: str) -> None:
    try:
        subprocess.run(["npx", "wrangler", *args], cwd=REPO_ROOT, check=True)
    except FileNotFoundError:
        sys.exit("FEL: npx hittades inte. Kör jobbet på servern där Wrangler används.")
    except subprocess.CalledProcessError as exc:
        sys.exit(exc.returncode)


def query(sql: str) -> None:
    wrangler("d1", "execute", DB_NAME, "--remote", "--command", sql)


def dry_run() -> None:
    print("=== D1 SANITERING: DRY-RUN ===")
    print("\nUtländska EU-rader som skulle tas bort:")
    query(f"SELECT area_name, COUNT(*) AS rows FROM public_contacts WHERE area_type='eu' AND area_name<>'{SWEDISH_EU_AREA}' GROUP BY area_name ORDER BY area_name;")
    print("\nIrrelevanta kommun-/regionuppdrag som skulle tas bort:")
    query("SELECT area_type, role, COUNT(*) AS rows FROM public_contacts WHERE area_type IN ('kommun','region') AND role IS NOT NULL AND " + IRRELEVANT_ROLE_SQL + " GROUP BY area_type, role ORDER BY rows DESC, role;")
    print("\nDetaljerade huvudroller som skulle rensas:")
    query("SELECT COUNT(*) AS rows FROM public_contacts WHERE area_type NOT IN ('media','academia') AND role IS NOT NULL AND TRIM(role) <> ''; ")
    print("\nDetaljerade nämndroller som skulle rensas:")
    query("SELECT COUNT(*) AS rows FROM public_contact_assignments WHERE role <> ''; ")
    print("\nNämnd/organ-brus som skulle tas bort:")
    query("SELECT COUNT(*) AS rows FROM public_contact_assignments WHERE NOT " + RELEVANT_BODY_SQL + ";")
    print("\nVanligaste body-värden som skulle tas bort:")
    query("SELECT body, COUNT(*) AS rows FROM public_contact_assignments WHERE NOT " + RELEVANT_BODY_SQL + " GROUP BY body ORDER BY rows DESC LIMIT 50;")
    print("\nKvarvarande relevanta body-värden, vanligaste först:")
    query("SELECT body, COUNT(*) AS rows FROM public_contact_assignments WHERE " + RELEVANT_BODY_SQL + " GROUP BY body ORDER BY rows DESC LIMIT 100;")
    print("\nPartivärden före normalisering:")
    query("SELECT party, COUNT(*) AS rows FROM public_contacts WHERE party IS NOT NULL GROUP BY party ORDER BY rows DESC, party LIMIT 200;")
    print("\nPartivärden som skulle tas bort efter normalisering:")
    query("SELECT party, COUNT(*) AS rows FROM public_contacts WHERE party IS NOT NULL AND UPPER(TRIM(party)) NOT IN (" + KNOWN_PARTIES_SQL + ") GROUP BY party ORDER BY rows DESC, party LIMIT 200;")
    print("\nDRY-RUN: inga ändringar skrevs. Kör med --apply efter granskning.")


def apply() -> None:
    print("=== D1 SANITERING: APPLY ===")
    with tempfile.NamedTemporaryFile("w", suffix=".sql", encoding="utf-8", delete=False) as f:
        f.write(APPLY_SQL)
        sql_path = Path(f.name)
    try:
        wrangler("d1", "execute", DB_NAME, "--remote", "--file", str(sql_path))
    finally:
        sql_path.unlink(missing_ok=True)

    print("\nEfterkontroll: utländska EU-rader (ska vara 0):")
    query(f"SELECT COUNT(*) AS rows FROM public_contacts WHERE area_type='eu' AND area_name<>'{SWEDISH_EU_AREA}';")
    print("\nEfterkontroll: detaljerade huvudroller (ska vara 0):")
    query("SELECT COUNT(*) AS rows FROM public_contacts WHERE area_type NOT IN ('media','academia') AND role IS NOT NULL AND TRIM(role) <> ''; ")
    print("\nEfterkontroll: detaljerade nämndroller (ska vara 0):")
    query("SELECT COUNT(*) AS rows FROM public_contact_assignments WHERE role <> ''; ")
    print("\nEfterkontroll: irrelevant nämnd/organ-brus (ska vara 0):")
    query("SELECT COUNT(*) AS rows FROM public_contact_assignments WHERE NOT " + RELEVANT_BODY_SQL + ";")
    print("\nEfterkontroll: kvarvarande nämnd/organ-kopplingar:")
    query("SELECT COUNT(*) AS assignments, COUNT(DISTINCT contact_id) AS public_contacts FROM public_contact_assignments;")
    print("\nEfterkontroll: kvarvarande EU-områden:")
    query("SELECT area_name, COUNT(*) AS rows FROM public_contacts WHERE area_type='eu' GROUP BY area_name;")
    print("\nEfterkontroll: okända partivärden (ska vara 0):")
    query("SELECT COUNT(*) AS rows FROM public_contacts WHERE party IS NOT NULL AND party NOT IN (" + KNOWN_PARTIES_SQL + ");")
    print("\nEfterkontroll: kvarvarande partivärden:")
    query("SELECT party, COUNT(*) AS rows FROM public_contacts WHERE party IS NOT NULL GROUP BY party ORDER BY rows DESC, party;")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="Verkställ saniteringen i D1-databasen.")
    args = parser.parse_args()
    apply() if args.apply else dry_run()


if __name__ == "__main__":
    main()
