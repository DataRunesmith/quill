import {
  hashPassword,
  verifyPassword,
  randomId,
  randomVerificationCode,
  sha256Hex,
} from "../../shared/crypto";
import { sendSmtpMail } from "../../shared/smtp";
import { sendResendMail } from "../../shared/resend";
import { htmlToText } from "../../shared/html";
import { generateTotpSecret, totpAuthUri, verifyTotpCode } from "../../shared/totp";
import {
  createAccount,
  getAccountByEmail,
  getAccountById,
  verifyAccountEmail,
  deleteAccount,
  type Env,
} from "./db";
import { loginDiagnosticEvent } from "./login-diagnostic";

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 dagar
const RESET_TTL_MS = 30 * 60 * 1000; // 30 min
const TOTP_SETUP_TTL_SECONDS = 10 * 60;
const SESSION_BINDING_PREFIX = "sessionbind:";

// Resend kräver att avsändaren ligger på en verifierad domän.
// Return-Path och dess DNS-poster hanteras separat i Resend.
const SYSTEM_RESEND_FROM = "Quill <__SYSTEM_FROM_ADDRESS__>";

// Brute-force-spärrar (försök inom glidande fönster). Lösenords-/TOTP-koll
// och e-postverifiering har annars inga försöksgränser — utan detta är en
// 6-siffrig TOTP/verifieringskod gissningsbar med tillräckligt många anrop.
const LOGIN_MAX_ATTEMPTS = 10;
const LOGIN_WINDOW_SECONDS = 15 * 60;
const CODE_MAX_ATTEMPTS = 10;
const CODE_WINDOW_SECONDS = 60 * 60;

// Dummy-hash att verifiera mot när e-posten inte finns, så att en inloggning
// mot en okänd adress kostar lika mycket tid (PBKDF2) som en mot en känd —
// annars skulle svarstiden avslöja vilka adresser som är registrerade.
const DUMMY_SALT = "AAAAAAAAAAAAAAAAAAAAAA=="; // 16 nollbytes, base64
const DUMMY_HASH = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

interface SessionEnvelope {
  accountId: string;
  credentialVersion: string;
  authenticatedAt: number;
}

export interface SessionContext {
  account: Awaited<ReturnType<typeof getAccountById>>;
  authenticatedAt: number;
}

async function credentialVersion(account: Record<string, unknown>): Promise<string> {
  // Bind sessionen till de autentiseringsuppgifter som gällde när den skapades.
  // Lösenordsbyte/reset och TOTP-byte ändrar fingeravtrycket och återkallar
  // därmed alla gamla sessioner utan att KV-nycklar behöver räknas upp.
  return sha256Hex(
    [
      String(account.id ?? ""),
      String(account.password_hash ?? ""),
      String(account.password_salt ?? ""),
      String(account.totp_enabled ?? 0),
      String(account.totp_secret ?? ""),
      // Incremented on every disable/enable, so a session verified before a
      // disable cannot become valid again when the account is re-enabled.
      String(account.security_version ?? 0),
    ].join("|"),
  );
}

export async function writeSession(
  env: Env,
  sessionToken: string,
  account: Record<string, unknown>,
  authenticatedAt = Date.now(),
): Promise<void> {
  // For local authentication, this must be the snapshot whose factors were verified.
  if (account.disabled) throw new Error("Konto saknas eller är inaktiverat");
  const envelope: SessionEnvelope = {
    accountId: account.id as string,
    credentialVersion: await credentialVersion(account),
    authenticatedAt,
  };
  // `session:<token>` keeps the old format (the account id only), so an older
  // Worker version serving requests during a rollout still recognises the
  // session. The binding is stored separately and written first, so a visible
  // session always has its binding.
  await env.SESSIONS.put(`${SESSION_BINDING_PREFIX}${sessionToken}`, JSON.stringify(envelope), {
    expirationTtl: SESSION_TTL_SECONDS,
  });
  await env.SESSIONS.put(`session:${sessionToken}`, envelope.accountId, {
    expirationTtl: SESSION_TTL_SECONDS,
  });
}

export async function getSessionContext(
  env: Env,
  sessionToken: string | null,
): Promise<SessionContext | null> {
  if (!sessionToken) return null;
  const accountId = await env.SESSIONS.get(`session:${sessionToken}`);
  if (!accountId) return null;
  const raw = await env.SESSIONS.get(`${SESSION_BINDING_PREFIX}${sessionToken}`);
  // Older sessions have no binding to the current credential version and
  // cannot be verified. The security upgrade deliberately signs them out once
  // instead of keeping them alive.
  if (!raw) return null;

  let session: SessionEnvelope;
  try {
    session = JSON.parse(raw) as SessionEnvelope;
  } catch {
    return null;
  }
  // Logout deletes `session:<token>`; the binding alone is never enough.
  if (session.accountId !== accountId) return null;
  if (!session.accountId || !session.credentialVersion || !Number.isFinite(session.authenticatedAt))
    return null;

  const account = await getAccountById(env.DB, session.accountId);
  if (!account || account.disabled) return null;
  const currentVersion = await credentialVersion(account as Record<string, unknown>);
  if (currentVersion !== session.credentialVersion) return null;
  return { account, authenticatedAt: session.authenticatedAt };
}

