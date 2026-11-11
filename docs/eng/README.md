# Quill

A web tool for writing letters to politicians, agencies and newsrooms from your own e-mail account. Letters go out through SMTP, Microsoft Graph or Resend, and recipient data and credentials are encrypted.

The app is a Cloudflare Worker (in `app/`) with D1, KV, R2, queues and Durable Objects. All settings are `__NAME__` placeholders, so nothing specific to an environment is committed: your own values stay in a file git ignores, in GitHub Actions secrets or in Cloudflare build variables. `kontakter/` holds Python tools that maintain the contact registry.

## Run your own copy

There are four ways, and they all end in the same app. Pick one.

| Way | You need | Runs on |
|---|---|---|
| [Docker](#docker) | Docker | Your own machine or server |
| [From your computer](#from-your-computer) | Node.js 24, a Cloudflare account | Cloudflare |
| [GitHub Actions](#github-actions) | A GitHub account, a Cloudflare account | Cloudflare, on every push to `main` |
| [Cloudflare Workers Builds](#cloudflare-workers-builds) | A GitHub or GitLab account, a Cloudflare account | Cloudflare, on every push to `main` |

A GitHub account is only needed for the last two. For the first two, download the source as a ZIP file or clone it.

### Docker

```sh
ADMIN_EMAIL='you@example.com' docker compose up -d
```

Open <http://localhost:8787> and register with that address; within a minute the account becomes the administrator. All data, including a generated encryption key, is kept in the `data` volume, so back that volume up. Without mail settings new accounts are verified directly. To have the app send verification and password mails, also set `SYSTEM_FROM_ADDRESS` together with either `RESEND_API_KEY` or `SYSTEM_SMTP_HOST`, `SYSTEM_SMTP_PORT`, `SYSTEM_SMTP_USER` and `SYSTEM_SMTP_PASSWORD`. Set `PUBLIC_HOST` to the host name the app is reached on; the links in those mails use it. Instead of typing the values on the command line you can put them in a file named `.env` next to `compose.yaml`; git ignores it.

### Your values on Cloudflare

The three Cloudflare ways use the same values. They are listed in `cloudflare.example.env`:

| Name | Value |
|---|---|
| `PUBLIC_HOST` | The host name the app is served on, for example `letters.example.com`. The domain must be in your Cloudflare account. |
| `D1_DATABASE_NAME`, `D1_DATABASE_ID` | Name and ID of your D1 database. |
| `KV_SESSIONS_ID` | ID of the KV namespace that holds the sessions. |
| `TURNSTILE_SITE_KEY` | Site key of a Turnstile widget. |
| `TURNSTILE_HOSTNAMES` | The host names the widget is allowed on, comma separated; normally the same as `PUBLIC_HOST`. |
| `SYSTEM_FROM_ADDRESS` | The sender of verification and password mails. |
| `SYSTEM_SMTP_HOST`, `SYSTEM_SMTP_PORT`, `SYSTEM_SMTP_USER` | Optional. The SMTP server those mails go through; leave empty when you use Resend. |
| `FEEDBACK_NOTIFY_EMAIL` | Optional. Where feedback from users is sent. |
| `OAUTH_GOOGLE_CLIENT_ID`, `OAUTH_MICROSOFT_CLIENT_ID` | Optional. Client IDs that let users connect a Google or Microsoft mail account. |
| `THEME_KEY_PREFIX` | Name used for the theme setting in the browser, for example `quill`. |
| `THEME_COOKIE_DOMAIN` | Optional. A parent domain to share the theme setting with your other sites. |
| `SITE_FAMILY` | Name shown for the default theme. |
| `DONATION_HTML` | Optional. HTML shown where the app asks for support. |

Do this once, before the first deploy. The first two commands print the IDs for the table above:

```sh
npx wrangler d1 create quill
```

```sh
npx wrangler kv namespace create SESSIONS
```

```sh
npx wrangler r2 bucket create quill-attachments
```

```sh
npx wrangler queues create quill-send-jobs
```

Also create a Turnstile widget for `PUBLIC_HOST` in the Cloudflare dashboard and note its site key and secret key, turn on Email Routing for the domain (the Worker has a `send_email` binding), and create an API token for deploying from the "Edit Cloudflare Workers" template with the permissions Account: D1: Edit and Account: Queues: Edit added. The token is the value of `CLOUDFLARE_API_TOKEN` below.

And this once, after the first deploy. Each command asks for the value; the secrets stay in place across later deploys:

```sh
npx wrangler secret put MAIL_CRED_KEY --name quill
```

```sh
npx wrangler secret put TURNSTILE_SECRET --name quill
```

```sh
npx wrangler secret put RESEND_API_KEY --name quill
```

`MAIL_CRED_KEY` encrypts the stored mail credentials; create it with `openssl rand -base64 32`, keep a copy and never change it. `TURNSTILE_SECRET` is the secret key of the widget. For mail, set either `RESEND_API_KEY` or `SYSTEM_SMTP_PASSWORD`. `OAUTH_GOOGLE_CLIENT_SECRET` and `OAUTH_MICROSOFT_CLIENT_SECRET` are set the same way if you use them.

Finally register in the app and make your account the administrator:

```sh
npx wrangler d1 execute quill --remote --command "UPDATE accounts SET is_admin = 1 WHERE email = 'you@example.com'"
```

The tables are created and updated by the files in `infra/migrations` on every deploy.

### From your computer

```sh
cp cloudflare.example.env .cloudflare.env
```

Fill in `.cloudflare.env` (git ignores every `*.env` file except the example), sign in once and deploy:

```sh
npx wrangler login
```

```sh
sh tools/deploy.sh .cloudflare.env
```

Run the last command again whenever you want to deploy a newer version. `tools/deploy.sh` fills the values into a temporary copy, builds the documentation into `/docs` if python3 is installed, applies new database migrations, deploys the copy and removes it. Extra arguments go to `wrangler deploy`; `sh tools/deploy.sh .cloudflare.env --dry-run` builds without touching the database or uploading.

### GitHub Actions

Fork the repo, or push a copy to your own account. Fill in `.cloudflare.env` as above and add the lines `CLOUDFLARE_API_TOKEN=...` and `CLOUDFLARE_ACCOUNT_ID=...`. Then store every value as a repository secret with the [GitHub CLI](https://cli.github.com/):

```sh
grep -v '=$' .cloudflare.env | gh secret set -f - -R your-account/quill
```

The same can be done by hand under Settings → Secrets and variables → Actions. From then on the Deploy workflow deploys every push to `main`, and it can be started by hand under Actions → Deploy → Run workflow. The values are never written to a file in the repo and GitHub masks them in the logs. Without the secret `CLOUDFLARE_API_TOKEN` the workflow does nothing.

### Cloudflare Workers Builds

In the Cloudflare dashboard, create a Worker named `quill` from your repository (Workers & Pages → Create → Import a repository) and set:

- Deploy command: `sh tools/deploy.sh`
- Build variables and secrets: every name from the table above with your value
- API token: the token you created above; the token Cloudflare creates by itself cannot apply D1 migrations
- Settings → Build → Branch control: turn off Enable Preview Builds

Cloudflare then deploys every push to `main`. Use either this or the GitHub Actions way, not both, or each push is deployed twice.

## Develop

```sh
cd app
npm ci
npm test
npm run validate    # the full check before deploying
```

To try it locally without Docker, render a copy with your values and start it:

```sh
node tools/render.mjs .cloudflare.env build
```

```sh
(cd build/app && npx wrangler d1 migrations apply DB --local && npx wrangler dev)
```

The contact tools:

```sh
cd kontakter
pip install -r requirements-dev.txt requests pypdf dnspython
python -m pytest -q
```
