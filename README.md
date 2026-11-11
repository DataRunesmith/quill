# Quill

Ett webbverktyg för att skriva brev till politiker, myndigheter och redaktioner från sitt eget e-postkonto. Brev skickas via SMTP, Microsoft Graph eller Resend, och uppgifter om mottagare och inloggningar krypteras.

Appen är en Cloudflare Worker (i `app/`) med D1, KV, R2, köer och Durable Objects. Alla inställningar är platshållare av typen `__NAMN__`. I `kontakter/` finns Python-verktyg som underhåller kontaktregistret.

## Kom igång

```sh
cd app
npm install
npm test
npm run validate    # hela kontrollen före distribution
```

Kör en egen kopia:

```sh
cp cloudflare.example.env mina-värden.env
node tools/render.mjs mina-värden.env build
(cd build/app && npx wrangler dev)
```

Hemligheter, till exempel `MAIL_CRED_KEY`, läggs inte i värdefilen utan sätts med `wrangler secret put` eller som miljövariabler i containern. Databasen skapas av filerna i `infra/migrations`.

`docker/entrypoint.sh` renderar och startar appen från miljövariabler i en container, med data i `/data`. Första administratören skapas en gång från `ADMIN_EMAIL` och `ADMIN_PASSWORD` (minst 12 tecken). Sätt båda som container-hemligheter. Bootstrap skapar bara ett nytt konto om adressen inte redan finns; ett befintligt konto upphöjs aldrig automatiskt till administratör.

Kontaktverktygen:

```sh
cd kontakter
pip install -r requirements-dev.txt requests pypdf dnspython
python -m pytest -q
```

English: see [docs/eng/README.md](docs/eng/README.md).
