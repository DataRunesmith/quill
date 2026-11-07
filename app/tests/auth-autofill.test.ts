import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { assertSourceMatch, assertSourceNoMatch } from "./compact-source.ts";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const script = readFileSync(new URL("../public/auth-autofill.js", import.meta.url), "utf8");

test("loads the Safari autofill helper after the main app", () => {
  const appIndex = html.indexOf('<script src="/app.js" defer></script>');
  const helperIndex = html.indexOf('<script src="/auth-autofill.js" defer></script>');
  assert.ok(appIndex >= 0, "main app script must be loaded");
  assert.ok(helperIndex > appIndex, "autofill helper must load after app.js");
});

test("submits only when both login credentials were browser-autofilled", () => {
  assertSourceMatch(script, /input\.matches\(':autofill'\)/);
  assertSourceMatch(script, /input\.matches\(':-webkit-autofill'\)/);
  assertSourceMatch(script, /if\(!email\.value\|\|!password\.value\)return;/);
  assertSourceMatch(script, /if\(!isAutofilled\(email\)\|\|!isAutofilled\(password\)\)return;/);
  assertSourceMatch(script, /form\.requestSubmit\(\);/);
});

test("stops automatic retries once 2FA is visible or the autofill login was submitted", () => {
  assertSourceMatch(script, /if\(autoSubmitted\|\|!totpRow\.hidden\)/);
  assertSourceMatch(script, /autoSubmitted=true;/);
  assertSourceMatch(script, /window\.setTimeout\(stopPolling,30000\)/);
});
