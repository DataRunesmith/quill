const STORED_SMTP_PASSWORD_DECRYPTION_ERROR =
  "Det sparade SMTP-lösenordet kan inte dekrypteras. Spara app-lösenordet på nytt under Inställningar → Mail.";

export interface StoredSmtpCredentialAuthConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  fromAddress: string;
}

interface StoredSmtpCredentialBaseDeps {
  acquireTestSlot: () => Promise<boolean>;
  testSmtpAuth: (config: StoredSmtpCredentialAuthConfig) => Promise<void>;
  mailCredKey: string;
  now?: () => number;
}

export interface StoredSmtpCredentialTestDeps extends StoredSmtpCredentialBaseDeps {
  decryptSecret: (encoded: string, base64Key: string) => Promise<string>;
}

export interface StoredSmtpCredentialPasswordUpdateDeps extends StoredSmtpCredentialBaseDeps {
  encryptSecret: (plaintext: string, base64Key: string) => Promise<string>;
}

interface StoredSmtpCredentialRow {
  provider: string;
  smtp_host: string;
  smtp_port: number;
  smtp_user: string;
  encrypted_password: string;
  from_address: string;
}

async function loadStoredSmtpCredential(
  db: D1Database,
  accountId: string,
  credentialId: string,
): Promise<StoredSmtpCredentialRow> {
  const credential = await db
    .prepare(
      `SELECT provider, smtp_host, smtp_port, smtp_user, encrypted_password, from_address
     FROM mail_credentials
     WHERE id = ? AND account_id = ? AND revoked_at IS NULL`,
    )
    .bind(credentialId, accountId)
    .first<StoredSmtpCredentialRow>();
  if (!credential) throw new Error("Mailkonto saknas eller är borttaget");
  if (credential.provider === "microsoft_graph")
    throw new Error("Åtgärden gäller endast SMTP-konton");
  return credential;
}

function authConfig(
  credential: StoredSmtpCredentialRow,
  password: string,
): StoredSmtpCredentialAuthConfig {
  return {
    host: credential.smtp_host,
    port: credential.smtp_port,
    user: credential.smtp_user,
    password,
    fromAddress: credential.from_address,
  };
}

export async function testStoredSmtpCredentialWithDeps(
  db: D1Database,
  accountId: string,
  credentialId: string,
  deps: StoredSmtpCredentialTestDeps,
): Promise<{ verifiedAt: number }> {
  const credential = await loadStoredSmtpCredential(db, accountId, credentialId);
  if (!(await deps.acquireTestSlot()))
    throw new Error("För många anslutningstester — vänta en minut och försök igen");

  let password: string;
  try {
    password = await deps.decryptSecret(credential.encrypted_password, deps.mailCredKey);
  } catch {
    throw new Error(STORED_SMTP_PASSWORD_DECRYPTION_ERROR);
  }
  await deps.testSmtpAuth(authConfig(credential, password));

  const verifiedAt = (deps.now ?? Date.now)();
  const update = await db
    .prepare(
      "UPDATE mail_credentials SET verified_at = ? WHERE id = ? AND account_id = ? AND revoked_at IS NULL",
    )
    .bind(verifiedAt, credentialId, accountId)
    .run();
  if ((update.meta.changes ?? 0) < 1)
    throw new Error("Mailkontot ändrades under anslutningstestet");
  return { verifiedAt };
}

export async function updateStoredSmtpCredentialPasswordWithDeps(
  db: D1Database,
  accountId: string,
  credentialId: string,
  password: string,
  deps: StoredSmtpCredentialPasswordUpdateDeps,
): Promise<{ verifiedAt: number }> {
  if (typeof password !== "string" || !password || password.length > 4096)
    throw new Error("Ogiltigt SMTP-lösenord");
  const credential = await loadStoredSmtpCredential(db, accountId, credentialId);
  if (!(await deps.acquireTestSlot()))
    throw new Error("För många lösenordstester — vänta en minut och försök igen");

  await deps.testSmtpAuth(authConfig(credential, password));
  const encryptedPassword = await deps.encryptSecret(password, deps.mailCredKey);
  const verifiedAt = (deps.now ?? Date.now)();
  const update = await db
    .prepare(
      "UPDATE mail_credentials SET encrypted_password = ?, verified_at = ? WHERE id = ? AND account_id = ? AND revoked_at IS NULL",
    )
    .bind(encryptedPassword, verifiedAt, credentialId, accountId)
    .run();
  if ((update.meta.changes ?? 0) < 1)
    throw new Error("Mailkontot ändrades under lösenordsuppdateringen");
  return { verifiedAt };
}
