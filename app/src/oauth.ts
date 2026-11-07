import { randomId, hashPassword } from "../../shared/crypto";
import type { Env } from "./db";

interface ProviderConfig {
  authorizeUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  scope: string;
  clientIdEnvKey: keyof Env;
  clientSecretEnvKey: keyof Env;
}

// Webbinloggning stöds bara för de providers som fortfarande är konfigurerade
// i Workern. GitHub-login och manuell kontolänkning är avvecklade.
const PROVIDERS: Record<string, ProviderConfig> = {
  google: {
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    userinfoUrl: "https://www.googleapis.com/oauth2/v3/userinfo",
    scope: "openid email profile",
    clientIdEnvKey: "OAUTH_GOOGLE_CLIENT_ID",
    clientSecretEnvKey: "OAUTH_GOOGLE_CLIENT_SECRET",
  },
  microsoft: {
    authorizeUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    userinfoUrl: "https://graph.microsoft.com/oidc/userinfo",
    scope: "openid email profile",
    clientIdEnvKey: "OAUTH_MICROSOFT_CLIENT_ID",
    clientSecretEnvKey: "OAUTH_MICROSOFT_CLIENT_SECRET",
  },
};

const REDIRECT_BASE = "https://__PUBLIC_HOST__/api/oauth";

function normalizeEmail(email: string): string {
  return email.trim().toLocaleLowerCase("sv-SE");
}

