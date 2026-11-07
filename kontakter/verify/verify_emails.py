#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Periodisk verifiering av e-postadresser i D1-tabellen `public_contacts`
(quill-projektet). Körs via cron/systemd-timer på en egen server — INTE
i Cloudflare Workers, eftersom Cloudflare blockerar utgående port 25
ovillkorligt (se docs/kontakter.md).

Tekniken: en "SMTP callout" per domän — koppla upp mot mottagardomänens
MX-server på port 25, skicka EHLO/MAIL FROM/RCPT TO för varje adress på den
domänen, läs svarskoderna, och avsluta INNAN något DATA-kommando skickas.
Inget mail skickas någonsin till mottagaren.

Begränsning värd att känna till: stora leverantörer (Microsoft 365, Google
Workspace) svarar ofta "accepterad" på RCPT TO oavsett om mottagaren
faktiskt finns kvar, just för att motverka denna typ av probing. Skriptet
upptäcker "catch-all"-domäner genom att även testa en uppenbart påhittad
adress per domän — om även den accepteras flaggas hela domänens resultat
som osäkert (catchall_unverified) istället för falskt "valid".

Miljövariabler som krävs (läses ur processmiljön, se d1.py):
  CLOUDFLARE_ACCOUNT_ID
  CLOUDFLARE_API_TOKEN
  D1_DATABASE_UUID
"""

import os
import random
import smtplib
import socket
import string
import sys
import time
from collections import defaultdict

import dns.resolver

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scraper"))
from d1 import D1Client  # noqa: E402

SMTP_TIMEOUT = 10
DELAY_BETWEEN_DOMAINS = 1.5  # sekunder — var en god nätgranne, ingen brådska
HELO_NAME = os.environ.get("VERIFY_HELO_NAME", "localhost")
# En riktig, levererbar adress som du äger — aldrig spoofad.
PROBE_FROM = os.environ.get("VERIFY_PROBE_FROM", "")


def random_local_part() -> str:
    return "probe-" + "".join(random.choices(string.ascii_lowercase + string.digits, k=12))


def resolve_mx(domain: str):
    try:
        answers = dns.resolver.resolve(domain, "MX", lifetime=10)
        return sorted(((r.preference, str(r.exchange).rstrip(".")) for r in answers), key=lambda x: x[0])
    except Exception:
        return []


def _connect(mx_hosts: list[tuple[int, str]]) -> smtplib.SMTP | None:
    """Kopplar upp mot första MX-värden som svarar och gör HELO. None om ingen
    gick att nå."""
    for _, host in mx_hosts:
        try:
            smtp = smtplib.SMTP(timeout=SMTP_TIMEOUT)
            smtp.connect(host, 25)
            smtp.helo(HELO_NAME)
            return smtp
        except (socket.error, smtplib.SMTPException):
            continue
    return None


def _classify(code: int, is_catchall: bool) -> str:
    """Översätter en RCPT TO-svarskod till en status.

    2xx = accepterad (giltig, eller osäker om domänen är catch-all).
    5xx = permanent avvisad (adressen finns inte) -> dead.
    4xx = TILLFÄLLIGT fel (greylisting, rate limit, full brevlåda). Får INTE
          tolkas som dead — det säger inget om huruvida adressen finns. Egen
          status så en giltig men greylistad adress inte felflaggas."""
    if 250 <= code < 260:
        return "catchall_unverified" if is_catchall else "valid"
    if 500 <= code < 600:
        return "dead"
    if 400 <= code < 500:
        return "temporary"
    return f"unknown_code_{code}"


def probe_domain(domain: str, emails: list[str]) -> dict[str, str]:
    """Returnerar {email: status} för alla emails på denna domän."""
    results = {e: "unknown" for e in emails}

    mx_hosts = resolve_mx(domain)
    if not mx_hosts:
        for e in emails:
            results[e] = "unreachable_no_mx"
        return results

    smtp = _connect(mx_hosts)
    if smtp is None:
        for e in emails:
            results[e] = "unreachable_connect_failed"
        return results

    try:
        # Catch-all-detektion: en uppenbart påhittad adress på samma domän.
        is_catchall = False
        try:
            smtp.mail(PROBE_FROM)
            code, _ = smtp.rcpt(f"{random_local_part()}@{domain}")
            if 250 <= code < 260:
                is_catchall = True
            smtp.rset()
        except smtplib.SMTPException:
            pass  # om själva probe-steget kraschar, fortsätt ändå med de riktiga adresserna

        for e in emails:
            try:
                smtp.mail(PROBE_FROM)
                code, _ = smtp.rcpt(e)
                smtp.rset()
                results[e] = _classify(code, is_catchall)
            except smtplib.SMTPServerDisconnected:
                # Många MX-servrar rate-limitar antalet RCPT per anslutning och
                # stänger den. Återanslut EN gång och testa om denna adress, så
                # att resten av domänens adresser inte alla blir "error".
                smtp = _connect(mx_hosts)
                if smtp is None:
                    results[e] = "unreachable_connect_failed"
                    break
                try:
                    smtp.mail(PROBE_FROM)
                    code, _ = smtp.rcpt(e)
                    smtp.rset()
                    results[e] = _classify(code, is_catchall)
                except smtplib.SMTPException as err:
                    results[e] = f"error_{type(err).__name__}"
            except smtplib.SMTPException as err:
                results[e] = f"error_{type(err).__name__}"
    finally:
        try:
            smtp.quit()
        except Exception:
            # Städning i finally: servern har ofta redan stängt anslutningen
            # när vi kommer hit. Ett fel här får inte maskera resultaten som
            # redan samlats in — de returneras nedan oavsett.
            pass

    return results


def main():
    client = D1Client()
    public_contacts = client.query("SELECT id, email FROM public_contacts")
    print(f"Hämtade {len(public_contacts)} politiker-rader från D1.")

    by_domain: dict[str, list[tuple[str, str]]] = defaultdict(list)
    for row in public_contacts:
        email = row["email"]
        if "@" not in email:
            continue
        domain = email.rsplit("@", 1)[1].lower()
        by_domain[domain].append((row["id"], email))

    print(f"{len(by_domain)} unika domäner att kontrollera.")

    counts = defaultdict(int)
    now_ms = int(time.time() * 1000)

    for i, (domain, rows) in enumerate(sorted(by_domain.items()), 1):
        emails = [email for _, email in rows]
        print(f"[{i}/{len(by_domain)}] {domain} ({len(emails)} adresser)...")
        try:
            status_by_email = probe_domain(domain, emails)
        except Exception as err:
            print(f"  OVÄNTAT FEL för {domain}: {err}", file=sys.stderr)
            status_by_email = {e: "error_unexpected" for e in emails}

        for contact_id, email in rows:
            status = status_by_email.get(email, "unknown")
            counts[status] += 1
            client.run(
                "UPDATE public_contacts SET verification_status = ?, last_verified_at = ? WHERE id = ?",
                [status, now_ms, contact_id],
            )

        time.sleep(DELAY_BETWEEN_DOMAINS)

    print("\nKlart. Sammanfattning:")
    for status, n in sorted(counts.items(), key=lambda kv: -kv[1]):
        print(f"  {status}: {n}")


if __name__ == "__main__":
    main()
