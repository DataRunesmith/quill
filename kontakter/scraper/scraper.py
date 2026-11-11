#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Quiller scraper
Hämtar e-postadresser till förtroendevalda i svenska regioner.
Stöd för Netpublicator-baserade register (används av många regioner)
samt direktskrapning av mailto-länkar.
Sparar resultat som VCF-filer (en per region + en samlad).
"""

import asyncio
import csv
import ipaddress
import logging
import os
import re
import sys
import socket
import unicodedata
from io import BytesIO
from urllib.parse import unquote, urlsplit
from playwright.async_api import async_playwright, Error as PlaywrightError
from pypdf import PdfReader

import sources

from quill_common import (
    normalize_party,
    party_from_parens as _extract_party_from_parens,
    party_anywhere as _extract_party_anywhere,
)

LOG_DIR  = os.environ.get("LOG_DIR",    "/logs")
OUT_DIR  = os.environ.get("OUTPUT_DIR", "/output")
os.makedirs(LOG_DIR, exist_ok=True)
os.makedirs(OUT_DIR,  exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    handlers=[
        logging.FileHandler(f"{LOG_DIR}/scraper.log", encoding="utf-8"),
        logging.StreamHandler(sys.stdout),
    ],
)
log = logging.getLogger(__name__)

EMAIL_RE = re.compile(r"[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}")

# Skräpadresser att filtrera bort
SKIP_KEYWORDS = ["noreply", "no-reply", "webmaster", "webb@", "support@", "info@region", "hjalp@"]



def is_valid_email(email: str) -> bool:
    email = email.lower()
    if not EMAIL_RE.fullmatch(email):
        return False
    return not any(kw in email for kw in SKIP_KEYWORDS)


def is_safe_network_url(url: str) -> bool:
    """Block non-web schemes and private/local destinations before Chromium fetches them."""
    try:
        parsed = urlsplit(url)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            return False
        if parsed.username is not None or parsed.password is not None:
            return False
        host = parsed.hostname.rstrip(".").lower()
        if host in {"localhost", "metadata", "metadata.google.internal", "host.docker.internal"}:
            return False
        if host.endswith((".localhost", ".local", ".internal", ".cluster.local", ".svc", ".test", ".invalid")):
            return False
        try:
            port = parsed.port
        except ValueError:
            return False
        if port is not None and port not in {80, 443}:
            return False
        try:
            address = ipaddress.ip_address(host)
        except ValueError:
            try:
                # inet_aton also recognizes legacy decimal/octal/hex IPv4 forms.
                address = ipaddress.ip_address(socket.inet_aton(host))
            except OSError:
                address = None
        return address is None or address.is_global
    except (TypeError, ValueError):
        return False


def trusted_profile_hosts(source_url: str) -> set[str]:
    parsed = urlsplit(source_url)
    if parsed.scheme != "https" or not parsed.hostname or not is_safe_network_url(source_url):
        raise ValueError(f"Unsafe source URL: {source_url}")
    host = parsed.hostname.rstrip(".").lower()
    base = host[4:] if host.startswith("www.") else host
    return {base, f"www.{base}"}


def is_trusted_profile_url(url: str, allowed_hosts: set[str]) -> bool:
    if not is_safe_network_url(url):
        return False
    host = urlsplit(url).hostname
    return bool(host and host.rstrip(".").lower() in allowed_hosts)


async def block_private_network_requests(route, request):
    if is_safe_network_url(request.url):
        await route.continue_()
    else:
        await route.abort()


def email_from_mailto_href(href: str) -> str:
    """Plockar ut e-postadressen ur en mailto-href, t.ex. 'mailto:%20a@b.example?subject=x'.
    unquote() krävs eftersom browsern url-kodar källans whitespace (t.ex. ett
    inledande blanksteg blir %20) innan strip() annars hade kunnat ta bort den."""
    return unquote(href.replace("mailto:", "")).split("?")[0].strip().lower()


NAME_CANDIDATE_RE = re.compile(
    r"[A-ZÅÄÖ][\wÅÄÖåäö´'`.\-]+(?:\s[A-ZÅÄÖ][\wÅÄÖåäö´'`.\-]+){1,3}"
)


def _looks_like_name(s: str) -> bool:
    s = s.strip()
    if not s or "@" in s or len(s) > 60:
        return False
    return bool(re.fullmatch(NAME_CANDIDATE_RE.pattern, s))


async def extract_person_name(page) -> tuple[str, str | None]:
    """Bästa-försök att hitta personens namn (och, om det visas i samma
    rubrik/titel, parti) på en profilsida: provar först <h1>, sedan sidans
    <title> (med vanliga suffix som ' - Kommunnamn' eller ' | Kommunnamn'
    bortklippta). Returnerar tom sträng för namnet om inget ser ut som ett
    namn, så att e-posten ändå behålls utan namnkoppling."""
    try:
        h1 = await page.query_selector("h1")
        if h1:
            text = re.sub(r"\s+", " ", (await h1.inner_text())).strip()
            # Många sidor visar namnet som "Förnamn Efternamn (Parti)" - partiet
            # ska bort innan vi avgör om resten ser ut som ett namn.
            party = _extract_party_from_parens(text)
            name_only = re.sub(r"\s*\([^)]*\)\s*$", "", text).strip()
            if _looks_like_name(name_only):
                return name_only, party
    except PlaywrightError:
        # <h1> saknas, är borttagen ur DOM:en, eller sidan hann navigera om.
        # Nästa strategi (sidans <title>) får försöka i stället.
        pass
    try:
        title = await page.title()
    except PlaywrightError:
        title = ""
    if title:
        candidate = re.split(r"\s*[-|–]\s*", title)[0].strip()
        party = _extract_party_from_parens(candidate)
        name_only = re.sub(r"\s*\([^)]*\)\s*$", "", candidate).strip()
        if _looks_like_name(name_only):
            return name_only, party
    return "", None


def swedish_key(name: str):
    """Sorteringsnyckel för svensk alfabetisk ordning utan att förlita sig på
    OS-locale (å/ä/ö ska sorteras efter z, i den ordningen)."""
    s = name.lower()
    return s.replace("å", "{").replace("ä", "|").replace("ö", "}")


async def accept_cookies(page):
    # Exakt textmatch (:text-is) före substringmatch (:has-text) — annars
    # riskerar t.ex. "Accept" att träffa en "Accept marketing cookies"-knapp
    # istället för "godkänn alla". Först den mest specifika formuleringen.
    for text in ["Acceptera alla", "Acceptera", "Jag förstår", "Accept all", "Accept", "Godkänn"]:
        for selector in (f"button:text-is('{text}')", f"button:has-text('{text}')"):
            try:
                btn = await page.query_selector(selector)
                if btn and await btn.is_visible():
                    await btn.click()
                    await asyncio.sleep(1)
                    return
            except PlaywrightError:
                # Selektorn matchade inget, eller knappen försvann mellan
                # is_visible() och click(). Sidan har oftast ingen
                # cookiebanner alls — nästa formulering i listan får försöka.
                pass


async def expand_collapsibles(page, only_text=None):
    """Fäller ut hopfällda accordion-sektioner (Sitevisions env-collapse-header,
    jQuery UI:s ui-accordion-header m.fl.), vars innehåll annars inte syns i
    page.inner_text(). Klickar generiskt på alla element som annonserar sig som
    hopfällda via det vanliga ARIA-attributet aria-expanded="false".
    Om only_text anges klickas bara rubriker vars text innehåller den strängen,
    vilket behövs för "exklusiva" accordions (jQuery UI) där en öppning stänger
    alla andra sektioner igen."""
    for _ in range(10):
        headers = await page.query_selector_all('[aria-expanded="false"]')
        if only_text:
            filtered = []
            for header in headers:
                content = await header.text_content()
                if content and only_text in content:
                    filtered.append(header)
            headers = filtered
        if not headers:
            break
        progress = False
        for header in headers:
            try:
                await header.click(timeout=2000)
                progress = True
            except PlaywrightError:
                # En rubrik som inte går att klicka (överlappad, borttagen,
                # timeout) ska inte stoppa de övriga i varvet. `progress`
                # avgör om varvet gav något alls — blev inget utfällt bryter
                # loopen nedan.
                pass
        if not progress:
            break
        await asyncio.sleep(0.3)


async def mailto_people(page, person_name="", party=None, role=None):
    """Samlar alla giltiga mailto-adresser på sidan som person-tupler."""
    hrefs = await page.eval_on_selector_all(
        "a[href^='mailto:']",
        "els => els.map(e => e.href)"
    )
    people = set()
    for href in hrefs:
        email = email_from_mailto_href(href)
        if is_valid_email(email):
            people.add((person_name, email, party, role))
    return people


async def visit_profiles(context, urls, extract, *, allowed_hosts, wait_until="domcontentloaded", settle=0.5, pause=0.3):
    """Gemensamt skelett för alla profilside-skrapare: öppnar varje URL i en
    egen flik, väntar in sidan, och samlar person-tuplerna som
    extract(page, url) returnerar. En sida som felar hoppas över tyst —
    en trasig profilsida ska inte stoppa resten av kommunen.

    settle = extra sekunder efter sidladdning (JS-rendering), pause = paus
    mellan sidorna (god nätgranne)."""
    people = set()
    for url in urls:
        if not is_trusted_profile_url(url, allowed_hosts):
            log.warning("Skipping profile URL outside the source host allowlist")
            continue
        page = await context.new_page()
        try:
            await page.goto(url, timeout=30000, wait_until=wait_until)
            await asyncio.sleep(settle)
            people.update(await extract(page, url))
        except PlaywrightError:
            # Medvetet: en trasig profilsida (timeout, 404, JS-krasch) ska
            # inte stoppa resten av kommunen — se funktionens docstring.
            # Sidan stängs i finally oavsett.
            pass
        finally:
            await page.close()
        await asyncio.sleep(pause)
    return people


async def scrape_netpublicator(context, namn, registry_id, board_id):
    """Hämtar ledamöternas profilsidor från Netpublicator och plockar e-post."""
    people = set()
    board_url = (
        f"https://www.netpublicator.com/elected/registry/{registry_id}"
        f"/board/{board_id}"
    )
    page = await context.new_page()
    try:
        log.info(f"{namn}: hämtar ledamötslista {board_url}")
        await page.goto(board_url, timeout=60000, wait_until="domcontentloaded")
        await asyncio.sleep(2)

        # Plocka rollen+partiet direkt ur listningstabellen (egna kolumner
        # per rad) — slipper en extra sidvisning per person för det.
        rows = await page.eval_on_selector_all(
            "table tbody tr",
            r"""els => els.map(tr => {
                const link = tr.querySelector("a[href*='/politician/']");
                if (!link) return null;
                const tds = tr.querySelectorAll('td');
                // Rollcellen är ett vanligt textfält utan nästlad länk (till
                // skillnad från namn/parti-cellerna som har <a>-taggar), och
                // kolumnordningen varierar mellan kommuner — ett fast index
                // träffar fel (t.ex. efternamn) på vissa. Hoppa även över rent
                // numeriska celler (platsnummer). Samma beprövade logik som i
                // backfill_kommun_role_party.py.
                let role = null;
                for (const td of tds) {
                    if (td.querySelector('a')) continue;
                    const text = td.textContent.trim();
                    if (text && !/^\d+$/.test(text)) { role = text; break; }
                }
                let party = null;
                if (tds.length >= 4) {
                    const partyLink = tds[3].querySelector('a[title]');
                    party = partyLink ? partyLink.getAttribute('title') : (tds[3].getAttribute('data-sort-value') || null);
                }
                if (!party) {
                    // Vissa kommuner (t.ex. Orsa) visar partiet enbart som en
                    // logotyp-bild — namnet ligger då i img-taggens title.
                    const img = tr.querySelector('img[title]');
                    party = img ? img.getAttribute('title') : null;
                }
                return [link.href, role, party];
            }).filter(Boolean)""",
        )
        info_by_url: dict[str, tuple[str | None, str | None]] = {
            url: (role or None, normalize_party(party)) for url, role, party in rows
        }
        log.info(f"{namn}: {len(info_by_url)} profilsidor hittade")

        async def extract(p2, url):
            role, party = info_by_url.get(url, (None, None))
            person_name, party_from_page = await extract_person_name(p2)
            return await mailto_people(p2, person_name, party or party_from_page, role)

        people = await visit_profiles(context, list(info_by_url), extract, allowed_hosts=trusted_profile_hosts(board_url))

    except PlaywrightError as e:
        log.error(f"{namn}: {e}")
    finally:
        await page.close()

    log.info(f"{namn}: {len(people)} adresser funna")
    return people


async def extract_troman_role(page) -> str | None:
    """Plockar befattning (Ledamot/Ordförande/Ersättare m.m.) ur Uppdrag-
    tabellen på en Troman-profilsida — raden vars Organisation-kolumn
    innehåller 'fullmäktige', eftersom en person kan ha flera uppdrag
    (t.ex. ersättare i styrelsen men ordförande i fullmäktige)."""
    try:
        rows = await page.eval_on_selector_all(
            "#engagementTable tbody tr",
            """els => els.map(tr => {
                const tds = tr.querySelectorAll('td');
                return tds.length >= 2 ? [tds[0].textContent.trim(), tds[1].textContent.trim()] : null;
            }).filter(Boolean)""",
        )
        for org, role in rows:
            if "fullmäktige" in org.lower():
                return role or None
        if rows:
            return rows[0][1] or None
    except PlaywrightError:
        # Tabellen finns inte på alla profilsidor. Utan uppdragstabell finns
        # ingen roll att hämta, och None nedan är rätt svar — inte ett fel.
        pass
    return None


async def scrape_troman(context, namn, org_url):
    """Hämtar ledamöternas profilsidor från Troman (tromanpublik.se) och plockar e-post."""
    people = set()
    page = await context.new_page()
    try:
        log.info(f"{namn}: hämtar ledamötslista {org_url}")
        await page.goto(org_url, timeout=60000, wait_until="domcontentloaded")
        await asyncio.sleep(2)

        hrefs = await page.eval_on_selector_all(
            "a[href*='/person/']",
            "els => els.map(e => e.href)"
        )
        person_urls = list(set(hrefs))
        log.info(f"{namn}: {len(person_urls)} profilsidor hittade")

        async def extract(p2, url):
            person_name, party = await extract_person_name(p2)
            role = await extract_troman_role(p2)
            return await mailto_people(p2, person_name, party, role)

        people = await visit_profiles(context, person_urls, extract, allowed_hosts=trusted_profile_hosts(org_url))

    except PlaywrightError as e:
        log.error(f"{namn}: {e}")
    finally:
        await page.close()

    log.info(f"{namn}: {len(people)} adresser funna")
    return people


async def scrape_w3d3(context, namn, board_url):
    """Hämtar ledamöternas profilsidor från W3D3 Ledamotspublicering (Formpipe) och
    plockar e-post. E-postadressen visas som vanlig text (#MainPagePlaceholder_Email),
    inte som en mailto-länk, och ledamotslistan kan vara sidindelad via en
    postback-knapp (#MainPagePlaceholder_NextLink)."""
    people = set()
    page = await context.new_page()
    try:
        log.info(f"{namn}: hämtar ledamötslista {board_url}")
        await page.goto(board_url, timeout=60000, wait_until="domcontentloaded")
        await asyncio.sleep(2)

        person_urls = set()
        while True:
            hrefs = await page.eval_on_selector_all(
                "a[href*='RepresentativeDetails.aspx']",
                "els => els.map(e => e.href)"
            )
            person_urls.update(hrefs)

            next_btn = await page.query_selector("#MainPagePlaceholder_NextLink")
            if not next_btn:
                break
            disabled = await next_btn.get_attribute("aria-disabled")
            if disabled == "true":
                break
            await next_btn.click()
            await page.wait_for_load_state("domcontentloaded")
            await asyncio.sleep(1)

        log.info(f"{namn}: {len(person_urls)} profilsidor hittade")

        async def extract(p2, url):
            email_el = await p2.query_selector("#MainPagePlaceholder_Email")
            if not email_el:
                return set()
            email = (await email_el.inner_text()).strip().lower()
            if not is_valid_email(email):
                return set()
            person_name, party = await extract_person_name(p2)
            return {(person_name, email, party, None)}

        people = await visit_profiles(context, person_urls, extract, allowed_hosts=trusted_profile_hosts(board_url), settle=0.3)

    except PlaywrightError as e:
        log.error(f"{namn}: {e}")
    finally:
        await page.close()

    log.info(f"{namn}: {len(people)} adresser funna")
    return people


async def scrape_fmr(context, namn, board_url):
    """Hämtar ledamöternas profilsidor från ett Förtroendemannaregister av
    Livewire-typ (t.ex. Alingsås). Ledamotslistan på beslutsinstans-sidan
    renderas av Livewire efter sidladdning (tom i ren HTML), så vi väntar
    in nätverket innan vi läser ut profillänkarna."""
    people = set()
    page = await context.new_page()
    try:
        log.info(f"{namn}: hämtar ledamötslista {board_url}")
        await page.goto(board_url, timeout=60000, wait_until="networkidle")
        await asyncio.sleep(2)

        person_urls = set(await page.eval_on_selector_all(
            "a[href*='/personer/']",
            "els => els.map(e => e.href)"
        ))
        log.info(f"{namn}: {len(person_urls)} profilsidor hittade")

        async def extract(p2, url):
            person_name, party = await extract_person_name(p2)
            return await mailto_people(p2, person_name, party)

        people = await visit_profiles(context, person_urls, extract, allowed_hosts=trusted_profile_hosts(board_url), wait_until="networkidle", settle=0.3)

    except PlaywrightError as e:
        log.error(f"{namn}: {e}")
    finally:
        await page.close()

    log.info(f"{namn}: {len(people)} adresser funna")
    return people


async def scrape_profilsidor(context, namn, url, link_pattern, domain):
    """Hämtar en kommunfullmäktigesida med länkar till enskilda ledamöters
    profilsidor (href innehåller link_pattern) och plockar mailto-länkar med
    angiven domän. Generiska adresser (växel, sidansvarig, CMS-leverantör)
    sorteras bort eftersom de annars dyker upp identiskt på varje profilsida."""
    SKIP_LOCAL = {"info", "e-postinfo", "kommun", "kommunen", "kommunstyrelsen", "kommunfullmaktige"}
    people = set()

    async def collect(p, person_name="", party=None):
        found = await mailto_people(p, person_name, party)
        return {
            (n, e, pa, r) for n, e, pa, r in found
            if e.endswith(f"@{domain}") and e.split("@")[0] not in SKIP_LOCAL
        }

    page = await context.new_page()
    try:
        log.info(f"{namn}: hämtar ledamötslista {url}")
        await page.goto(url, timeout=60000, wait_until="domcontentloaded")
        await asyncio.sleep(1)
        await accept_cookies(page)

        person_urls = set(await page.eval_on_selector_all(
            f"a[href*='{link_pattern}']",
            "els => els.map(e => e.href)"
        ))
        log.info(f"{namn}: {len(person_urls)} profilsidor hittade")

        people.update(await collect(page))

        async def extract(p2, purl):
            person_name, party = await extract_person_name(p2)
            return await collect(p2, person_name, party)

        people.update(await visit_profiles(context, person_urls, extract, allowed_hosts=trusted_profile_hosts(url), settle=0.2, pause=0.2))

    except PlaywrightError as e:
        log.error(f"{namn}: {e}")
    finally:
        await page.close()

    log.info(f"{namn}: {len(people)} adresser funna")
    return people


def _email_local_part(namn_del):
    """Translittererar ett namn till en e-postlokaldel (å/ä/ö, versaler, accenter bort)."""
    s = namn_del.strip().lower()
    s = (s.replace("å", "a").replace("ä", "a").replace("ö", "o")
           .replace("é", "e").replace("ü", "u").replace("ø", "o"))
    s = re.sub(r"[´’'`]", "", s)
    s = re.sub(r"[^a-z0-9\-]", "", s)
    return s


NAMNMONSTER_RE = re.compile(
    r"([A-ZÅÄÖ][\wÅÄÖåäö´’\.\- ]*?)\s*\(([A-ZÖa-zö\-]{1,10})\)"
)

# Uppdragstitlar som ibland står inne i namnfältet före parentesen, t.ex.
# "Roland Kemppainen Ordförande (FS)" - ska inte tolkas som efternamn.
NAMNMONSTER_TITEL_RE = re.compile(
    r"\b(förste|andra|1:e|2:e)?\s*vice\s*ordförande\b|\b(ordförande|vordf)\b",
    re.IGNORECASE,
)


async def scrape_namnmonster(context, namn, url, domain, section_start, section_end=None, expand_text=None):
    """Hämtar en sida som listar namngivna ledamöter (format "Förnamn Efternamn (Parti)")
    där kommunen själv anger att e-postadressen följer mönstret fornamn.efternamn@domän,
    utan enskilda mailto-länkar. Bygger adresserna utifrån namnen i texten som ligger
    mellan section_start och section_end (om angivet, annars till sidans slut)."""
    people = set()
    page = await context.new_page()
    try:
        log.info(f"{namn}: hämtar {url}")
        await page.goto(url, timeout=60000, wait_until="domcontentloaded")
        await asyncio.sleep(1)
        await accept_cookies(page)
        await expand_collapsibles(page, only_text=expand_text)

        text = unicodedata.normalize("NFC", await page.inner_text("body"))
        start_idx = text.find(section_start)
        if start_idx == -1:
            log.warning(f"{namn}: hittade inte section_start i sidan")
            return people
        start_idx += len(section_start)
        end_idx = text.find(section_end, start_idx) if section_end else -1
        section = text[start_idx:end_idx if end_idx != -1 else None]

        for match in NAMNMONSTER_RE.finditer(section):
            full_name = match.group(1).strip()
            full_name = NAMNMONSTER_TITEL_RE.sub("", full_name).strip()
            parts = full_name.split()
            if len(parts) < 2:
                continue
            fornamn, efternamn = parts[0], parts[-1]
            # Hantera källtexter med felaktigt mellanslag i bindestrecksnamn,
            # t.ex. "Anna- Karin Exempel" som egentligen är "Anna-Karin Exempel".
            if fornamn.endswith("-") and len(parts) > 2:
                fornamn += parts[1]
            local = f"{_email_local_part(fornamn)}.{_email_local_part(efternamn)}"
            email = f"{local}@{domain}"
            if is_valid_email(email):
                people.add((full_name, email, None, None))

    except PlaywrightError as e:
        log.error(f"{namn}: {e}")
    finally:
        await page.close()

    log.info(f"{namn}: {len(people)} adresser byggda")
    return people


NAMNLISTA_SKIP = {"ordinarie ledamöter", "ordinarie", "ersättare", "vakant", "presidium"}
NAMNLISTA_RAD_RE = re.compile(
    r"^[A-ZÅÄÖ][\wÅÄÖåäö´’\.\-]*(\s[A-ZÅÄÖ][\wÅÄÖåäö´’\.\-]*){1,3}$"
)


async def scrape_namnlista(context, namn, url, domain, section_start, section_end=None, skip_lines=None):
    """Hämtar en sida som listar ledamöter som rena namnrader (utan inline-parti),
    grupperade under partirubriker, där kommunen anger att e-postadressen följer
    mönstret fornamn.efternamn@domän. skip_lines är de rader (partinamn m.m.)
    inom sektionen som inte är namn och därför ska ignoreras."""
    people = set()
    skip = NAMNLISTA_SKIP | {s.lower() for s in (skip_lines or set())}
    page = await context.new_page()
    try:
        log.info(f"{namn}: hämtar {url}")
        await page.goto(url, timeout=60000, wait_until="domcontentloaded")
        await asyncio.sleep(1)
        await accept_cookies(page)
        await expand_collapsibles(page)

        text = unicodedata.normalize("NFC", await page.inner_text("body"))
        start_idx = text.find(section_start)
        if start_idx == -1:
            log.warning(f"{namn}: hittade inte section_start i sidan")
            return people
        start_idx += len(section_start)
        end_idx = text.find(section_end, start_idx) if section_end else -1
        section = text[start_idx:end_idx if end_idx != -1 else None]

        for raw_line in section.splitlines():
            raw_stripped = raw_line.strip()
            party = _extract_party_anywhere(raw_stripped)
            line = re.sub(r"\s*\([^)]*\)\s*$", "", raw_stripped)
            # Vissa sidor skriver "Namn, Parti[, titel]" på samma rad istället för
            # "Namn (Parti)" - partiet/titeln efter första kommatecknet ska bort,
            # men spara titeln (sista kommadelen) som roll om den finns.
            line_parts = line.split(",")
            line = line_parts[0].strip()
            role = line_parts[-1].strip() if len(line_parts) > 1 else None
            if party is None and len(line_parts) > 1:
                party = normalize_party(line_parts[1].strip()) if len(line_parts) > 2 else None
            if not line or line.lower() in skip:
                continue
            if not NAMNLISTA_RAD_RE.match(line):
                continue
            parts = line.split()
            fornamn, efternamn = parts[0], parts[-1]
            if fornamn.endswith("-") and len(parts) > 2:
                fornamn += parts[1]
            local = f"{_email_local_part(fornamn)}.{_email_local_part(efternamn)}"
            email = f"{local}@{domain}"
            if is_valid_email(email):
                people.add((line, email, party, role))

    except PlaywrightError as e:
        log.error(f"{namn}: {e}")
    finally:
        await page.close()

    log.info(f"{namn}: {len(people)} adresser funna")
    return people


async def scrape_mailto(context, namn, url):
    """Skrapar mailto-länkar direkt från en sida (fallback för övriga regioner)."""
    people = set()
    page = await context.new_page()
    try:
        log.info(f"{namn}: hämtar {url}")
        await page.goto(url, timeout=60000, wait_until="networkidle")
        await asyncio.sleep(2)
        await accept_cookies(page)
        await asyncio.sleep(1)

        hrefs = await page.eval_on_selector_all(
            "a[href^='mailto:']",
            """els => els.map(e => ({
                href: e.href,
                text: e.textContent,
                context: e.closest('td,li,p,div') ? e.closest('td,li,p,div').textContent : ''
            }))"""
        )
        for item in hrefs:
            email = email_from_mailto_href(item["href"])
            if not is_valid_email(email):
                continue
            # Omgivande cell/rad-text brukar innehålla "Namn (Parti), titel"
            # följt av e-postadressen — mailto-länkens EGEN text är ofta bara
            # adressen igen, inte namnet.
            context_text = re.sub(r"\s+", " ", (item.get("context") or "")).strip()
            before_email = context_text.split(email)[0].strip(" ,:-") if email in context_text else context_text
            party = _extract_party_anywhere(before_email)
            without_party = re.sub(r"\s*\([^)]*\)\s*", " ", before_email).strip()
            # "Namn, titel" eller "Namn (Parti), titel" — ta sista kommadelen som roll.
            name_part, _, role_part = without_party.partition(",")
            role = role_part.strip() or None
            person_name = name_part.strip() if _looks_like_name(name_part.strip()) else ""
            if not person_name:
                link_text = re.sub(r"\s+", " ", (item.get("text") or "")).strip()
                person_name = link_text if _looks_like_name(link_text) else ""
            people.add((person_name, email, party, role))

        # Fallback: regex på sidans HTML (ingen namnkoppling möjlig härifrån)
        if len(people) < 3:
            content = await page.content()
            for email in EMAIL_RE.findall(content):
                if is_valid_email(email.lower()):
                    people.add(("", email.lower(), None, None))

    except PlaywrightError as e:
        log.error(f"{namn}: {e}")
    finally:
        await page.close()

    log.info(f"{namn}: {len(people)} adresser funna")
    return people


async def scrape_pdf_lista(context, namn, url, domain):
    """Skrapar namn+mailadress-par ur en nedladdningsbar PDF-lista. Namnet plockas
    som bästa-försök ur texten som föregår e-postadressen på samma rad."""
    people = set()
    try:
        log.info(f"{namn}: hämtar {url}")
        if not is_safe_network_url(url) or urlsplit(url).scheme != "https":
            raise ValueError("PDF-källan måste vara en säker HTTPS-adress")
        response = await context.request.get(url, timeout=60000, max_redirects=0)
        if not response.ok:
            raise ValueError(f"PDF-källan svarade med HTTP {response.status}")
        content_length = response.headers.get("content-length")
        if content_length and int(content_length) > 20 * 1024 * 1024:
            raise ValueError("PDF-filen är större än 20 MiB")
        data = await response.body()
        if len(data) > 20 * 1024 * 1024:
            raise ValueError("PDF-filen är större än 20 MiB")
        reader = PdfReader(BytesIO(data))
        if len(reader.pages) > 500:
            raise ValueError("PDF-filen innehåller fler än 500 sidor")
        text_parts = []
        remaining_chars = 5_000_000
        for pdf_page in reader.pages:
            if remaining_chars <= 0:
                break
            page_text = (pdf_page.extract_text() or "")[:remaining_chars]
            text_parts.append(page_text)
            remaining_chars -= len(page_text)
        text = "\n".join(text_parts)
        for line in text.splitlines():
            match = EMAIL_RE.search(line)
            if not match:
                continue
            email = match.group(0).lower()
            if not (email.endswith(f"@{domain}") and is_valid_email(email)):
                continue
            before = line[:match.start()].strip()
            party = _extract_party_anywhere(before)
            name_match = NAME_CANDIDATE_RE.search(before)
            person_name = name_match.group(0).strip() if name_match else ""
            people.add((person_name, email, party, None))
    except Exception as e:
        log.error(f"{namn}: {e}")

    log.info(f"{namn}: {len(people)} adresser funna")
    return people


def spara_vcf(namn, emails, path):
    lines = [
        "BEGIN:VCARD",
        "VERSION:3.0",
        f"FN:{namn}",
        "N:;;;;",
        f"ORG:{namn}",
    ]
    for email in sorted(emails):
        lines.append(f"EMAIL;TYPE=WORK:{email}")
    lines.append("END:VCARD")
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    log.info(f"Sparad: {path}")


def spara_txt(alla_people, path):
    """Skriver en läsbar lista över samtliga kommuners/regioners förtroendevalda,
    sorterad alfabetiskt på kommun/region-namn och sedan på ledamotens namn
    (ledamöter utan känt namn sorteras in efter sin e-postadress istället).
    Format per rad: 'Namn <email> (PARTI) [Roll]' — parti inom parentes,
    roll inom hakparentes, båda valfria och utelämnas helt om okända."""
    lines = []
    for namn in sorted(alla_people.keys(), key=swedish_key):
        people = alla_people[namn]
        if not people:
            continue
        lines.append(f"## {namn}")
        for person_namn, email, party, role in sorted(
            people, key=lambda pe: swedish_key(pe[0] or pe[1])
        ):
            suffix = ""
            if party:
                suffix += f" ({party})"
            if role:
                suffix += f" [{role}]"
            if person_namn:
                lines.append(f"{person_namn} <{email}>{suffix}")
            else:
                lines.append(f"{email}{suffix}")
        lines.append("")

    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines).rstrip() + "\n")
    log.info(f"Sparad: {path}")