export function getAuthorizeUrl(provider: string, env: Env, state: string): string {
  const cfg = PROVIDERS[provider];
  if (!cfg) throw new Error("Okänd eller avvecklad inloggningsleverantör");
  const clientId = env[cfg.clientIdEnvKey] as string | undefined;
  if (!clientId) throw new Error(`${provider}-inloggning är inte konfigurerad än`);

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${REDIRECT_BASE}/${provider}/callback`,
    response_type: "code",
    scope: cfg.scope,
    state,
  });
  return `${cfg.authorizeUrl}?${params.toString()}`;
}

async function exchangeCodeForUserInfo(
  provider: string,
  env: Env,
  code: string,
): Promise<{ providerUserId: string; email: string }> {
  const cfg = PROVIDERS[provider];
  if (!cfg) throw new Error("Okänd eller avvecklad inloggningsleverantör");
  const clientId = env[cfg.clientIdEnvKey] as string | undefined;
  const clientSecret = env[cfg.clientSecretEnvKey] as string | undefined;
  if (!clientId || !clientSecret) throw new Error(`${provider}-inloggning är inte konfigurerad än`);

  const redirectUri = `${REDIRECT_BASE}/${provider}/callback`;
  const tokenResp = await fetch(cfg.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenResp.ok) throw new Error(`Kunde inte hämta access token från ${provider}`);
  const tokenData = await tokenResp.json<{ access_token: string }>();

  const userResp = await fetch(cfg.userinfoUrl, {
    headers: { Authorization: `Bearer ${tokenData.access_token}`, "User-Agent": "quill" },
  });
  if (!userResp.ok) throw new Error(`Kunde inte hämta användarinfo från ${provider}`);
  const userData = await userResp.json<Record<string, unknown>>();

  const providerUserId = String(userData.sub ?? userData.id);
  const rawEmail = (userData.email as string | undefined) ?? null;
  if (!rawEmail) throw new Error(`Kunde inte hämta en e-postadress från ${provider}`);
  if (provider === "google" && userData.email_verified !== true) {
    throw new Error("Google-kontots e-postadress är inte verifierad");
  }
  return { providerUserId, email: normalizeEmail(rawEmail) };
}

export async function handleOAuthCallback(
  provider: string,
  env: Env,
  code: string,
): Promise<{ accountId: string }> {
  const { providerUserId, email } = await exchangeCodeForUserInfo(provider, env, code);

  const existingIdentity = await env.DB.prepare(
    "SELECT account_id FROM oauth_identities WHERE provider = ? AND provider_user_id = ?",
  )
    .bind(provider, providerUserId)
    .first<{ account_id: string }>();
  if (existingIdentity) {
    await env.DB.prepare(
      "UPDATE oauth_identities SET provider_email = ? WHERE provider = ? AND provider_user_id = ?",
    )
      .bind(email, provider, providerUserId)
      .run();
    return { accountId: existingIdentity.account_id };
  }

  // Samma verifierade e-postadress är samma Quill-konto. En ny
  // Google/Microsoft-identitet ska därför återanvända befintligt accounts.id,
  // inte skapa en parallell kontorad.
  const existingAccount = await env.DB.prepare(
    "SELECT * FROM accounts WHERE LOWER(TRIM(email)) = LOWER(TRIM(?)) LIMIT 1",
  )
    .bind(email)
    .first<Record<string, unknown>>();
  if (existingAccount) {
    const accountId = existingAccount.id as string;
    const providerAlreadyLinked = await env.DB.prepare(
      "SELECT provider_user_id FROM oauth_identities WHERE account_id = ? AND provider = ?",
    )
      .bind(accountId, provider)
      .first<{ provider_user_id: string }>();
    if (providerAlreadyLinked && providerAlreadyLinked.provider_user_id !== providerUserId) {
      throw new Error(`Kontot har redan ett annat ${provider}-inloggningssätt kopplat`);
    }
    if (!providerAlreadyLinked) {
      await env.DB.prepare(
        "INSERT INTO oauth_identities (id, account_id, provider, provider_user_id, provider_email, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
        .bind(randomId(), accountId, provider, providerUserId, email, Date.now())
        .run();
    }
    if (!existingAccount.email_verified) {
      await env.DB.prepare("UPDATE accounts SET email_verified = 1 WHERE id = ?")
        .bind(accountId)
        .run();
    }
    return { accountId };
  }

  // Första inloggningen med Google/Microsoft får skapa kontot. Ett slumpat
  // internt lösenord används tills användaren själv väljer att sätta ett.
  const accountId = randomId();
  const { hash, salt } = await hashPassword(randomId() + randomId());
  await env.DB.prepare(
    `INSERT INTO accounts (id, email, password_hash, password_salt, email_verified, daily_send_cap, created_at)
     VALUES (?, ?, ?, ?, 1, 200, ?)`,
  )
    .bind(accountId, email, hash, salt, Date.now())
    .run();

  await env.DB.prepare(
    "INSERT INTO oauth_identities (id, account_id, provider, provider_user_id, provider_email, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(randomId(), accountId, provider, providerUserId, email, Date.now())
    .run();

  return { accountId };
}

export interface OAuthIdentitySummary {
  provider: string;
  provider_email: string | null;
  created_at: number;
}

export async function getOAuthIdentities(
  env: Env,
  accountId: string,
): Promise<OAuthIdentitySummary[]> {
  const { results } = await env.DB.prepare(
    "SELECT provider, provider_email, created_at FROM oauth_identities WHERE account_id = ? AND provider IN ('google','microsoft') ORDER BY created_at ASC",
  )
    .bind(accountId)
    .all<OAuthIdentitySummary>();
  return results;
}

export async function unlinkOAuthIdentity(
  env: Env,
  accountId: string,
  provider: string,
): Promise<void> {
  if (!(provider in PROVIDERS)) throw new Error("Okänd eller avvecklad inloggningsleverantör");

  const account = await env.DB.prepare("SELECT password_set_by_user FROM accounts WHERE id = ?")
    .bind(accountId)
    .first<{ password_set_by_user: number }>();
  const identities = await getOAuthIdentities(env, accountId);
  const hasUsablePassword = !!account?.password_set_by_user;
  const targetExists = identities.some((identity) => identity.provider === provider);
  if (!targetExists) return;

  if (!hasUsablePassword && identities.length <= 1) {
    throw new Error(
      "Det här är ditt enda inloggningssätt — sätt ett lösenord eller lägg till ett annat inloggningssätt innan du kopplar bort det",
    );
  }

  await env.DB.prepare("DELETE FROM oauth_identities WHERE account_id = ? AND provider = ?")
    .bind(accountId, provider)
    .run();
}

// Kompatibilitetsexporter för gamla manuella länk-routes i index.ts. De ska inte
// användas av UI:t; Google/Microsoft kopplas automatiskt vid vanlig inloggning.
export function providerSharesLoginCallback(_provider: string): boolean {
  return false;
}
export function getLinkAuthorizeUrl(_provider: string, _env: Env, _state: string): string {
  throw new Error("Manuell kontolänkning är borttagen");
}
export async function handleOAuthLinkCallback(
  _provider: string,
  _env: Env,
  _code: string,
  _currentAccountId: string,
): Promise<void> {
  throw new Error("Manuell kontolänkning är borttagen");
}
