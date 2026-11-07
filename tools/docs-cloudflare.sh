#!/bin/sh
# Builds the documentation site into <assets-dir>/docs, so the app's own Worker
# serves it under /docs. Workers Builds runs it after rendering:
#   node tools/render.mjs - build && sh tools/docs-cloudflare.sh <assets-dir>
# If <assets-dir>/_headers exists, a /docs/* rule replaces the app's CSP there
# with one that allows the site's inline scripts by hash and the inline styles
# its scripts set. The GitHub widget gets no repo stats, since connect-src
# stays at 'self'.
set -eu
dir=${1:?usage: sh tools/docs-cloudflare.sh <assets-dir>}
python3 -m venv .venv-docs
.venv-docs/bin/pip install --quiet --no-deps -r requirements-docs.txt
node tools/docs-site.mjs
.venv-docs/bin/zensical build --clean
rm -rf "$dir/docs"
cp -r site "$dir/docs"
if [ -f "$dir/_headers" ]; then
  hashes=$(node tools/docs-site.mjs --csp-hashes site)
  cat >>"$dir/_headers" <<RULE

/docs/*
  ! Content-Security-Policy
  Content-Security-Policy: default-src 'self'; script-src 'self' $hashes; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests
RULE
fi
