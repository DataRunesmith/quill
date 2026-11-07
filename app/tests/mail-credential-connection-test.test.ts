import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { assertSourceMatch, assertSourceNoMatch } from "./compact-source.ts";
import {
  testStoredSmtpCredentialWithDeps,
  updateStoredSmtpCredentialPasswordWithDeps,
  type StoredSmtpCredentialAuthConfig,
} from "../src/smtp-credential-test.ts";

const settingsSource = readFileSync(new URL("../public/app-settings.js", import.meta.url), "utf8");
const indexSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const secureIndexSource = readFileSync(new URL("../src/secure-index.ts", import.meta.url), "utf8");
const mailCredentialsSource = readFileSync(
  new URL("../src/mail-credentials.ts", import.meta.url),
  "utf8",
);

interface CredentialFixture {
  id: string;
  account_id: string;
  provider: string;
  smtp_host: string;
  smtp_port: number;
  smtp_user: string;
  encrypted_password: string;
  from_address: string;
  revoked_at: number | null;
  verified_at: number | null;
}

class FakeCredentialDb {
  readonly rows: CredentialFixture[];

  constructor(rows: CredentialFixture[]) {
    this.rows = rows;
  }

  prepare(sql: string) {
    return {
      bind: (...args: unknown[]) => ({
        first: async <T>() => {
          if (!sql.includes("FROM mail_credentials")) throw new Error("Unexpected SELECT");
          assertSourceMatch(sql, /WHERE id = \? AND account_id = \? AND revoked_at IS NULL/);
          assert.equal(args.length, 2);
          const [credentialId, accountId] = args as [string, string];
          const row = this.rows.find(
            (item) =>
              item.id === credentialId && item.account_id === accountId && item.revoked_at === null,
          );
          if (!row) return null;
          return {
            provider: row.provider,
            smtp_host: row.smtp_host,
            smtp_port: row.smtp_port,
            smtp_user: row.smtp_user,
            encrypted_password: row.encrypted_password,
            from_address: row.from_address,
          } as T;
        },
        run: async () => {
          assertSourceMatch(sql, /WHERE id = \? AND account_id = \? AND revoked_at IS NULL/);
          if (sql.startsWith("UPDATE mail_credentials SET verified_at = ?")) {
            assert.equal(args.length, 3);
            const [verifiedAt, credentialId, accountId] = args as [number, string, string];
            const row = this.rows.find(
              (item) =>
                item.id === credentialId &&
                item.account_id === accountId &&
                item.revoked_at === null,
            );
            if (row) row.verified_at = verifiedAt;
            return { meta: { changes: row ? 1 : 0 } };
          }
          if (
            sql.startsWith("UPDATE mail_credentials SET encrypted_password = ?, verified_at = ?")
          ) {
            assert.equal(args.length, 4);
            const [encryptedPassword, verifiedAt, credentialId, accountId] = args as [
              string,
              number,
              string,
              string,
            ];
            const row = this.rows.find(
              (item) =>
                item.id === credentialId &&
                item.account_id === accountId &&
                item.revoked_at === null,
            );
            if (row) {
              row.encrypted_password = encryptedPassword;
              row.verified_at = verifiedAt;
            }
            return { meta: { changes: row ? 1 : 0 } };
          }
          throw new Error("Unexpected UPDATE");
        },
      }),
    };
  }
}

function credential(overrides: Partial<CredentialFixture> = {}): CredentialFixture {
  return {
    id: "cred-1",
    account_id: "account-a",
    provider: "gmail",
    smtp_host: "smtp.gmail.com",
    smtp_port: 587,
    smtp_user: "sender@example.test",
    encrypted_password: "encrypted",
    from_address: "sender@example.test",
    revoked_at: null,
    verified_at: 100,
    ...overrides,
  };
}

test("stored SMTP accounts expose an authenticated connection test action", () => {
  assertSourceMatch(
    settingsSource,
    /c\.provider!=='microsoft_graph'.*data-action="test">Testa anslutning<\/button>/s,
  );
  assertSourceMatch(
    settingsSource,
    /\/api\/mail-credentials\/\$\{encodeURIComponent\(c\.id\)\}\/test/,
  );
  assert.ok(indexSource.includes("rx: /^\\/api\\/mail-credentials\\/([^/]+)\\/test$/"));
  assertSourceMatch(indexSource, /testStoredSmtpCredential\(c\.env,c\.accountId,m\[1\]\)/);
  assertSourceMatch(settingsSource, /data-action="password">Uppdatera lösenord<\/button>/);
  assertSourceMatch(
    settingsSource,
    /\/api\/mail-credentials\/\$\{encodeURIComponent\(c\.id\)\}\/password/,
  );
  assert.ok(indexSource.includes("rx: /^\\/api\\/mail-credentials\\/([^/]+)\\/password$/"));
});

