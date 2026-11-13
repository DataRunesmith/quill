import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// Node does not resolve the Worker's extensionless imports or socket binding.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:sockets")
      return nextResolve(
        "data:text/javascript,export function connect() { throw new Error('unexpected socket'); }",
      );
    if (specifier === "./rate-limiter")
      return nextResolve("data:text/javascript,export class CredentialRateLimiter {}");
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier))
        return nextResolve(`${specifier}.ts`, context);
      throw error;
    }
  },
});

const { default: app } = await import("../src/secure-index.ts");
const { getSessionContext, setAccountDisabled } = await import("../src/auth.ts");
const { hashPassword } = await import("../../shared/crypto.ts");

async function fixture() {
  const oldPassword = "old-password-123";
  const old = await hashPassword(oldPassword);
  const replacement = await hashPassword("new-password-123");
  const account: Record<string, unknown> = {
    id: "account-a",
    email: "person@example.com",
    password_hash: old.hash,
    password_salt: old.salt,
    password_set_by_user: 1,
    email_verified: 1,
    disabled: 0,
    totp_enabled: 0,
    totp_secret: null,
  };
  const values = new Map<string, string>();
  let onClear: (() => void) | undefined;
  const sessions = {
    async get(key: string) {
      return values.get(key) ?? null;
    },
    async put(key: string, value: string) {
      values.set(key, value);
    },
    async delete(key: string) {
      values.delete(key);
    },
  };
  const db = {
    withSession() {
      return this;
    },
    prepare(sql: string) {
      return {
        bind(value: string) {
          return {
            async first() {
              if (
                sql === "SELECT * FROM accounts WHERE email = ?" ||
                sql === "SELECT * FROM accounts WHERE LOWER(TRIM(email)) = LOWER(TRIM(?))"
              )
                return value === account.email ? { ...account } : null;
              if (sql === "SELECT * FROM accounts WHERE id = ?")
                return value === account.id ? { ...account } : null;
              if (sql.startsWith("SELECT account_id FROM oauth_identities"))
                return { account_id: "account-a" };
              throw new Error(`Unexpected query: ${sql}`);
            },
            async run() {
              if (sql.startsWith("UPDATE oauth_identities SET provider_email")) return {};
              throw new Error(`Unexpected update: ${sql}`);
            },
          };
        },
      };
    },
  };
  // Attempt limits live in a Durable Object; clearing them happens right after
  // a factor is verified, which is where a concurrent change is injected.
  const rateLimiter = {
    idFromName: (name: string) => name,
    get: () => ({
      async fetch(url: string) {
        if (url.endsWith("/clear-attempts") && onClear) {
          const change = onClear;
          onClear = undefined;
          change();
        }
        return Response.json({ allowed: true });
      },
    }),
  };
  const env = {
    DB: db,
    SESSIONS: sessions,
    RATE_LIMITER: rateLimiter,
    OAUTH_GOOGLE_CLIENT_ID: "test-client",
    OAUTH_GOOGLE_CLIENT_SECRET: "test-secret",
  } as unknown as import("../src/db.ts").Env;
  const context = { waitUntil() {} } as unknown as ExecutionContext;
  const request = (path: string, body: object, token?: string) =>
    app.fetch(
      new Request(`https://example.com${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://example.com",
          ...(token ? { Cookie: `session=${token}` } : {}),
        },
        body: JSON.stringify(body),
      }),
      env,
      context,
    );
  const login = async () => {
    const response = await request("/api/login", { email: account.email, password: oldPassword });
    assert.equal(response.status, 200);
    const token = response.headers.get("Set-Cookie")?.match(/session=([^;]+)/)?.[1];
    assert.ok(token);
    return token;
  };
  return {
    account,
    values,
    context,
    env,
    request,
    login,
    oldPassword,
    changePassword() {
      account.password_hash = replacement.hash;
      account.password_salt = replacement.salt;
    },
    enableTotp() {
      account.totp_enabled = 1;
      account.totp_secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    },
    changeTotp() {
      account.totp_secret = "JBSWY3DPEHPK3PXP";
    },
    onClear(change: () => void) {
      onClear = change;
    },
  };
}

test("OAuth session upgrade preserves account checks and credential revocation", async (t) => {
  const f = await fixture();
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = String(input);
    if (url.includes("token")) return Response.json({ access_token: "test-token" });
    return Response.json({
      sub: "provider-user",
      email: "person@example.com",
      email_verified: true,
    });
  });
  const callback = async () => {
    f.values.set("oauthstate:state", "1");
    return app.fetch(
      new Request("https://example.com/api/oauth/google/callback?code=code&state=state"),
      f.env,
      f.context,
    );
  };
  const response = await callback();
  assert.equal(response.status, 302);
  const token = response.headers.get("Set-Cookie")?.match(/session=([^;]+)/)?.[1];
  assert.ok(token);
  assert.ok(await getSessionContext(f.env, token));
  f.changePassword();
  assert.equal(await getSessionContext(f.env, token), null);
  f.account.disabled = 1;
  assert.equal((await callback()).status, 403);
  f.account.disabled = 0;
  f.account.id = "missing-account";
  assert.equal((await callback()).status, 403);
  assert.equal([...f.values.keys()].filter((key) => key.startsWith("session:")).length, 1);
});

async function totpCode() {
  const counter = Math.floor(Date.now() / 30_000);
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(counter));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("12345678901234567890"),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, bytes));
  const offset = mac[19] & 15;
  return String((new DataView(mac.buffer).getUint32(offset) & 0x7fffffff) % 1_000_000).padStart(
    6,
    "0",
  );
}

test("verified TOTP replacement invalidates a concurrently refreshed session", async () => {
  const f = await fixture();
  const token = await f.login();
  f.enableTotp();
  const code = await totpCode();
  const response = await f.request("/api/login", {
    email: f.account.email,
    password: f.oldPassword,
    totpCode: code,
  });
  assert.equal(response.status, 200);
  const totpToken = response.headers.get("Set-Cookie")?.match(/session=([^;]+)/)?.[1];
  assert.ok(totpToken);
  assert.equal(await getSessionContext(f.env, token), null);
  assert.ok(await getSessionContext(f.env, totpToken));
  f.onClear(f.changeTotp);
  const refreshed = await f.request(
    "/api/reauth",
    { password: f.oldPassword, totpCode: code },
    totpToken,
  );
  assert.equal(refreshed.status, 200);
  assert.equal(await getSessionContext(f.env, totpToken), null);
});

for (const change of ["changePassword", "enableTotp"] as const) {
  test(`login session is invalid if ${change} occurs after factor verification`, async () => {
    const f = await fixture();
    f.onClear(f[change]);
    const token = await f.login();
    assert.equal(await getSessionContext(f.env, token), null);
  });

  test(`reauthentication cannot refresh a session if ${change} occurs after factor verification`, async () => {
    const f = await fixture();
    const token = await f.login();
    assert.ok(await getSessionContext(f.env, token));
    f.onClear(f[change]);
    const response = await f.request("/api/reauth", { password: f.oldPassword }, token);
    assert.equal(response.status, 200);
    assert.equal(await getSessionContext(f.env, token), null);
  });
}

test("valid factors create and refresh sessions, while incorrect factors do not", async () => {
  const f = await fixture();
  const wrongLogin = await f.request("/api/login", {
    email: f.account.email,
    password: "incorrect",
  });
  assert.equal(wrongLogin.status, 400);
  const token = await f.login();
  assert.ok(await getSessionContext(f.env, token));
  const wrongReauth = await f.request("/api/reauth", { password: "incorrect" }, token);
  assert.equal(wrongReauth.status, 400);
  const response = await f.request("/api/reauth", { password: f.oldPassword }, token);
  assert.equal(response.status, 200);
  assert.ok(await getSessionContext(f.env, token));
  f.account.disabled = 1;
  assert.equal(await getSessionContext(f.env, token), null);
});

test("a session verified before a disable stays invalid after re-enabling", async () => {
  const f = await fixture();
  const token = await f.login();
  assert.ok(await getSessionContext(f.env, token));
  f.account.disabled = 1;
  f.account.security_version = 1;
  assert.equal(await getSessionContext(f.env, token), null);
  f.account.disabled = 0;
  f.account.security_version = 2;
  assert.equal(await getSessionContext(f.env, token), null);
});

test("disabling or enabling an account bumps its security version", async () => {
  const statements: string[] = [];
  const env = {
    DB: {
      prepare(sql: string) {
        statements.push(sql);
        return { bind: () => ({ run: async () => ({}) }) };
      },
    },
  } as unknown as import("../src/db.ts").Env;
  await setAccountDisabled(env, "account-a", true);
  await setAccountDisabled(env, "account-a", false);
  assert.equal(statements.length, 2);
  for (const sql of statements) assert.match(sql, /security_version = security_version \+ 1/);
});

test("sessions keep the account id under the legacy key and need both keys", async () => {
  const f = await fixture();
  const token = await f.login();
  assert.equal(f.values.get(`session:${token}`), "account-a");
  assert.ok(await getSessionContext(f.env, token));
  f.values.delete(`session:${token}`);
  assert.equal(await getSessionContext(f.env, token), null);
  const other = await f.login();
  f.values.delete(`sessionbind:${other}`);
  assert.equal(await getSessionContext(f.env, other), null);
});
