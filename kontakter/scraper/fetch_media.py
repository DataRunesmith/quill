#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Synkar redaktionella kontaktvägar för nyhetsorganisationer.

Vilka redaktioner, sidor och fasta funktionsadresser som används står i
media.json i källkatalogen (se sources.py); koden innehåller inga adresser.

Princip:
- area_type='media' ger en egen huvudkategori i appen.
- area_name är mediehuset.
- role skiljer Nyhetsredaktion, Politik, Granskning, Ledare/opinion m.m.
- Officiella funktionsadresser prioriteras ("contacts" i media.json).
- Om en viktig avdelning saknar funktionsadress hämtas offentligt publicerade
  yrkesadresser från mediehusets egna aktuella sidor när det går.
- Inga adresser gissas från namn om inte mediehuset självt uttryckligen publicerar
  ett adressmönster för just den redaktionen.

Funktionsadresserna är fallback, så en layoutändring på en sida inte raderar en
hel redaktion ur databasen.
"""
from __future__ import annotations

import html
import os
import re
import sys
import time
from dataclasses import dataclass
from urllib.parse import urljoin, urlparse

import requests

import sources
from d1 import D1Client

UA = {"User-Agent": os.environ.get("SCRAPER_USER_AGENT", "quill-contact-refresh/1.0")}
EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
HREF_RE = re.compile(r'href=["\']([^"\']+)["\']', re.I)
NON_EDITORIAL_LOCALS = {"kundservice"}
PLACEHOLDER_LOCAL_RE = re.compile(r"(?:^|[._-])(?:f[oö]rnamn|rnamn)[._-]+efternamn(?:$|[._-])", re.I)


@dataclass(frozen=True)
class Contact:
    name: str
    email: str
    organisation: str
    role: str
    source: str


UPSERT_SQL = (
    "INSERT INTO public_contacts (id, name, email, area_name, area_type, party, role, last_scraped_at) "
    "VALUES (lower(hex(randomblob(11))), ?, ?, ?, 'media', NULL, ?, ?) "
    "ON CONFLICT(email, area_name) DO UPDATE SET name=excluded.name, role=excluded.role, "
    "last_scraped_at=excluded.last_scraped_at"
)


def fetch_html(url: str) -> str:
    r = requests.get(url, headers=UA, timeout=30)
    r.raise_for_status()
    return r.text


def visible_text(raw_html: str) -> str:
    return html.unescape(re.sub(r"<[^>]+>", "\n", raw_html))


def display_name_from_email(email: str) -> str:
    local = email.split("@", 1)[0]
    if "." not in local:
        return email
    return " ".join(part.replace("-", "-").capitalize() for part in local.split("."))


def is_editorial_email(email: str) -> bool:
    local = email.strip().lower().split("@", 1)[0]
    return local not in NON_EDITORIAL_LOCALS and not PLACEHOLDER_LOCAL_RE.search(local)


def scrape_staff_page(url: str, organisation: str, role: str, domain: str) -> list[Contact]:
    """En personalsida där varje adress föregås av namn och befattning."""
    try:
        text = visible_text(fetch_html(url))
    except Exception as exc:
        print(f"VARNING: kunde inte läsa {url}: {exc}", file=sys.stderr)
        return []
    lines = [re.sub(r"\s+", " ", x).strip() for x in text.splitlines() if x.strip()]
    rows: list[Contact] = []
    for i, line in enumerate(lines):
        m = EMAIL_RE.search(line)
        if not m or not m.group(0).lower().endswith("@" + domain):
            continue
        email = m.group(0).lower()
        context = " ".join(lines[max(0, i - 1): i + 1])
        before = context.split(email, 1)[0].strip(" ,-:")
        role_match = re.search(
            r"\b(ansvarig utgivare|programredaktör|planeringsredaktör|publiceringsredaktör|"
            r"nyhetsredaktör|redaktör och researcher|redaktör|reporter|programredigerare)\b",
            before,
            re.I,
        )
        if not role_match:
            continue
        name = before[:role_match.start()].strip(" ,-:").split("Foto:")[-1].strip()
        title = role_match.group(1).strip().capitalize()
        if 2 <= len(name.split()) <= 5:
            rows.append(Contact(name, email, organisation, f"{role} ({title})", url))
    return rows


def scrape_public_emails(
    url: str, organisation: str, role: str, domain: str, skip_locals: tuple[str, ...] = ()
) -> list[Contact]:
    try:
        text = visible_text(fetch_html(url))
    except Exception as exc:
        print(f"VARNING: kunde inte läsa {url}: {exc}", file=sys.stderr)
        return []
    rows = []
    for email in sorted({m.group(0).lower() for m in EMAIL_RE.finditer(text)}):
        if not email.endswith("@" + domain) or not is_editorial_email(email):
            continue
        if email.split("@", 1)[0] in skip_locals:
            continue
        rows.append(Contact(display_name_from_email(email), email, organisation, role, url))
    return rows


def scrape_recent_section_authors(section_url: str, organisation: str, role: str, domain: str, max_articles: int = 20) -> list[Contact]:
    try:
        page = fetch_html(section_url)
    except Exception as exc:
        print(f"VARNING: kunde inte läsa sektion {section_url}: {exc}", file=sys.stderr)
        return []
    host = urlparse(section_url).netloc
    links: list[str] = []
    seen: set[str] = set()
    for href in HREF_RE.findall(page):
        url = urljoin(section_url, html.unescape(href))
        parsed = urlparse(url)
        if parsed.netloc != host or url in seen or url == section_url:
            continue
        seen.add(url)
        links.append(url)
        if len(links) >= max_articles:
            break
    rows: list[Contact] = []
    for url in links:
        try:
            raw = fetch_html(url)
        except Exception:
            continue
        for email in sorted({m.group(0).lower() for m in EMAIL_RE.finditer(visible_text(raw))}):
            if email.endswith("@" + domain) and is_editorial_email(email):
                rows.append(Contact(display_name_from_email(email), email, organisation, role, url))
    return rows


def dedupe(rows: list[Contact]) -> list[Contact]:
    priority = {"Politik": 6, "Granskning": 5, "Ledare/opinion": 4, "Redaktionsledning": 3, "Nyhetsredaktion": 2, "Nyhetstips": 1}
    out: dict[tuple[str, str], Contact] = {}
    for c in rows:
        key = (c.email.lower(), c.organisation)
        current = out.get(key)
        score = max((v for k, v in priority.items() if k in c.role), default=0)
        current_score = max((v for k, v in priority.items() if current and k in current.role), default=0)
        if current is None or score > current_score:
            out[key] = c
    return sorted(out.values(), key=lambda c: (c.organisation, c.role, c.name))


def main() -> None:
    dry_run = "--dry-run" in sys.argv
    config = sources.load("media")
    rows = [Contact(**c) for c in config.get("contacts", [])]
    for p in config.get("staff_pages", []):
        rows.extend(scrape_staff_page(p["url"], p["organisation"], p["role"], p["domain"]))
    for p in config.get("public_email_pages", []):
        rows.extend(
            scrape_public_emails(
                p["url"], p["organisation"], p["role"], p["domain"], tuple(p.get("skip_locals", ()))
            )
        )
    for p in config.get("section_authors", []):
        rows.extend(scrape_recent_section_authors(p["url"], p["organisation"], p["role"], p["domain"]))

    rows = dedupe(rows)
    print(f"Nyhetsredaktioner: {len(rows)} kontakter")
    for org in sorted({r.organisation for r in rows}):
        print(f"  {org}: {sum(r.organisation == org for r in rows)}")
    if dry_run:
        for c in rows:
            print(f"  {c.organisation:<22} {c.role:<46} {c.name} <{c.email}>")
        return

    client = D1Client()
    now_ms = int(time.time() * 1000)
    ok = fail = 0
    for c in rows:
        try:
            client.run(UPSERT_SQL, [c.name, c.email, c.organisation, c.role, now_ms])
            ok += 1
        except Exception as exc:
            print(f"FEL {c.name} <{c.email}>: {exc}", file=sys.stderr)
            fail += 1
    print(f"Synkat media till D1: {ok} ok, {fail} fel")


if __name__ == "__main__":
    main()