CSV_FIELDS = ["area_name", "name", "email", "party", "role", "source"]


def spara_csv(alla_people, sources, path):
    """Skriver en maskinläsbar CSV som är den kanoniska överföringsformen till
    sync_to_d1.py (istället för att parsa den människoläsbara .txt:en tillbaka,
    vilket är sprött för namn som själva innehåller '<' eller '(PARTI)').
    'source' anger hur adressen togs fram — 'pattern-guess' för de källor där
    adressen byggts från ett namnmönster och alltså kan vara felaktig/tillhöra
    fel person, 'scraped' för adresser som faktiskt stod på sidan."""
    with open(path, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=CSV_FIELDS)
        w.writeheader()
        for area in sorted(alla_people.keys(), key=swedish_key):
            source = "pattern-guess" if sources.get(area) in GUESSED_TYPES else "scraped"
            for person_namn, email, party, role in sorted(
                alla_people[area], key=lambda pe: swedish_key(pe[0] or pe[1])
            ):
                w.writerow({
                    "area_name": area, "name": person_namn, "email": email,
                    "party": party or "", "role": role or "", "source": source,
                })
    log.info(f"Sparad: {path}")


def spara_gissade(alla_people, sources, path):
    """Listar de adresser som byggts från namnmönster (typ namnmonster/namnlista)
    och alltså inte verifierats mot en publicerad mailto-länk. Ger operatören en
    överblick över vilka adresser som bör behandlas försiktigt (kan vara
    felstavade eller tillhöra en annan person med liknande namn)."""
    lines = []
    for area in sorted(alla_people.keys(), key=swedish_key):
        if sources.get(area) not in GUESSED_TYPES:
            continue
        people = alla_people[area]
        if not people:
            continue
        lines.append(f"## {area}")
        for person_namn, email, _party, _role in sorted(
            people, key=lambda pe: swedish_key(pe[0] or pe[1])
        ):
            lines.append(f"{person_namn} <{email}>" if person_namn else email)
        lines.append("")
    with open(path, "w", encoding="utf-8") as f:
        f.write(("\n".join(lines).rstrip() + "\n") if lines else "")
    log.info(f"Sparad: {path} ({sum(1 for a in alla_people if sources.get(a) in GUESSED_TYPES)} områden)")