export async function signup(
  env: Env,
  email: string,
  password: string,
): Promise<{ accountId: string; verified?: true }> {
  const existing = await getAccountByEmail(env.DB, email);
  if (existing) throw new Error("E-postadressen är redan registrerad");
  if (password.length < 10) throw new Error("Lösenordet måste vara minst 10 tecken");

  const { hash, salt } = await hashPassword(password);
  const code = randomVerificationCode();
  const accountId = await createAccount(env.DB, {
    email,
    passwordHash: hash,
    passwordSalt: salt,
    verificationCode: code,
  });

  // A self-hosted install without system e-mail cannot send the code, so the
  // account is verified directly; production always has e-mail configured.
  if (!systemMailConfigured(env)) {
    await verifyAccountEmail(env.DB, accountId, code);
    return { accountId, verified: true };
  }

  await sendSystemMail(
    env,
    email,
    "Bekräfta din e-postadress — __PUBLIC_HOST__",
    verificationEmailHtml(code),
  );

  return { accountId };
}

export async function verifyEmail(env: Env, accountId: string, code: string): Promise<void> {
  await enforceAttemptLimit(env, "verify", accountId, {
    max: CODE_MAX_ATTEMPTS,
    windowSeconds: CODE_WINDOW_SECONDS,
  });
  const ok = await verifyAccountEmail(env.DB, accountId, code);
  if (!ok) {
    throw new Error("Felaktig eller utgången kod");
  }
  await clearAttempts(env, "verify", accountId);
}

export async function login(
  env: Env,
  email: string,
  password: string,
  totpCode?: string,
): Promise<{ sessionToken: string }> {
  // Spärren gäller per e-post och räknar även försök mot icke-existerande
  // konton — annars skulle ett uteblivet lockout avslöja vilka adresser som
  // saknas. Misslyckade inloggningar (fel konto/lösenord/TOTP) räknas upp,
  // ett lyckat login nollställer.
  await enforceAttemptLimit(env, "login", email, {
    max: LOGIN_MAX_ATTEMPTS,
    windowSeconds: LOGIN_WINDOW_SECONDS,
  });

  const account = await getAccountByEmail(env.DB, email);

  // Verifiera lösenordet INNAN något kontospecifikt tillstånd avslöjas.
  // Allt som gäller ett enskilt konto (inaktiverat, overifierat) får bara
  // visas för den som redan bevisat lösenordet — annars kan felmeddelandena
  // användas för att kartlägga vilka adresser som är registrerade. Okända
  // konton verifieras mot en dummy så svarstiden blir densamma.
  const passwordOk = await verifyPassword(
    password,
    (account?.password_hash as string) ?? DUMMY_HASH,
    (account?.password_salt as string) ?? DUMMY_SALT,
  );
  const diagnostic = loginDiagnosticEvent(Boolean(account), passwordOk);
  if (diagnostic) console.info(diagnostic);
  if (!account || !passwordOk) {
    throw new Error("Fel e-post eller lösenord");
  }

  if (account.disabled)
    throw new Error("Kontot är inaktiverat — kontakta support om du tror detta är ett fel");
  if (!account.email_verified) throw new Error("E-postadressen är inte verifierad än");

  if (account.totp_enabled) {
    if (!totpCode) throw new Error("TOTP_REQUIRED");
    const validTotp = await verifyTotpCode(account.totp_secret as string, totpCode);
    if (!validTotp) {
      throw new Error("Fel TOTP-kod");
    }
  }

  await clearAttempts(env, "login", email);
  const sessionToken = randomId() + randomId();
  await writeSession(env, sessionToken, account);
  return { sessionToken };
}

export async function getAccountFromSession(env: Env, sessionToken: string | null) {
  return (await getSessionContext(env, sessionToken))?.account ?? null;
}

