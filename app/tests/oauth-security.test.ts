import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const oauthSource = readFileSync(new URL("../src/oauth.ts", import.meta.url), "utf8");
const indexSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const settingsSource = readFileSync(new URL("../public/app-settings.js", import.meta.url), "utf8");

test("Microsoft email claims cannot auto-link or verify Quill accounts", () => {
  assert.match(oauthSource, /provider !== "google" \|\| !email/);
  assert.match(oauthSource, /userData\.email_verified !== true/);
  assert.match(oauthSource, /Microsoft-e-postadresser kan inte användas för automatisk kontokoppling/);
});

test("external identities can only be linked to the currently authenticated account", () => {
  assert.match(oauthSource, /existingIdentity\.account_id !== currentAccountId/);
  assert.match(oauthSource, /Object\.hasOwn\(PROVIDERS, provider\)/);
  assert.match(indexSource, /oauthstate:\$\{state\}.*link:/s);
  assert.match(indexSource, /account\.id as string\) !== linkAccountId/);
  assert.match(indexSource, /req\.method !== "POST"/);
  assert.match(settingsSource, /api\(\`\/api\/oauth-link\/\$\{provider\}\/start\`, \{ method: "POST" \}\)/);
});

