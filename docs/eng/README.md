# Quill

A web tool for writing letters to politicians, agencies and newsrooms from your own e-mail account. Letters go out through SMTP, Microsoft Graph or Resend, and recipient data and credentials are encrypted.

The app is a Cloudflare Worker (in `app/`) with D1, KV, R2, queues and Durable Objects. All settings are `__NAME__` placeholders. `kontakter/` holds Python tools that maintain the contact registry.

## Getting started

```sh
cd app
npm install
npm test
npm run validate    # the full pre-deploy check
```

Run your own copy:

```sh
cp cloudflare.example.env my-values.env
node tools/render.mjs my-values.env build
(cd build/app && npx wrangler dev)
```

Secrets such as `MAIL_CRED_KEY` do not belong in the values file; set them with `wrangler secret put` or as container environment variables. The database is created by the files in `infra/migrations`.

`docker/entrypoint.sh` renders and starts the app from environment variables in a container, with data in `/data`. The one-time first-admin bootstrap requires `ADMIN_EMAIL` and `ADMIN_PASSWORD` (at least 12 characters), supplied as container secrets. It creates an account only when that email does not already exist; an existing account is never promoted automatically.

The contact tools:

```sh
cd kontakter
pip install -r requirements-dev.txt requests pypdf dnspython
python -m pytest -q
```