export async function reauthenticateAccount(
  env: Env,
  accountId: string,
  password?: string,
  totpCode?: string,
): Promise<Record<string, unknown>> {
  const account = await getAccountById(env.DB, accountId);
  if (!account || account.disabled) throw new Error("Konto saknas eller är inaktiverat");

  await enforceAttemptLimit(env, "reauth", accountId, {
    max: LOGIN_MAX_ATTEMPTS,
    windowSeconds: LOGIN_WINDOW_SECONDS,
  });

  let verifiedFactor = false;
  if (account.password_set_by_user) {
    const passwordOk = await verifyPassword(
      password ?? "",
      account.password_hash as string,
      account.password_salt as string,
    );
    if (!passwordOk) {
      throw new Error("Fel lösenord");
    }
    verifiedFactor = true;
  }

  if (account.totp_enabled) {
    if (!totpCode) throw new Error("TOTP_REQUIRED");
    const validTotp = await verifyTotpCode(account.totp_secret as string, totpCode);
    if (!validTotp) {
      throw new Error("Fel TOTP-kod");
    }
    verifiedFactor = true;
  }

  if (!verifiedFactor) throw new Error("Bekräfta kontot med ditt externa inloggningssätt");
  await clearAttempts(env, "reauth", accountId);
  return account;
}

export async function requestPasswordReset(env: Env, email: string): Promise<void> {
  const account = await getAccountByEmail(env.DB, email);
  if (!account) return; // avslöja inte om e-posten finns eller inte

  const token = randomId() + randomId();
  await env.DB.prepare("UPDATE accounts SET reset_token = ?, reset_expires_at = ? WHERE id = ?")
    .bind(token, Date.now() + RESET_TTL_MS, account.id)
    .run();

  const resetUrl = `https://__PUBLIC_HOST__/?reset=${token}`;
  await sendSystemMail(
    env,
    email,
    "Återställ ditt lösenord — __PUBLIC_HOST__",
    `<p>Klicka för att återställa ditt lösenord: <a href="${resetUrl}">${resetUrl}</a></p><p>Länken gäller i 30 minuter. Om du inte begärt detta kan du ignorera mejlet.</p>`,
  );
}

export async function resetPassword(env: Env, token: string, newPassword: string): Promise<void> {
  if (newPassword.length < 10) throw new Error("Lösenordet måste vara minst 10 tecken");

  const account = await env.DB.prepare(
    "SELECT id, email, reset_expires_at FROM accounts WHERE reset_token = ?",
  )
    .bind(token)
    .first<{ id: string; email: string; reset_expires_at: number }>();
  if (!account || Date.now() > account.reset_expires_at) {
    throw new Error("Återställningslänken är ogiltig eller har gått ut");
  }

  const { hash, salt } = await hashPassword(newPassword);

  // Nollställ inloggningsspärren FÖRE token-/lösenordsuppdateringen. När
  // lösenordet skrivs ändras sessionernas credential-fingerprint automatiskt,
  // så alla gamla sessioner blir ogiltiga vid nästa request.
  await clearAttempts(env, "login", account.email);

  await env.DB.prepare(
    "UPDATE accounts SET password_hash = ?, password_salt = ?, password_set_by_user = 1, reset_token = NULL, reset_expires_at = NULL WHERE id = ?",
  )
    .bind(hash, salt, account.id)
    .run();
}

export async function startTotpSetup(
  env: Env,
  accountId: string,
): Promise<{ secret: string; authUri: string }> {
  const account = await getAccountById(env.DB, accountId);
  if (!account) throw new Error("Konto saknas");
  const secret = generateTotpSecret();

  // Byt inte ut en aktiv TOTP-hemlighet förrän den nya koden verifierats.
  // Pending-hemligheten ligger kortlivat i KV; befintlig 2FA fortsätter gälla.
  await env.SESSIONS.put(`totp-pending:${accountId}`, secret, {
    expirationTtl: TOTP_SETUP_TTL_SECONDS,
  });
  return { secret, authUri: totpAuthUri(secret, account.email as string) };
}

export async function confirmTotpSetup(env: Env, accountId: string, code: string): Promise<void> {
  await enforceAttemptLimit(env, "totp-setup", accountId, {
    max: CODE_MAX_ATTEMPTS,
    windowSeconds: CODE_WINDOW_SECONDS,
  });
  const secret = await env.SESSIONS.get(`totp-pending:${accountId}`);
  if (!secret) throw new Error("Ingen TOTP-uppsättning pågår eller så har den gått ut");
  const valid = await verifyTotpCode(secret, code);
  if (!valid) {
    throw new Error("Fel kod — kontrollera att klockan på din enhet är rätt");
  }
  await clearAttempts(env, "totp-setup", accountId);
  await env.DB.prepare("UPDATE accounts SET totp_secret = ?, totp_enabled = 1 WHERE id = ?")
    .bind(secret, accountId)
    .run();
  await env.SESSIONS.delete(`totp-pending:${accountId}`);
}

