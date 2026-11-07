import { decryptSecret, encryptSecret, randomId } from "../../shared/crypto";
import { assertNoControlCharacters, validateMailboxAddress } from "../../shared/input-safety";
import { testSmtpAuth } from "../../shared/smtp";
import {
  testStoredSmtpCredentialWithDeps,
  updateStoredSmtpCredentialPasswordWithDeps,
} from "./smtp-credential-test";
import { exchangeMicrosoftMailCode } from "../../shared/graph-mail";
import type { Env } from "./db";

export const MICROSOFT_GRAPH_DAILY_LIMIT = 300;
export const HARDCODED_CEILING_PCT = 0.9;

export const PROVIDER_PRESETS: Record<
  string,
  { host: string; port: number; helpUrl: string; providerDailyLimit: number | null }
> = {
  gmail: {
    host: "smtp.gmail.com",
    port: 587,
    helpUrl: "https://myaccount.google.com/apppasswords",
    providerDailyLimit: 100,
  },
  outlook: {
    host: "smtp.office365.com",
    port: 587,
    helpUrl: "https://account.live.com/proofs/AppPassword",
    providerDailyLimit: 300,
  },
  icloud: {
    host: "smtp.mail.me.com",
    port: 587,
    helpUrl: "https://appleid.apple.com/account/manage",
    providerDailyLimit: 1000,
  },
  yahoo: {
    host: "smtp.mail.yahoo.com",
    port: 587,
    helpUrl: "https://login.yahoo.com/account/security",
    providerDailyLimit: 500,
  },
  generic: { host: "", port: 587, helpUrl: "", providerDailyLimit: null },
};

const ALLOWED_GENERIC_SMTP_PORTS = new Set([465, 587]);
const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa", ".lan"];

function validateGenericSmtpEndpoint(
  hostInput: string | undefined,
  portInput: number | undefined,
): { host: string; port: number } {
  const host = (hostInput ?? "").trim().toLowerCase().replace(/\.$/, "");
  const port = Number(portInput);
  if (!ALLOWED_GENERIC_SMTP_PORTS.has(port))
    throw new Error("Generisk SMTP tillåter bara port 465 eller 587");
  if (!host || host.length > 253) throw new Error("Ogiltigt SMTP-värdnamn");
  if (
    host === "localhost" ||
    host === "metadata.google.internal" ||
    BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))
  ) {
    throw new Error("Lokala eller interna SMTP-värdar är inte tillåtna");
  }
  if (/^\[.*\]$/.test(host) || host.includes(":") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
    throw new Error("Ange ett publikt DNS-namn för SMTP-servern, inte en IP-adress");
  }
  if (
    !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
      host,
    )
  ) {
    throw new Error("Ogiltigt publikt SMTP-värdnamn");
  }
  return { host, port };
}

export function getCeiling(provider: string): number | null {
  const limit =
    provider === "microsoft_graph"
      ? MICROSOFT_GRAPH_DAILY_LIMIT
      : PROVIDER_PRESETS[provider]?.providerDailyLimit;
  if (limit === null || limit === undefined) return null;
  return Math.floor(limit * HARDCODED_CEILING_PCT);
}

export function computeDailyCap(provider: string, userCapPct: number): number | null {
  const ceiling = getCeiling(provider);
  if (ceiling === null) return null;
  const pct = Math.min(100, Math.max(1, Math.round(userCapPct)));
  return Math.max(1, Math.floor(ceiling * (pct / 100)));
}

