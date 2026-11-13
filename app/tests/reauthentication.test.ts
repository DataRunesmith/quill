import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { assertSourceMatch, assertSourceNoMatch } from "./compact-source.ts";

const appSource = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const authSource = readFileSync(new URL("../src/auth.ts", import.meta.url), "utf8");
const indexSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const secureIndexSource = readFileSync(new URL("../src/secure-index.ts", import.meta.url), "utf8");

test("reauthentication verifies account factors before refreshing the same session", () => {
  assertSourceMatch(authSource, /export async function reauthenticateAccount/);
  assertSourceMatch(authSource, /enforceAttemptLimit\(env, "reauth", accountId/);
  assertSourceMatch(authSource, /verifyPassword\(password \?\? "", account\.password_hash/);
  assertSourceMatch(authSource, /if \(account\.totp_enabled\)/);
  assertSourceMatch(authSource, /verifyTotpCode\(account\.totp_secret as string, totpCode\)/);
  assertSourceMatch(
    authSource,
    /if \(!verifiedFactor\) throw new Error\("Bekräfta kontot med ditt externa inloggningssätt"\)/,
  );
  assertSourceMatch(indexSource, /rx: \/\^\\\/api\\\/reauth\$\//);
  assertSourceMatch(
    indexSource,
    /reauthenticateAccount\(c\.env, c\.accountId, password, totpCode\)/,
  );
  assertSourceMatch(indexSource, /writeSession\(c\.env, c\.sessionToken, account\)/);
});

test("fresh-auth gate returns a machine-readable challenge instead of demanding logout", () => {
  assertSourceMatch(secureIndexSource, /code: "FRESH_AUTH_REQUIRED"/);
  assertSourceNoMatch(
    secureIndexSource,
    /Logga ut och in igen innan du ändrar kontots säkerhetsinställningar/,
  );
  assertSourceMatch(indexSource, /passwordSetByUser:!!account\.password_set_by_user/);
});

test("browser reauthenticates in place and retries the original sensitive request", () => {
  assertSourceMatch(appSource, /err\.code!=='FRESH_AUTH_REQUIRED'/);
  assertSourceMatch(appSource, /await ensureFreshAuthentication\(\);return rawApi\(path,opts\)/);
  assertSourceMatch(appSource, /rawApi\('\/api\/reauth'/);
  assertSourceMatch(appSource, /Bekräfta att det är du/);
  assertSourceMatch(appSource, /Du stannar kvar på samma sida/);
  assertSourceMatch(appSource, /autocomplete="current-password"/);
  assertSourceMatch(appSource, /autocomplete="one-time-code"/);
});

test("OAuth-only sessions use a linked identity instead of silently extending freshness", () => {
  assertSourceMatch(
    appSource,
    /if\(!state\.me\.passwordSetByUser&&!state\.me\.totpEnabled\)return externalReauthentication\(\)/,
  );
  assertSourceMatch(appSource, /rawApi\('\/api\/oauth-identities'\)/);
  assertSourceMatch(appSource, /Du behöver inte logga ut/);
  assertSourceMatch(appSource, /pending:route/);
});

test("account deletion requires a fresh web session and cookie mutations fail closed without same-origin Origin", () => {
  assert.ok(secureIndexSource.includes('"/api/delete-account"'));
  assertSourceMatch(authSource, /if \(account\.password_set_by_user \|\| account\.totp_enabled\) \{\s*await reauthenticateAccount\(env, accountId, password, totpCode\)/);
  assertSourceMatch(secureIndexSource, /return req\.headers\.get\("Origin"\) !== url\.origin/);
  assertSourceMatch(secureIndexSource, /requestBodyExceedsLimit\(req, requestBodyLimit\(url\.pathname\)\)/);
});

test("authentication attempt limits are atomic and fail closed through Durable Objects", () => {
  const limiterSource = readFileSync(new URL("../src/rate-limiter.ts", import.meta.url), "utf8");
  const rateLimitSource = readFileSync(new URL("../src/rate-limit.ts", import.meta.url), "utf8");
  assertSourceMatch(rateLimitSource, /RATE_LIMITER\.idFromName\(\`auth-attempt:/);
  assertSourceMatch(rateLimitSource, /\/attempt/);
  assertSourceMatch(limiterSource, /pathname === "\/attempt"/);
  assertSourceMatch(limiterSource, /count \+ 1/);
  assertSourceMatch(authSource, /enforceAttemptLimit\(env, "reauth", accountId/);
});