export async function setPassword(env: Env, accountId: string, newPassword: string): Promise<void> {
  if (newPassword.length < 10) throw new Error("Lösenordet måste vara minst 10 tecken");
  const { hash, salt } = await hashPassword(newPassword);
  await env.DB.prepare(
    "UPDATE accounts SET password_hash = ?, password_salt = ?, password_set_by_user = 1 WHERE id = ?",
  )
    .bind(hash, salt, accountId)
    .run();
}

export async function disableTotp(env: Env, accountId: string): Promise<void> {
  await env.DB.prepare("UPDATE accounts SET totp_enabled = 0, totp_secret = NULL WHERE id = ?")
    .bind(accountId)
    .run();
  await env.SESSIONS.delete(`totp-pending:${accountId}`);
}

// Admin-initierad: till skillnad från requestPasswordReset (självbetjäning,
// avslöjar aldrig om kontot finns) känner admin redan till kontot, så vi
// skickar alltid länken direkt.
export async function adminResetPassword(env: Env, targetAccountId: string): Promise<void> {
  const account = await getAccountById(env.DB, targetAccountId);
  if (!account) throw new Error("Konto saknas");

  const token = randomId() + randomId();
  await env.DB.prepare("UPDATE accounts SET reset_token = ?, reset_expires_at = ? WHERE id = ?")
    .bind(token, Date.now() + RESET_TTL_MS, targetAccountId)
    .run();

  const resetUrl = `https://__PUBLIC_HOST__/?reset=${token}`;
  await sendSystemMail(
    env,
    account.email as string,
    "Återställ ditt lösenord — __PUBLIC_HOST__",
    `<p>En administratör har begärt en lösenordsåterställning åt dig. Klicka för att sätta ett nytt lösenord: <a href="${resetUrl}">${resetUrl}</a></p><p>Länken gäller i 30 minuter. Kontakta oss om du inte förväntade dig detta.</p>`,
  );
}

export async function setAccountDisabled(
  env: Env,
  targetAccountId: string,
  disabled: boolean,
): Promise<void> {
  await env.DB.prepare(
    "UPDATE accounts SET disabled = ?, security_version = security_version + 1 WHERE id = ?",
  )
    .bind(disabled ? 1 : 0, targetAccountId)
    .run();
}

// Självbetjäning: kontoinnehavaren raderar sitt EGET konto permanent. Kräver
// återautentisering — lösenord om ett sådant är satt av användaren, och TOTP
// om 2FA är aktiverat — så att en kapad men inte återautentiserad session inte
// kan radera kontot. Konton skapade enbart via OAuth (utan eget lösenord och
// utan 2FA) bekräftas av den aktiva sessionen i sig.
export async function deleteOwnAccount(
  env: Env,
  accountId: string,
  password?: string,
  totpCode?: string,
): Promise<void> {
  const account = await getAccountById(env.DB, accountId);
  if (!account) throw new Error("Konto saknas");

  // Local factors must use the same rate-limited reauthentication path as
  // other sensitive account changes. OAuth-only accounts are protected by
  // secure-index's fresh-session gate before this function is reached.
  if (account.password_set_by_user || account.totp_enabled) {
    await reauthenticateAccount(env, accountId, password, totpCode);
  }

  await deleteAccount(env, accountId);
}

// Kanalordning: Resend -> system-SMTP (iCloud). Cloudflare Email Service ingår
// inte i kedjan än; nu när send_email-bindingen släpper samma noreply-adress
// finns inget som hindrar den, men att lägga in ledet är ett eget beslut.
export function systemMailConfigured(env: Env): boolean {
  return Boolean(env.RESEND_API_KEY || env.SYSTEM_SMTP_HOST);
}

export async function sendSystemMail(
  env: Env,
  to: string,
  subject: string,
  html: string,
): Promise<void> {
  if (env.RESEND_API_KEY) {
    try {
      await sendResendMail(env.RESEND_API_KEY, {
        to,
        from: SYSTEM_RESEND_FROM,
        subject,
        html,
        text: htmlToText(html),
      });
      return;
    } catch (e) {
      console.warn(
        `systemmail: Resend misslyckades (${String(e).slice(0, 120)}), faller tillbaka på system-SMTP`,
      );
    }
  }

  await sendSmtpMail(
    {
      host: env.SYSTEM_SMTP_HOST,
      port: parseInt(env.SYSTEM_SMTP_PORT, 10),
      user: env.SYSTEM_SMTP_USER,
      password: env.SYSTEM_SMTP_PASSWORD,
      fromAddress: env.SYSTEM_FROM_ADDRESS,
    },
    { to, subject, html },
  );
}

function verificationEmailHtml(code: string): string {
  return `<p>Hej!</p><p>Din verifieringskod är: <strong>${code}</strong></p><p>Koden gäller i 30 minuter.</p>`;
}
