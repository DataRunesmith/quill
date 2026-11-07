#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Bakåtfyll relevanta politiska huvudnämnder/organ från Troman-profiler till D1.

Endast organ som faktiskt är användbara som mottagarfilter sparas: kommun-/
regionstyrelse och riktiga nämnder. Fullmäktige, utskott, beredningar, råd,
rollistor och andra administrativa sidouppdrag ignoreras redan vid skrapningen.
Detaljerade befattningar som ledamot, ersättare, ordförande eller sekreterare
samlas inte in.

D1 läses och skrivs via Wrangler. Därmed återanvänds den Cloudflare-inloggning
som redan används av resten av repot och skriptet kräver inga separata
CLOUDFLARE_* eller D1_* miljövariabler. HTTP-hämtning använder endast Pythons
standardbibliotek, så inga pip-paket behövs heller.

Skrapresultatet cachelagras i /tmp innan D1-skrivningen. Om en D1-batch skulle
misslyckas kan skriptet köras igen utan att skrapa om alla 150 källor. Cachen
tas först bort efter att en separat D1-SELECT verifierat både antal kopplingar
och antal politiker för den aktuella körningen.
"""
from __future__ import annotations

import html
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin
from urllib.request import Request, urlopen

import sources

REPO_ROOT = Path(__file__).resolve().parents[2]
WRANGLER_CONFIG = REPO_ROOT / "app" / "wrangler.jsonc"
D1_NAME = os.environ.get("D1_DATABASE_NAME", "quill")
CACHE_PATH = Path("/tmp/quill-assignments-backfill.json")
BATCH_PEOPLE = 200

# Dessa namn beskriver inte en avgränsad huvudnämnd som är rimlig att rikta ett
# massutskick mot. Filtreringen görs här, vid källan, så bruset aldrig lagras.
EXCLUDED_BODY_TERMS = (
    "fullmäktige",
    "utskott",
    "beredning",
    "nämndemän",
    "nämndeman",
    "vigselförrätt",
    "gruppledare",
    "kommunalråd",
    "regionråd",
    "partiföreträdare",
    "politisk sekreter",
    "politiska sekreter",
    "kommunalförbund",
)


def load_regioner() -> list[dict]:
    return sources.load("regioner")


def fetch(url: str, timeout: int = 30) -> str | None:
    try:
        request = Request(url, headers={"User-Agent": "Quill scraper/1.0"})
        with urlopen(request, timeout=timeout) as response:
            charset = response.headers.get_content_charset() or "utf-8"
            return response.read().decode(charset, errors="replace")
    except (HTTPError, URLError, TimeoutError, OSError) as exc:
        print(f"  FEL {url}: {exc}", file=sys.stderr, flush=True)
        return None


def clean_text(fragment: str) -> str:
    text = html.unescape(re.sub(r"<[^>]+>", "", fragment))
    return re.sub(r"\s+", " ", text).strip()


def email_from_page(page_html: str) -> set[str]:
    emails = set()
    for href in re.findall(r'href="(mailto:[^"]+)"', page_html, re.I):
        email = href[7:].split("?", 1)[0].strip().lower()
        if "@" in email:
            emails.add(email)
    return emails


def normalize_body(raw_body: str) -> str | None:
    """Returnera kanoniskt namn för ett relevant huvudorgan, annars None."""
    body = re.sub(r"\s+", " ", raw_body).strip()
    if not body:
        return None
    folded = body.casefold()

    if any(term in folded for term in EXCLUDED_BODY_TERMS):
        return None

    if folded in {"kommunstyrelse", "kommunstyrelsen"}:
        return "Kommunstyrelsen"
    if folded in {"regionstyrelse", "regionstyrelsen"}:
        return "Regionstyrelsen"

    # Riktiga nämnder kan heta både "Socialnämnden" och exempelvis
    # "Nämnden för arbete och välfärd". Därför kräver vi nämnd i namnet, men
    # exkluderar ovan alla underutskott och andra irrelevanta konstruktioner.
    if "nämnd" not in folded:
        return None

    # Nämnd -> Nämnden ger en enkel gemensam form för vanliga singularvarianter.
    if folded.endswith("nämnd"):
        body += "en"

    # Troman innehåller ibland versala listnamn. Normalisera dem utan att röra
    # normal svensk versalisering i övriga namn.
    if body.isupper():
        body = body.capitalize()
    return body


def bodies(page_html: str) -> list[str]:
    match = re.search(r'id="engagementTable:tbody_element"(.*?)</table>', page_html, re.S | re.I)
    if not match:
        match = re.search(r'<table[^>]*id="engagementTable"[^>]*>(.*?)</table>', page_html, re.S | re.I)
    if not match:
        return []
    found: list[str] = []
    seen: set[str] = set()
    for row in re.finditer(r"<tr[^>]*>(.*?)</tr>", match.group(1), re.S | re.I):
        cells = re.findall(r"<td[^>]*>(.*?)</td>", row.group(1), re.S | re.I)
        if not cells:
            continue
        body = normalize_body(clean_text(cells[0]))
        if not body:
            continue
        key = body.casefold()
        if key not in seen:
            seen.add(key)
            found.append(body)
    return found


def wrangler_args() -> list[str]:
    return [
        "npx", "wrangler", "d1", "execute", D1_NAME,
        "--remote", "--config", str(WRANGLER_CONFIG),
    ]


def wrangler_json(sql: str) -> object:
    proc = subprocess.run(
        wrangler_args() + ["--command", sql, "--json"],
        cwd=REPO_ROOT,
        text=True,
        capture_output=True,
    )
    if proc.returncode != 0:
        if proc.stdout:
            print(proc.stdout, file=sys.stderr)
        if proc.stderr:
            print(proc.stderr, file=sys.stderr)
        sys.exit("FEL: kunde inte läsa D1 via Wrangler.")
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError:
        print(proc.stdout, file=sys.stderr)
        sys.exit("FEL: Wrangler returnerade inte giltig JSON.")


def find_result_rows(value: object) -> list[dict]:
    """Hitta Wranglers SELECT-rader utan att låsa oss till en viss CLI-version."""
    if isinstance(value, dict):
        results = value.get("results")
        if isinstance(results, list) and (not results or isinstance(results[0], dict)):
            return results
        for child in value.values():
            rows = find_result_rows(child)
            if rows:
                return rows
    elif isinstance(value, list):
        for child in value:
            rows = find_result_rows(child)
            if rows:
                return rows
    return []


def load_politician_index() -> dict[tuple[str, str], str]:
    print("Läser befintliga politiker från D1 via Wrangler...", flush=True)
    payload = wrangler_json(
        "SELECT id, lower(trim(email)) AS email, area_name FROM public_contacts "
        "WHERE email IS NOT NULL AND trim(email) <> '';"
    )
    rows = find_result_rows(payload)
    if not rows:
        sys.exit("FEL: kunde inte läsa några politiker från D1.")
    index: dict[tuple[str, str], str] = {}
    for row in rows:
        pid = str(row.get("id") or "").strip()
        email = str(row.get("email") or "").strip().lower()
        area = str(row.get("area_name") or "").strip()
        if pid and email and area:
            index[(area, email)] = pid
    print(f"  {len(index)} D1-rader indexerade.", flush=True)
    return index


def sql_quote(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def save_cache(changes: dict[str, tuple[str, set[str]]], now_ms: int) -> None:
    payload = {
        "created_at_ms": now_ms,
        "changes": {
            pid: {"area_name": area, "bodies": sorted(person_bodies, key=str.casefold)}
            for pid, (area, person_bodies) in changes.items()
        },
    }
    CACHE_PATH.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    print(f"Skrapresultatet cachelagrat i {CACHE_PATH}.", flush=True)


def load_cache() -> tuple[dict[str, tuple[str, set[str]]], int] | None:
    if not CACHE_PATH.exists():
        return None
    try:
        payload = json.loads(CACHE_PATH.read_text(encoding="utf-8"))
        raw_changes = payload.get("changes", {})
        changes = {
            str(pid): (str(item["area_name"]), set(map(str, item.get("bodies", []))))
            for pid, item in raw_changes.items()
            if item.get("area_name") and item.get("bodies")
        }
        now_ms = int(payload.get("created_at_ms") or int(time.time() * 1000))
    except (OSError, ValueError, TypeError, KeyError, json.JSONDecodeError):
        return None
    if not changes:
        return None
    return changes, now_ms


def write_batch(batch: list[tuple[str, tuple[str, set[str]]]], now_ms: int, number: int, total: int) -> None:
    # D1:s remote execute tillåter inte BEGIN TRANSACTION/SAVEPOINT i SQL-filer.
    # Varje politiker är ändå idempotent: DELETE följt av INSERT OR IGNORE. Om en
    # batch avbryts kan cachen köras om säkert; samma politiker byggs då om igen.
    statements: list[str] = []
    body_count = 0
    for contact_id, (area_name, person_bodies) in batch:
        statements.append(
            "DELETE FROM public_contact_assignments "
            f"WHERE contact_id = {sql_quote(contact_id)} AND source = 'troman';"
        )
        for body in sorted(person_bodies, key=str.casefold):
            # Schema 002 har role TEXT NOT NULL DEFAULT ''. Vi sparar ingen
            # detaljroll, men måste därför skriva tom sträng (inte NULL).
            statements.append(
                "INSERT OR IGNORE INTO public_contact_assignments "
                "(contact_id, area_name, body, role, source, last_scraped_at) VALUES ("
                f"{sql_quote(contact_id)}, {sql_quote(area_name)}, {sql_quote(body)}, "
                f"'', 'troman', {now_ms});"
            )
            body_count += 1

    tmp_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", suffix=".sql", prefix="quill-assignments-", delete=False
        ) as tmp:
            tmp.write("\n".join(statements) + "\n")
            tmp_path = Path(tmp.name)
        print(
            f"Batch {number}/{total}: {len(batch)} politiker, {body_count} nämnd/organ-kopplingar...",
            flush=True,
        )
        proc = subprocess.run(
            wrangler_args() + ["--file", str(tmp_path), "--yes"],
            cwd=REPO_ROOT,
        )
        if proc.returncode != 0:
            sys.exit(
                f"FEL: D1-skrivning misslyckades i batch {number}/{total}. "
                f"Cachen finns kvar i {CACHE_PATH}; kör skriptet igen för att försöka igen."
            )
    finally:
        if tmp_path is not None:
            tmp_path.unlink(missing_ok=True)


def verify_assignments(expected_people: int, expected_bodies: int, now_ms: int) -> None:
    payload = wrangler_json(
        "SELECT COUNT(*) AS assignments, COUNT(DISTINCT contact_id) AS public_contacts "
        "FROM public_contact_assignments "
        f"WHERE source = 'troman' AND last_scraped_at = {now_ms};"
    )
    rows = find_result_rows(payload)
    if not rows:
        sys.exit(
            f"FEL: kunde inte verifiera D1 efter skrivningen. Cachen finns kvar i {CACHE_PATH}."
        )
    actual_bodies = int(rows[0].get("assignments") or 0)
    actual_people = int(rows[0].get("public_contacts") or 0)
    print(
        f"Efterkontroll D1: {actual_people} politiker, {actual_bodies} nämnd/organ-kopplingar.",
        flush=True,
    )
    if actual_people != expected_people or actual_bodies != expected_bodies:
        sys.exit(
            "FEL: D1-efterkontrollen matchar inte skrapresultatet: "
            f"förväntade {expected_people} politiker/{expected_bodies} kopplingar, "
            f"fick {actual_people}/{actual_bodies}. Cachen lämnas kvar i {CACHE_PATH}."
        )


def write_assignments(changes: dict[str, tuple[str, set[str]]], now_ms: int) -> None:
    if not changes:
        print("Inga nämnd/organ-kopplingar att skriva.", flush=True)
        return
    items = sorted(changes.items(), key=lambda item: (item[1][0].casefold(), item[0]))
    batches = [items[i:i + BATCH_PEOPLE] for i in range(0, len(items), BATCH_PEOPLE)]
    total_bodies = sum(len(v[1]) for v in changes.values())
    print(
        f"Skriver {total_bodies} nämnd/organ-kopplingar för {len(items)} politiker "
        f"i {len(batches)} mindre D1-batchar...",
        flush=True,
    )
    for number, batch in enumerate(batches, 1):
        write_batch(batch, now_ms, number, len(batches))
    verify_assignments(len(items), total_bodies, now_ms)
    CACHE_PATH.unlink(missing_ok=True)
    print("Alla D1-batchar verifierade; backfill-cachen borttagen.", flush=True)


def scrape_changes() -> tuple[dict[str, tuple[str, set[str]]], int, int, int, int]:
    politician_index = load_politician_index()
    targets = [row for row in load_regioner() if row.get("typ") == "troman"]
    now_ms = int(time.time() * 1000)
    total_people = total_bodies = total_missing = 0
    changes: dict[str, tuple[str, set[str]]] = {}

    print(f"{len(targets)} Troman-kommuner/regioner att läsa.", flush=True)
    for index, region in enumerate(targets, 1):
        area_name = region["namn"]
        print(f"[{index}/{len(targets)}] {area_name}...", flush=True)
        listing = fetch(region["url"])
        if not listing:
            continue
        base = re.match(r"(https?://[^/]+)", region["url"])
        if not base:
            continue
        person_paths = sorted(set(re.findall(r'href="(/person/[a-f0-9-]+)"', listing, re.I)))
        area_bodies = area_missing = 0
        for person_path in person_paths:
            page = fetch(urljoin(base.group(1), person_path), timeout=20)
            if not page:
                continue
            person_bodies = bodies(page)
            emails = email_from_page(page)
            if not person_bodies or not emails:
                continue

            contact_id = None
            for email in emails:
                contact_id = politician_index.get((area_name, email))
                if contact_id:
                    break
            if not contact_id:
                area_missing += 1
                continue

            previous = changes.get(contact_id)
            body_set = set(person_bodies)
            if previous:
                body_set.update(previous[1])
            changes[contact_id] = (area_name, body_set)
            area_bodies += len(person_bodies)
            total_people += 1
            time.sleep(0.05)

        total_bodies += area_bodies
        total_missing += area_missing
        print(
            f"  {area_bodies} relevanta nämnd/organ-kopplingar hittade, "
            f"{area_missing} profiler utan D1-match",
            flush=True,
        )

    save_cache(changes, now_ms)
    return changes, now_ms, total_people, total_bodies, total_missing


def main() -> None:
    cached = load_cache()
    if cached:
        changes, now_ms = cached
        total_people = len(changes)
        total_bodies = sum(len(v[1]) for v in changes.values())
        total_missing = 0
        print(
            f"Återanvänder cache från {CACHE_PATH}: {total_people} politiker, "
            f"{total_bodies} nämnd/organ-kopplingar. Ingen omskrapning behövs.",
            flush=True,
        )
    else:
        changes, now_ms, total_people, total_bodies, total_missing = scrape_changes()

    write_assignments(changes, now_ms)
    print(
        f"\nKlart: {total_people} personer, {total_bodies} relevanta nämnd/organ-kopplingar, "
        f"{total_missing} profiler utan D1-match.",
        flush=True,
    )


if __name__ == "__main__":
    main()