export async function addMailCredential(
  env: Env,
  accountId: string,
  input: {
    provider: string;
    host?: string;
    port?: number;
    user: string;
    password: string;
    fromAddress: string;
    userCapPct?: number;
  },
): Promise<{ id: string; dailyCap: number | null }> {
  const preset = PROVIDER_PRESETS[input.provider];
  if (!preset) throw new Error("Okänd leverantör");

  let host: string;
  let port: number;
  if (input.provider === "generic")
    ({ host, port } = validateGenericSmtpEndpoint(input.host, input.port));
  else {
    host = preset.host;
    port = preset.port;
  }

  const user = assertNoControlCharacters(input.user ?? "", "SMTP-användarnamn");
  if (user.length > 320) throw new Error("Ogiltigt SMTP-användarnamn");
  const fromAddress = validateMailboxAddress(input.fromAddress ?? "", "avsändaradress");
  if (!input.password || input.password.length > 4096) throw new Error("Ogiltigt SMTP-lösenord");

  await testSmtpAuth({ host, port, user, password: input.password, fromAddress });

  const id = randomId();
  const encryptedPassword = await encryptSecret(input.password, env.MAIL_CRED_KEY);
  const userCapPct = input.userCapPct ?? 100;
  const dailyCap = computeDailyCap(input.provider, userCapPct);
  await env.DB.prepare(
    `INSERT INTO mail_credentials (id, account_id, provider, smtp_host, smtp_port, smtp_user, encrypted_password, from_address, verified_at, daily_cap, user_cap_pct, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      accountId,
      input.provider,
      host,
      port,
      user,
      encryptedPassword,
      fromAddress,
      Date.now(),
      dailyCap,
      userCapPct,
      Date.now(),
    )
    .run();
  return { id, dailyCap };
}

export async function addMicrosoftGraphMailCredential(
  env: Env,
  accountId: string,
  code: string,
): Promise<{ id: string }> {
  const tokens = await exchangeMicrosoftMailCode(
    env.OAUTH_MICROSOFT_CLIENT_ID!,
    env.OAUTH_MICROSOFT_CLIENT_SECRET!,
    code,
  );
  const email = validateMailboxAddress(tokens.email, "Microsoft-kontots e-postadress");
  const id = randomId();
  const encryptedAccessToken = await encryptSecret(tokens.accessToken, env.MAIL_CRED_KEY);
  const encryptedRefreshToken = await encryptSecret(tokens.refreshToken, env.MAIL_CRED_KEY);
  const dailyCap = computeDailyCap("microsoft_graph", 100);
  await env.DB.prepare(
    `INSERT INTO mail_credentials
       (id, account_id, provider, smtp_host, smtp_port, smtp_user, encrypted_password, from_address, verified_at, daily_cap, user_cap_pct, oauth_access_token, oauth_refresh_token, oauth_token_expires_at, created_at)
     VALUES (?, ?, 'microsoft_graph', 'oauth', 0, ?, '', ?, ?, ?, 100, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      accountId,
      email,
      email,
      Date.now(),
      dailyCap,
      encryptedAccessToken,
      encryptedRefreshToken,
      tokens.expiresAt,
      Date.now(),
    )
    .run();
  return { id };
}

export async function updateMailCredentialCapPct(
  env: Env,
  accountId: string,
  credentialId: string,
  userCapPct: number,
): Promise<{ dailyCap: number | null }> {
  const cred = await env.DB.prepare(
    "SELECT provider FROM mail_credentials WHERE id = ? AND account_id = ? AND revoked_at IS NULL",
  )
    .bind(credentialId, accountId)
    .first<{ provider: string }>();
  if (!cred) throw new Error("Mailkonto saknas eller är borttaget");
  const dailyCap = computeDailyCap(cred.provider, userCapPct);
  await env.DB.prepare(
    "UPDATE mail_credentials SET user_cap_pct = ?, daily_cap = ? WHERE id = ? AND account_id = ? AND revoked_at IS NULL",
  )
    .bind(Math.min(100, Math.max(1, Math.round(userCapPct))), dailyCap, credentialId, accountId)
    .run();
  return { dailyCap };
}

export async function listMailCredentials(env: Env, accountId: string) {
  const { results } = await env.DB.prepare(
    `SELECT id, provider, smtp_host, smtp_port, from_address, verified_at, daily_cap, user_cap_pct, created_at
     FROM mail_credentials WHERE account_id = ? AND revoked_at IS NULL ORDER BY created_at DESC`,
  )
    .bind(accountId)
    .all();
  return results;
}

async function acquireStoredSmtpTestSlot(
  env: Env,
  credentialId: string,
  purpose = "test",
): Promise<boolean> {
  const id = env.RATE_LIMITER.idFromName(`smtp-${purpose}:${credentialId}`);
  try {
    const response = await env.RATE_LIMITER.get(id).fetch("https://rate-limiter/acquire", {
      method: "POST",
      body: JSON.stringify({ capacity: 1, refillPerMinute: 1 }),
    });
    const result = await response.json<{ granted?: boolean }>();
    return result.granted === true;
  } catch {
    return false;
  }
}

/**
 * Testar autentisering med ett sparat SMTP-konto utan att skicka e-post.
 *
 * Testet använder en separat serialiserad rate-limit-bucket per credential,
 * dekrypterar lösenordet endast efter beviljad slot och uppdaterar
 * `verified_at` först efter lyckad SMTP-autentisering.
 *
 * @param env - Worker-miljön med D1, Durable Object-rate-limiter och MAIL_CRED_KEY.
 * @param accountId - Det autentiserade konto som måste äga credentialen.
 * @param credentialId - Identifieraren för det lagrade SMTP-kontot.
 * @returns Verifieringstidpunkten efter lyckad autentisering och D1-uppdatering.
 * @throws Om credentialen saknas, är återkallad, använder Microsoft Graph,
 * rate-limit nekas, dekryptering/SMTP-test misslyckas eller credentialen ändras under testet.
 */
export async function testStoredSmtpCredential(
  env: Env,
  accountId: string,
  credentialId: string,
): Promise<{ verifiedAt: number }> {
  return testStoredSmtpCredentialWithDeps(env.DB, accountId, credentialId, {
    acquireTestSlot: () => acquireStoredSmtpTestSlot(env, credentialId),
    decryptSecret,
    testSmtpAuth,
    mailCredKey: env.MAIL_CRED_KEY,
  });
}

export async function updateStoredSmtpCredentialPassword(
  env: Env,
  accountId: string,
  credentialId: string,
  password: string,
): Promise<{ verifiedAt: number }> {
  return updateStoredSmtpCredentialPasswordWithDeps(env.DB, accountId, credentialId, password, {
    acquireTestSlot: () => acquireStoredSmtpTestSlot(env, credentialId, "update"),
    encryptSecret,
    testSmtpAuth,
    mailCredKey: env.MAIL_CRED_KEY,
  });
}

export async function deleteMailCredential(
  env: Env,
  accountId: string,
  credentialId: string,
): Promise<void> {
  const credential = await env.DB.prepare(
    "SELECT id FROM mail_credentials WHERE id = ? AND account_id = ? AND revoked_at IS NULL",
  )
    .bind(credentialId, accountId)
    .first<{ id: string }>();
  if (!credential) return;
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE send_jobs SET status = 'cancelled', finished_at = ? WHERE account_id = ? AND mail_credential_id = ? AND status IN ('pending', 'sending')`,
    ).bind(now, accountId, credentialId),
    env.DB.prepare(
      `UPDATE send_job_recipients SET status = 'cancelled', queued_at = NULL, finished_at = ? WHERE send_job_id IN (SELECT id FROM send_jobs WHERE account_id = ? AND mail_credential_id = ?) AND status IN ('pending', 'queued')`,
    ).bind(now, accountId, credentialId),
    env.DB.prepare(
      `UPDATE mail_credentials SET encrypted_password = '', oauth_access_token = NULL, oauth_refresh_token = NULL, oauth_token_expires_at = NULL, revoked_at = ? WHERE id = ? AND account_id = ? AND revoked_at IS NULL`,
    ).bind(now, credentialId, accountId),
  ]);
}
