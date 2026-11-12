# Quill

Ett webbverktyg för att skriva brev till politiker, myndigheter och redaktioner från sitt eget e-postkonto. Brev skickas via SMTP, Microsoft Graph eller Resend, och uppgifter om mottagare och inloggningar krypteras.

Appen är en Cloudflare Worker (i `app/`) med D1, KV, R2, köer och Durable Objects. Alla inställningar är platshållare av typen `__NAMN__`, så ingen miljöspecifik uppgift ligger i koden: dina egna värden ligger i en fil som git ignorerar, i hemligheter i GitHub Actions eller i byggvariabler hos Cloudflare. I `kontakter/` finns Python-verktyg som underhåller kontaktregistret.

## Kör en egen kopia

Det finns fyra sätt, och alla ger samma app. Välj ett.

| Sätt | Du behöver | Körs på |
|---|---|---|
| [Docker](#docker) | Docker | Din egen dator eller server |
| [Direkt med Wrangler](#direkt-med-wrangler) | Node.js 24, ett Cloudflare-konto | Cloudflare |
| [GitHub Actions](#github-actions) | Ett GitHub-konto, ett Cloudflare-konto | Cloudflare, vid varje push till `main` |
| [Cloudflare Workers Builds](#cloudflare-workers-builds) | Ett GitHub- eller GitLab-konto, ett Cloudflare-konto | Cloudflare, vid varje push till `main` |

Ett GitHub-konto behövs bara för de två sista. För de två första räcker det att ladda ned källkoden som ZIP-fil eller klona den.

### Docker

```sh
ADMIN_EMAIL='du@example.com' docker compose up -d
```

Öppna <http://localhost:8787> och registrera dig med den adressen; inom en minut blir kontot administratör. All data, även en genererad krypteringsnyckel, sparas i volymen `data`, så säkerhetskopiera den volymen. Utan e-postinställningar bekräftas nya konton direkt. Om appen ska skicka bekräftelse- och lösenordsmejl sätter du också `SYSTEM_FROM_ADDRESS` tillsammans med antingen `RESEND_API_KEY` eller `SYSTEM_SMTP_HOST`, `SYSTEM_SMTP_PORT`, `SYSTEM_SMTP_USER` och `SYSTEM_SMTP_PASSWORD`. Sätt `PUBLIC_HOST` till värdnamnet som appen nås på; länkarna i mejlen använder det. I stället för att skriva värdena på kommandoraden kan du lägga dem i en fil med namnet `.env` bredvid `compose.yaml`; git ignorerar den.

Porten publiceras bara på den här datorn. För att nå appen från andra datorer sätter du en omvänd proxy med HTTPS framför den; `BIND_ADDRESS=0.0.0.0` publicerar porten okrypterad på alla nätverksgränssnitt, så använd det bara i ett nätverk du litar på. Använd Docker Engine 28.3.3 eller senare; äldre versioner låter andra datorer i samma nätverk nå portar som publicerats på 127.0.0.1.

### Dina värden hos Cloudflare

De tre Cloudflare-sätten använder samma värden. De står i `cloudflare.example.env`:

| Namn | Värde |
|---|---|
| `PUBLIC_HOST` | Värdnamnet som appen körs på, till exempel `letters.example.com`. Domänen måste finnas i ditt Cloudflare-konto. |
| `D1_DATABASE_NAME`, `D1_DATABASE_ID` | Namn och ID för din D1-databas. |
| `KV_SESSIONS_ID` | ID för KV-namnrymden som håller sessionerna. |
| `TURNSTILE_SITE_KEY` | Webbplatsnyckeln för en Turnstile-widget. |
| `TURNSTILE_HOSTNAMES` | Värdnamnen som widgeten får användas på, åtskilda med komma; normalt samma som `PUBLIC_HOST`. |
| `SYSTEM_FROM_ADDRESS` | Avsändaren för bekräftelse- och lösenordsmejl. |
| `SYSTEM_SMTP_HOST`, `SYSTEM_SMTP_PORT`, `SYSTEM_SMTP_USER` | Valfritt. SMTP-servern som de mejlen skickas genom; lämna tomt om du använder Resend. |
| `FEEDBACK_NOTIFY_EMAIL` | Valfritt. Dit synpunkter från användare skickas. |
| `OAUTH_GOOGLE_CLIENT_ID`, `OAUTH_MICROSOFT_CLIENT_ID` | Valfritt. Klient-ID:n som låter användare koppla ett Google- eller Microsoft-konto för e-post. |
| `THEME_KEY_PREFIX` | Namnet som temainställningen sparas under i webbläsaren, till exempel `quill`. |
| `THEME_COOKIE_DOMAIN` | Valfritt. En överordnad domän att dela temainställningen med dina andra sajter på. |
| `SITE_FAMILY` | Namnet som visas för standardtemat. |
| `DONATION_HTML` | Valfritt. HTML som visas där appen ber om stöd. |

Kommandona nedan kräver Node.js; varje steg går också att göra i Cloudflares kontrollpanel.

Gör detta en gång, före första driftsättningen. De två första kommandona skriver ut ID:n till tabellen ovan:

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

Skapa också en Turnstile-widget för `PUBLIC_HOST` i Cloudflares kontrollpanel och notera dess webbplatsnyckel och hemliga nyckel, slå på Email Routing för domänen (Workern har en `send_email`-bindning) och skapa en API-token för driftsättning från mallen "Edit Cloudflare Workers" med behörigheterna Account: D1: Edit och Account: Queues: Edit tillagda. Token är värdet för `CLOUDFLARE_API_TOKEN` nedan.

Och detta en gång, efter första driftsättningen. Varje kommando frågar efter värdet; hemligheterna ligger kvar vid senare driftsättningar:

```sh
npx wrangler secret put MAIL_CRED_KEY --name quill
```

```sh
npx wrangler secret put TURNSTILE_SECRET --name quill
```

```sh
npx wrangler secret put RESEND_API_KEY --name quill
```

`MAIL_CRED_KEY` krypterar de sparade e-postinloggningarna; skapa den med `openssl rand -base64 32`, spara en kopia och byt den aldrig. `TURNSTILE_SECRET` är widgetens hemliga nyckel. För e-post sätter du antingen `RESEND_API_KEY` eller `SYSTEM_SMTP_PASSWORD`. `OAUTH_GOOGLE_CLIENT_SECRET` och `OAUTH_MICROSOFT_CLIENT_SECRET` sätts på samma sätt om du använder dem.

Registrera dig till sist i appen och gör ditt konto till administratör:

```sh
npx wrangler d1 execute quill --remote --command "UPDATE accounts SET is_admin = 1 WHERE email = 'du@example.com'"
```

Tabellerna skapas och uppdateras av filerna i `infra/migrations` vid varje driftsättning.

### Direkt med Wrangler

```sh
cp cloudflare.example.env .cloudflare.env
```

Fyll i `.cloudflare.env` (git ignorerar alla `*.env`-filer utom exemplet), logga in en gång och driftsätt:

```sh
npx wrangler login
```

```sh
sh tools/deploy.sh .cloudflare.env
```

Kör det sista kommandot igen när du vill driftsätta en nyare version. `tools/deploy.sh` fyller i värdena i en tillfällig kopia, bygger dokumentationen till `/docs` om python3 finns, kör nya databasmigreringar, driftsätter kopian och tar bort den. Extra argument går vidare till `wrangler deploy`; `sh tools/deploy.sh .cloudflare.env --dry-run` bygger utan att röra databasen eller ladda upp något. Om `.cloudflare.env` också har raderna `CLOUDFLARE_API_TOKEN=...` och `CLOUDFLARE_ACCOUNT_ID=...` används de, och `wrangler login` behövs inte; en variabel som redan är satt i skalet går före filen.

### GitHub Actions

Forka repot, eller pusha en kopia till ditt eget konto. Fyll i `.cloudflare.env` som ovan och lägg till raderna `CLOUDFLARE_API_TOKEN=...` och `CLOUDFLARE_ACCOUNT_ID=...`. Spara sedan alla värden som hemligheter i repot med [GitHub CLI](https://cli.github.com/):

```sh
grep -v '=$' .cloudflare.env | gh secret set -f - -R ditt-konto/quill
```

Samma sak går att göra för hand under Settings → Secrets and variables → Actions. Därefter driftsätter arbetsflödet Deploy varje push till `main`, och det kan startas för hand under Actions → Deploy → Run workflow. Värdena skrivs aldrig till någon fil i repot och GitHub maskerar dem i loggarna. Utan hemligheten `CLOUDFLARE_API_TOKEN` gör arbetsflödet ingenting.

### Cloudflare Workers Builds

Skapa en Worker med namnet `quill` från ditt repo i Cloudflares kontrollpanel (Workers & Pages → Create → Import a repository) och ange:

- Deploy command: `sh tools/deploy.sh`
- Build variables and secrets: varje namn i tabellen ovan med ditt värde
- API token: den token du skapade ovan; den token som Cloudflare skapar själv kan inte köra D1-migreringar
- Settings → Build → Branch control: stäng av Enable Preview Builds

Cloudflare driftsätter sedan varje push till `main`. Använd antingen detta eller GitHub Actions, inte båda, annars driftsätts varje push två gånger.

## Utveckla

```sh
cd app
npm ci
npm test
npm run validate    # hela kontrollen före driftsättning
```

Prova lokalt utan Docker genom att rendera en kopia med dina värden och starta den:

```sh
node tools/render.mjs .cloudflare.env build
```

```sh
(cd build/app && npx wrangler d1 migrations apply DB --local && npx wrangler dev)
```

Kontaktverktygen:

```sh
cd kontakter
pip install -r requirements-dev.txt requests pypdf dnspython
python -m pytest -q
```

English: see [docs/eng/README.md](docs/eng/README.md).
