"""Var kontaktkällorna finns.

Koden innehåller inga kontaktlistor eller källkataloger. De ligger i JSON-filer i
en egen katalog utanför repot, som pekas ut med miljövariabeln
CONTACT_SOURCES_DIR. Exempel på varje fil finns i kontakter/sources.example/.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

EXAMPLES = Path(__file__).resolve().parent.parent / "sources.example"


def sources_dir() -> Path:
    value = os.environ.get("CONTACT_SOURCES_DIR", "").strip()
    if not value:
        raise SystemExit(
            "CONTACT_SOURCES_DIR är inte satt. Kopiera kontakter/sources.example/ till en "
            "egen katalog utanför repot, fyll i den och peka ut den med CONTACT_SOURCES_DIR."
        )
    return Path(value).expanduser()


def load(name: str):
    path = sources_dir() / f"{name}.json"
    if not path.is_file():
        raise SystemExit(f"Källfilen saknas: {path} (se {EXAMPLES / (name + '.json')})")
    return json.loads(path.read_text(encoding="utf-8"))