test("stored SMTP retests and password updates require a fresh web session", () => {
  assert.ok(
    secureIndexSource.includes(
      "/^\\/api\\/mail-credentials\\/[^/]+\\/(?:test|password)$/.test(pathname)",
    ),
  );
});

test("stored SMTP tests and updates use separate per-credential Durable Object buckets", () => {
  assertSourceMatch(
    mailCredentialsSource,
    /RATE_LIMITER\.idFromName\(`smtp-\$\{purpose\}:\$\{credentialId\}`\)/,
  );
  assertSourceMatch(
    mailCredentialsSource,
    /acquireStoredSmtpTestSlot\(env, credentialId, "update"\)/,
  );
  assertSourceMatch(
    mailCredentialsSource,
    /JSON\.stringify\(\{ capacity: 1, refillPerMinute: 1 \}\)/,
  );
});

test("rate-limited stored SMTP authentication stops before secret decryption", async () => {
  const row = credential({ verified_at: 100 });
  const db = new FakeCredentialDb([row]);
  let decryptCalls = 0;
  let authCalls = 0;

  await assert.rejects(
    testStoredSmtpCredentialWithDeps(db as unknown as D1Database, "account-a", "cred-1", {
      acquireTestSlot: async () => false,
      mailCredKey: "mail-key",
      decryptSecret: async () => {
        decryptCalls++;
        return "unused";
      },
      testSmtpAuth: async () => {
        authCalls++;
      },
    }),
    /För många anslutningstester/,
  );
  assert.equal(decryptCalls, 0);
  assert.equal(authCalls, 0);
  assert.equal(row.verified_at, 100);
});

test("successful stored SMTP authentication updates verified_at afterwards", async () => {
  const row = credential();
  const db = new FakeCredentialDb([row]);
  let authConfig: StoredSmtpCredentialAuthConfig | null = null;

  const result = await testStoredSmtpCredentialWithDeps(
    db as unknown as D1Database,
    "account-a",
    "cred-1",
    {
      acquireTestSlot: async () => true,
      mailCredKey: "mail-key",
      now: () => 1234,
      decryptSecret: async (encoded, key) => {
        assert.equal(encoded, "encrypted");
        assert.equal(key, "mail-key");
        return "plain-password";
      },
      testSmtpAuth: async (config) => {
        authConfig = config;
      },
    },
  );

  assert.equal(result.verifiedAt, 1234);
  assert.equal(row.verified_at, 1234);
  assert.deepEqual(authConfig, {
    host: "smtp.gmail.com",
    port: 587,
    user: "sender@example.test",
    password: "plain-password",
    fromAddress: "sender@example.test",
  });
});

test("failed stored SMTP authentication leaves verified_at unchanged", async () => {
  const row = credential({ verified_at: 100 });
  const db = new FakeCredentialDb([row]);

  await assert.rejects(
    testStoredSmtpCredentialWithDeps(db as unknown as D1Database, "account-a", "cred-1", {
      acquireTestSlot: async () => true,
      mailCredKey: "mail-key",
      now: () => 1234,
      decryptSecret: async () => "plain-password",
      testSmtpAuth: async () => {
        throw new Error("535 5.7.8 authentication failed");
      },
    }),
    /535 5\.7\.8 authentication failed/,
  );
  assert.equal(row.verified_at, 100);
});

test("stored SMTP decryption failures are actionable account errors", async () => {
  const row = credential({ verified_at: 100 });
  const db = new FakeCredentialDb([row]);
  let authCalls = 0;
  await assert.rejects(
    testStoredSmtpCredentialWithDeps(db as unknown as D1Database, "account-a", "cred-1", {
      acquireTestSlot: async () => true,
      mailCredKey: "mail-key",
      decryptSecret: async () => {
        throw new Error("OperationError");
      },
      testSmtpAuth: async () => {
        authCalls++;
      },
    }),
    /kan inte dekrypteras.*Spara app-lösenordet på nytt/,
  );
  assert.equal(authCalls, 0);
  assert.equal(row.verified_at, 100);
});

