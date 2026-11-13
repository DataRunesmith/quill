#!/bin/sh
# Renders the app with the values from the container environment, applies D1
# migrations to /data and serves the Worker. Secrets reach
# wrangler through a private env file; missing keys are generated once and
# kept in the data volume.
set -eu

# Saved settings from a one-time /data/import.env (see import-settings.sh).
. /opt/app/docker/import-settings.sh

: "${PUBLIC_HOST:=localhost}"
: "${SYSTEM_FROM_ADDRESS:=noreply@example.com}"
: "${TURNSTILE_SITE_KEY:=}"
: "${TURNSTILE_SECRET:=off}"
: "${TURNSTILE_HOSTNAMES:=$PUBLIC_HOST}"

key() {
  key_file="/data/$1"
  if [ -L "$key_file" ] || { [ -e "$key_file" ] && [ ! -f "$key_file" ]; }; then
    echo "Refusing unsafe key path: $key_file" >&2
    return 1
  fi
  if [ ! -s "$key_file" ]; then
    key_tmp=$(mktemp "/data/.$1.XXXXXX")
    (umask 077 && node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64'))" >"$key_tmp")
    chmod 600 "$key_tmp"
    mv -f "$key_tmp" "$key_file"
  fi
  [ -f "$key_file" ] && [ ! -L "$key_file" ] || {
    echo "Unsafe key file: $key_file" >&2
    return 1
  }
  chmod 600 "$key_file"
  cat "$key_file"
}
: "${MAIL_CRED_KEY:=$(key mail-cred-key)}"

# Placeholder values for the rendered copy; resource ids only matter on Cloudflare.
export PUBLIC_HOST SYSTEM_FROM_ADDRESS TURNSTILE_SITE_KEY TURNSTILE_HOSTNAMES
export ZONE_NAME="" D1_DATABASE_NAME=quill D1_DATABASE_ID=local KV_SESSIONS_ID=local
export SYSTEM_SMTP_HOST="${SYSTEM_SMTP_HOST:-}" SYSTEM_SMTP_PORT="${SYSTEM_SMTP_PORT:-587}"
export SYSTEM_SMTP_USER="${SYSTEM_SMTP_USER:-}" FEEDBACK_NOTIFY_EMAIL="${FEEDBACK_NOTIFY_EMAIL:-}"
export OAUTH_GOOGLE_CLIENT_ID="${OAUTH_GOOGLE_CLIENT_ID:-}" OAUTH_MICROSOFT_CLIENT_ID="${OAUTH_MICROSOFT_CLIENT_ID:-}"
export SITE_FAMILY="${SITE_FAMILY:-Skog}" THEME_KEY_PREFIX="${THEME_KEY_PREFIX:-quill}"
export THEME_COOKIE_DOMAIN="${THEME_COOKIE_DOMAIN:-}" DONATION_HTML="${DONATION_HTML:-}"

app=/opt/app
umask 077
values=$(mktemp)
vars=""
worker_pid=""
scheduler_pid=""
cleanup() {
  [ -z "$worker_pid" ] || kill "$worker_pid" 2>/dev/null || true
  [ -z "$scheduler_pid" ] || kill "$scheduler_pid" 2>/dev/null || true
  [ -z "$values" ] || rm -f "$values"
  [ -z "$vars" ] || rm -f "$vars"
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
sed -n 's/^\([A-Z][A-Z0-9_]*\)=.*/\1/p' "$app/cloudflare.example.env" | while read -r name; do
  printf '%s=%s\n' "$name" "$(printenv "$name" || true)"
done >"$values"
site=/srv/site
node /opt/app/tools/render.mjs "$values" "$site" >/dev/null
rm -f "$values"
values=""
ln -s "$app/app/node_modules" "$site/node_modules"
cp "$site/docker/wrangler.template.jsonc" "$site/wrangler.jsonc"

vars=$(mktemp)
chmod 600 "$vars"
# Wrangler reads this file as dotenv. Single quotes keep '#' and surrounding
# whitespace literal; characters dotenv would still alter are refused instead
# of being silently changed (a mangled admin password would be persisted).
nl=$(printf '\nx'); nl=${nl%x}
cr=$(printf '\rx'); cr=${cr%x}
emit_var() {
  name=$1
  value=$(printenv "$name" || true)
  [ -n "$value" ] || return 0
  case "$value" in
    *"'"* | *'$'* | *'\\'* | *"$nl"* | *"$cr"*)
      echo "$name contains a character that cannot be passed safely (single quote, \$, backslash or newline)." >&2
      exit 1
      ;;
  esac
  printf "%s='%s'\n" "$name" "$value"
}
{
  for name in MAIL_CRED_KEY SYSTEM_FROM_ADDRESS TURNSTILE_SECRET TURNSTILE_HOSTNAMES; do
    value=$(printenv "$name" || true)
    case "$value" in
      *"'"* | *'$'* | *'\\'*) echo "$name contains a character that cannot be passed safely." >&2; exit 1 ;;
    esac
    printf "%s='%s'\n" "$name" "$value"
  done
  for name in ADMIN_EMAIL ADMIN_PASSWORD SYSTEM_SMTP_HOST SYSTEM_SMTP_PORT SYSTEM_SMTP_USER SYSTEM_SMTP_PASSWORD \
    FEEDBACK_NOTIFY_EMAIL RESEND_API_KEY LETTER_DATA_KEY VISITOR_SALT OAUTH_GOOGLE_CLIENT_ID \
    OAUTH_GOOGLE_CLIENT_SECRET OAUTH_MICROSOFT_CLIENT_ID OAUTH_MICROSOFT_CLIENT_SECRET; do
    emit_var "$name"
  done
} >>"$vars"

cd "$site"
npx wrangler d1 migrations apply DB --local --persist-to /data

node docker/scheduler.mjs &
scheduler_pid=$!
npx wrangler dev --local --persist-to /data --test-scheduled \
  --ip 0.0.0.0 --port "${PORT:-8787}" \
  --env-file "$vars" --show-interactive-dev-session=false &
worker_pid=$!
wait "$worker_pid"
