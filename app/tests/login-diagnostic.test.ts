import assert from "node:assert/strict";
import test from "node:test";
import { loginDiagnosticEvent, LOGIN_DIAGNOSTIC_EXPIRES_AT } from "../src/login-diagnostic.ts";

test("diagnostic distinguishes lookup from password verification without account data", () => {
  for (const [found, matches] of [
    [false, false],
    [true, false],
    [true, true],
  ]) {
    assert.deepEqual(loginDiagnosticEvent(found, matches, LOGIN_DIAGNOSTIC_EXPIRES_AT - 1), {
      event: "login_verification_diagnostic_v1",
      accountFound: found,
      passwordMatches: matches,
    });
  }
});

test("unexpected runtime values cannot leak into diagnostics", () => {
  const event = loginDiagnosticEvent(
    "private-value" as unknown as boolean,
    { token: "private-value" } as unknown as boolean,
    0,
  );
  assert.deepEqual(event, {
    event: "login_verification_diagnostic_v1",
    accountFound: false,
    passwordMatches: false,
  });
});

test("diagnostics expire automatically", () => {
  for (const now of [LOGIN_DIAGNOSTIC_EXPIRES_AT, LOGIN_DIAGNOSTIC_EXPIRES_AT + 1, NaN]) {
    assert.equal(loginDiagnosticEvent(true, true, now), null);
  }
});
