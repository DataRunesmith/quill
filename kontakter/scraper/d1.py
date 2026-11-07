#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Delad Cloudflare D1-klient för alla sync-/export-/verify-skript.

Ett enda ställe för auth, URL-bygge och felhantering mot D1:s HTTP-API, så att
inte varje skript återimplementerar samma POST-logik (och riskerar att driva
isär i variabelnamn och felhantering).

Konfigurationen läses ur processmiljön; ingen fil läses här. Sätt variablerna
i skalet som kör skriptet. quarterly_refresh.sh läser in en env-fil först om
QUILL_ENV_FILE pekar på en. Tokenet behöver bara D1-behörigheten Edit.

  CLOUDFLARE_ACCOUNT_ID
  CLOUDFLARE_API_TOKEN
  D1_DATABASE_UUID                 (alias: D1_DATABASE_ID)
"""
from __future__ import annotations

import os
import sys

import requests


def _env(*names: str) -> str:
    # strip(): värden som klistras in i GitHubs variabel-/secret-fält eller i en
    # .env får lätt med sig en radbrytning. Den överlever in i URL:en som %0D%0A
    # och ger ett 400 från Cloudflare som inte säger något om vad som är fel.
    for n in names:
        val = os.environ.get(n)
        if val and val.strip():
            return val.strip()
    sys.exit(f"FEL: sätt en av miljövariablerna: {', '.join(names)}")


class D1Client:
    """Tunn wrapper runt D1:s query-endpoint med en återanvänd requests-Session
    (connection pooling för de skript som gör tusentals anrop)."""

    def __init__(self, session: requests.Session | None = None):
        self.account_id = _env("CLOUDFLARE_ACCOUNT_ID")
        self.token = _env("CLOUDFLARE_API_TOKEN")
        self.db = _env("D1_DATABASE_UUID", "D1_DATABASE_ID")
        self.url = (
            f"https://api.cloudflare.com/client/v4/accounts/{self.account_id}"
            f"/d1/database/{self.db}/query"
        )
        self.session = session or requests.Session()
        self.session.headers.update(
            {"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"}
        )

    def run(self, sql: str, params: list | None = None, timeout: int = 30) -> dict:
        """Kör en SQL-sats och returnerar hela result[0]-objektet (results + meta).
        Kastar requests.HTTPError vid HTTP-fel och RuntimeError vid D1-fel."""
        resp = self.session.post(
            self.url, json={"sql": sql, "params": params or []}, timeout=timeout
        )
        resp.raise_for_status()
        data = resp.json()
        if not data.get("success"):
            raise RuntimeError(f"D1-fel: {data.get('errors')}")
        return data["result"][0]

    def query(self, sql: str, params: list | None = None, timeout: int = 30) -> list[dict]:
        """Bekvämlighet för SELECT: returnerar bara raderna (result[0]['results'])."""
        return self.run(sql, params, timeout).get("results", [])
