#!/bin/sh
# Deploys the app to your Cloudflare account, from start to finish:
#
#   sh tools/deploy.sh .cloudflare.env   values from a file
#   sh tools/deploy.sh                   values from environment variables
#
# The values are the names listed in cloudflare.example.env. They are filled
# into a temporary copy of the repo, which is deployed and then removed, so no
# value ends up in a tracked file. The copy also gets the documentation site
# under /docs (needs python3 with venv; SKIP_DOCS=1 leaves it out), and pending
# D1 migrations are applied before the Worker is uploaded. Arguments after the
# values file go to `wrangler deploy`, for example --dry-run.
set -eu
case "${1:-}" in
  "" | -*)
    values=-
    [ "${1:-}" != - ] || shift
    ;;
  *)
    [ -f "$1" ] || { echo "No such values file: $1" >&2; exit 1; }
    values=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
    shift
    ;;
esac
cd "$(dirname "$0")/.."

if [ "$values" = - ]; then
  # A name that is not set counts as empty, so only your own values are needed.
  found=
  for name in $(sed -n 's/^\([A-Z][A-Z0-9_]*\)=.*/\1/p' cloudflare.example.env); do
    if [ -n "$(printenv "$name" || true)" ]; then found=1; else export "$name="; fi
  done
  [ -n "$found" ] || {
    echo "No values found. Pass a values file, or set the variables named in cloudflare.example.env." >&2
    exit 1
  }
fi

# The value of a name, from the values file or from the environment.
value_of() {
  if [ "$values" = - ]; then
    printenv "$1" || true
  else
    sed -n "s/^$1=//p" "$values" | tail -n 1
  fi
}

# Wrangler takes its own credentials from the environment; a values file may
# carry them as well.
for name in CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID; do
  [ -z "$(printenv "$name" || true)" ] || continue
  value=$(value_of "$name")
  [ -z "$value" ] || export "$name=$value"
done

dry_run=
for arg in "$@"; do
  [ "$arg" != --dry-run ] || dry_run=1
done

[ -d app/node_modules/wrangler ] || (cd app && npm ci --no-audit --no-fund)
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
node tools/render.mjs "$values" "$out/app" >/dev/null
cd "$out/app"

if [ "${SKIP_DOCS:-}" = 1 ]; then
  :
elif python3 -c 'import ensurepip, venv' 2>/dev/null; then
  sh tools/docs-cloudflare.sh app/public >/dev/null
else
  echo "python3 with venv was not found; deploying without the documentation under /docs." >&2
fi

cd app
[ -n "$dry_run" ] || npx wrangler d1 migrations apply DB --remote
npx wrangler deploy "$@"
