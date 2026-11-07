// Tillfällig serverdiagnostik. Slutar automatiskt logga efter felsökningen.
export const LOGIN_DIAGNOSTIC_EXPIRES_AT = Date.parse("2026-09-13T12:00:00Z");

export function loginDiagnosticEvent(
  accountFound: boolean,
  passwordMatches: boolean,
  now = Date.now(),
) {
  if (!Number.isFinite(now) || now >= LOGIN_DIAGNOSTIC_EXPIRES_AT) return null;
  return {
    event: "login_verification_diagnostic_v1",
    accountFound: accountFound === true,
    passwordMatches: passwordMatches === true,
  };
}
