#!/bin/bash
# Kvartalsvis uppdatering av hela kontaktlistan: politiker, kyrkovalda,
# redaktionella mediekontakter och akademiska yrkeskontakter. Synkar till D1
# och uppdaterar parti där relevant.
#
# Första körningen efter riksdagsvalet 2026 bör göras tidigast 2026-10-01,
# när offentliga register hunnit börja spegla den nya mandatperioden. Därefter
# körs jobbet var 3:e månad enligt serverns scheduler/crontab.
set -e
cd "$(dirname "$0")"

# Sync-/importskripten som använder D1 HTTP-API behöver sina Cloudflare-
# variabler i processmiljön. Ingen lokal sökväg antas här. Om servern använder
# en env-fil kan schedulern sätta QUILL_ENV_FILE till just den filen.
if [[ -n "${QUILL_ENV_FILE:-}" ]]; then
  set -a
  source "$QUILL_ENV_FILE"
  set +a
fi

# Kontaktlistor och källkataloger ligger utanför repot (se ../sources.example/).
: "${CONTACT_SOURCES_DIR:?Sätt CONTACT_SOURCES_DIR till katalogen med dina källfiler.}"
export CONTACT_SOURCES_DIR

echo "=== $(date -Iseconds) Startar kvartalsvis uppdatering ==="

echo "--- Skrapar kommun/region (Playwright/Docker) ---"
cd ..
docker compose up --build --abort-on-container-exit --exit-code-from scraper
cd scraper

echo "--- Synkar kommun/region till D1 ---"
python3 sync_to_d1.py

echo "--- Hämtar nämnder/styrelser från Troman ---"
python3 backfill_assignments.py

echo "--- Hämtar Sveriges EU-parlamentariker ---"
python3 fetch_eu_meps.py

echo "--- Hämtar riksdagens nuvarande ledamöter ---"
python3 fetch_riksdagen_members.py

echo "--- Synkar regeringens departement ---"
python3 sync_regeringen.py

echo "--- Hämtar Svenska kyrkans förtroendevalda (sidorna i kyrka.json) ---"
python3 fetch_kyrka.py

echo "--- Synkar nyhetsredaktionernas kontakter ---"
python3 fetch_media.py

echo "--- Synkar akademiska yrkeskontakter ---"
python3 fetch_academics.py

echo "--- Fyller i parti för kommun/region via Valmyndigheten ---"
python3 sync_party_from_val.py

echo "--- Saniterar och normaliserar D1 efter alla importer ---"
python3 sanitize_d1.py --apply

echo "=== $(date -Iseconds) Klart ==="
