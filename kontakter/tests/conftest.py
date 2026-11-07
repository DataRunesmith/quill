"""Delad testkonfiguration: gör projektets moduler importerbara och pekar om
scraperns katalog-sidoeffekter (os.makedirs på import) till en temp-katalog."""
import os
import sys
import tempfile

_HERE = os.path.dirname(__file__)
_ROOT = os.path.join(_HERE, "..")

# Modulerna ligger i scraper/, export/ och verify/ — lägg dem på importvägen.
for sub in ("scraper", "export", "verify"):
    sys.path.insert(0, os.path.abspath(os.path.join(_ROOT, sub)))

# scraper.py kör os.makedirs(LOG_DIR/OUTPUT_DIR) redan vid import (default /logs,
# /output). Peka om till en temp-katalog så importen inte kräver root.
_tmp = tempfile.mkdtemp(prefix="quill-test-")
os.environ.setdefault("LOG_DIR", os.path.join(_tmp, "logs"))
os.environ.setdefault("OUTPUT_DIR", os.path.join(_tmp, "output"))

# Kontaktlistor och källkataloger ligger aldrig i repot; testerna läser exemplen.
os.environ.setdefault("CONTACT_SOURCES_DIR", os.path.abspath(os.path.join(_ROOT, "sources.example")))