test("stored SMTP password update authenticates before replacing encrypted state", async () => {
  const row = credential({ encrypted_password: "old-encrypted", verified_at: 100 });
  const db = new FakeCredentialDb([row]);
  let authPassword = "";
  let encryptedPlaintext = "";
  const result = await updateStoredSmtpCredentialPasswordWithDeps(
    db as unknown as D1Database,
    "account-a",
    "cred-1",
    "same-app-password",
    {
      acquireTestSlot: async () => true,
      mailCredKey: "mail-key",
      now: () => 4321,
      testSmtpAuth: async (config) => {
        authPassword = config.password;
      },
      encryptSecret: async (plaintext, key) => {
        encryptedPlaintext = plaintext;
        assert.equal(key, "mail-key");
        return "new-encrypted";
      },
    },
  );
  assert.equal(authPassword, "same-app-password");
  assert.equal(encryptedPlaintext, "same-app-password");
  assert.equal(row.encrypted_password, "new-encrypted");
  assert.equal(row.verified_at, 4321);
  assert.deepEqual(result, { verifiedAt: 4321 });
});

test("failed replacement password never overwrites the stored SMTP secret", async () => {
  const row = credential({ encrypted_password: "old-encrypted", verified_at: 100 });
  const db = new FakeCredentialDb([row]);
  let encryptCalls = 0;
  await assert.rejects(
    updateStoredSmtpCredentialPasswordWithDeps(
      db as unknown as D1Database,
      "account-a",
      "cred-1",
      "bad-password",
      {
        acquireTestSlot: async () => true,
        mailCredKey: "mail-key",
        testSmtpAuth: async () => {
          throw new Error("Inloggning misslyckades (535): authentication failed");
        },
        encryptSecret: async () => {
          encryptCalls++;
          return "must-not-be-written";
        },
      },
    ),
    /535/,
  );
  assert.equal(encryptCalls, 0);
  assert.equal(row.encrypted_password, "old-encrypted");
  assert.equal(row.verified_at, 100);
});

test("stored SMTP test fails if the credential is revoked during authentication", async () => {
  const row = credential({ verified_at: 100 });
  const db = new FakeCredentialDb([row]);

  await assert.rejects(
    testStoredSmtpCredentialWithDeps(db as unknown as D1Database, "account-a", "cred-1", {
      acquireTestSlot: async () => true,
      mailCredKey: "mail-key",
      now: () => 1234,
      decryptSecret: async () => "plain-password",
      testSmtpAuth: async () => {
        row.revoked_at = 999;
      },
    }),
    /Mailkontot ändrades under anslutningstestet/,
  );
  assert.equal(row.verified_at, 100);
});

test("stored SMTP test cannot use another account's credential", async () => {
  const row = credential({ verified_at: 100 });
  const db = new FakeCredentialDb([row]);
  let authCalls = 0;

  await assert.rejects(
    testStoredSmtpCredentialWithDeps(db as unknown as D1Database, "account-b", "cred-1", {
      acquireTestSlot: async () => true,
      mailCredKey: "mail-key",
      decryptSecret: async () => "plain-password",
      testSmtpAuth: async () => {
        authCalls++;
      },
    }),
    /Mailkonto saknas eller är borttaget/,
  );
  assert.equal(authCalls, 0);
  assert.equal(row.verified_at, 100);
});

test("stored SMTP test rejects revoked credentials without changing verified_at", async () => {
  const row = credential({ revoked_at: 99, verified_at: 100 });
  const db = new FakeCredentialDb([row]);
  let authCalls = 0;

  await assert.rejects(
    testStoredSmtpCredentialWithDeps(db as unknown as D1Database, "account-a", "cred-1", {
      acquireTestSlot: async () => true,
      mailCredKey: "mail-key",
      decryptSecret: async () => "plain-password",
      testSmtpAuth: async () => {
        authCalls++;
      },
    }),
    /Mailkonto saknas eller är borttaget/,
  );
  assert.equal(authCalls, 0);
  assert.equal(row.verified_at, 100);
});

test("Microsoft Graph credentials are not sent through the SMTP test path", async () => {
  const row = credential({ provider: "microsoft_graph" });
  const db = new FakeCredentialDb([row]);
  await assert.rejects(
    testStoredSmtpCredentialWithDeps(db as unknown as D1Database, "account-a", "cred-1", {
      acquireTestSlot: async () => true,
      mailCredKey: "mail-key",
      decryptSecret: async () => "plain-password",
      testSmtpAuth: async () => {},
    }),
    /endast SMTP-konton/,
  );
  assertSourceMatch(settingsSource, /c\.provider!=='microsoft_graph'/);
});