# Typer där e-posten byggs från ett namnmönster (gissning), inte skrapas från en
# publicerad mailto-länk. Adresser härifrån kan vara fel och flaggas därför.
GUESSED_TYPES = {"namnmonster", "namnlista"}


async def main():
    alla_people = {}
    sources = {}  # område -> region["typ"], för att flagga gissade adresser

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            # --no-sandbox krävs eftersom containern kör som root utan den
            # kringgående user-namespace-konfig som Chromiums sandlåda annars
            # behöver; ofarligt här då vi bara besöker offentliga, betrodda
            # myndighetssidor. --disable-http2 undviker en HTTP/2-bugg som
            # bröt vissa sidladdningar; --disable-dev-shm-usage undviker att
            # /dev/shm tar slut i containern.
            args=["--no-sandbox", "--disable-dev-shm-usage", "--disable-http2"],
        )
        context = await browser.new_context(
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            ),
            locale="sv-SE",
            timezone_id="Europe/Stockholm",
        )
        await context.route("**/*", block_private_network_requests)

        for region in sources.load("regioner"):
            namn = region["namn"]
            try:
                if region["typ"] == "netpublicator":
                    people = await scrape_netpublicator(
                        context, namn,
                        region["netpub_registry"],
                        region["netpub_board"],
                    )
                elif region["typ"] == "troman":
                    people = await scrape_troman(context, namn, region["url"])
                elif region["typ"] == "w3d3":
                    people = await scrape_w3d3(context, namn, region["url"])
                elif region["typ"] == "fmr":
                    people = await scrape_fmr(context, namn, region["url"])
                elif region["typ"] == "profilsidor":
                    people = await scrape_profilsidor(
                        context, namn,
                        region["url"],
                        region["link_pattern"],
                        region["domain"],
                    )
                elif region["typ"] == "namnmonster":
                    people = await scrape_namnmonster(
                        context, namn,
                        region["url"],
                        region["domain"],
                        region["section_start"],
                        region.get("section_end"),
                        region.get("expand_text"),
                    )
                elif region["typ"] == "mailto":
                    people = await scrape_mailto(context, namn, region["url"])
                elif region["typ"] == "pdf":
                    people = await scrape_pdf_lista(context, namn, region["url"], region["domain"])
                elif region["typ"] == "namnlista":
                    people = await scrape_namnlista(
                        context, namn,
                        region["url"],
                        region["domain"],
                        region["section_start"],
                        region.get("section_end"),
                        region.get("skip_lines"),
                    )
                else:
                    raise ValueError(f"{namn}: okänd typ '{region['typ']}'")
            except Exception as e:
                log.error(f"{namn}: ohanterat fel, hoppar över ({e})")
                continue

            if people:
                alla_people[namn] = people
                sources[namn] = region["typ"]
                emails = {email for _, email, _, _ in people}
                safe = namn.replace(" ", "_").replace("/", "-")
                spara_vcf(namn, emails, f"{OUT_DIR}/{safe}.vcf")

            await asyncio.sleep(2)

        await context.close()
        await browser.close()

    # Samlad VCF
    alla = set()
    for people in alla_people.values():
        alla.update(email for _, email, _, _ in people)

    lines = [
        "BEGIN:VCARD",
        "VERSION:3.0",
        "FN:Alla regioner",
        "N:;;;;",
        "ORG:Sveriges Regioner",
    ]
    for email in sorted(alla):
        lines.append(f"EMAIL;TYPE=WORK:{email}")
    lines.append("END:VCARD")

    with open(f"{OUT_DIR}/Alla_regioner.vcf", "w", encoding="utf-8") as f:
        f.write("\n".join(lines))

    spara_txt(alla_people, f"{OUT_DIR}/Alla_kommuner_och_regioner.txt")
    spara_csv(alla_people, sources, f"{OUT_DIR}/Alla_kommuner_och_regioner.csv")
    spara_gissade(alla_people, sources, f"{OUT_DIR}/gissade_adresser.txt")

    log.info(f"Klar. {len(alla)} unika adresser från {len(alla_people)} regioner.")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as e:
        log.error(f"Globalt ohanterat fel: {e}")
        raise
