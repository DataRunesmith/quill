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
  [ -s "/data/$1" ] || (umask 077 && node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64'))" >"/data/$1")
  cat "/data/$1"
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
values=$(mktemp)
sed -n 's/^\([A-Z][A-Z0-9_]*\)=.*/\1/p' "$app/cloudflare.example.env" | while read -r name; do
  printf '%s=%s\n' "$name" "$(printenv "$name" || true)"
done >"$values"
site=/srv/site
node /opt/app/tools/render.mjs "$values" "$site" >/dev/null
ln -s "$app/app/node_modules" "$site/node_modules"
cp "$site/docker/wrangler.template.jsonc" "$site/wrangler.jsonc"

vars=$(mktemp)
chmod 600 "$vars"
{
  echo "MAIL_CRED_KEY=$MAIL_CRED_KEY"
  echo "SYSTEM_FROM_ADDRESS=$SYSTEM_FROM_ADDRESS"
  echo "TURNSTILE_SECRET=$TURNSTILE_SECRET"
  echo "TURNSTILE_HOSTNAMES=$TURNSTILE_HOSTNAMES"
  for name in ADMIN_EMAIL SYSTEM_SMTP_HOST SYSTEM_SMTP_PORT SYSTEM_SMTP_USER SYSTEM_SMTP_PASSWORD \
    FEEDBACK_NOTIFY_EMAIL RESEND_API_KEY LETTER_DATA_KEY VISITOR_SALT OAUTH_GOOGLE_CLIENT_ID \
    OAUTH_GOOGLE_CLIENT_SECRET OAUTH_MICROSOFT_CLIENT_ID OAUTH_MICROSOFT_CLIENT_SECRET; do
    value=$(printenv "$name" || true)
    [ -n "$value" ] && echo "$name=$value"
  done
} >>"$vars"

cd "$site"
npx wrangler d1 migrations apply DB --local --persist-to /data

node docker/scheduler.mjs &
exec npx wrangler dev --local --persist-to /data --test-scheduled \
  --ip 0.0.0.0 --port "${PORT:-8787}" \
  --env-file "$vars" --show-interactive-dev-session=false
