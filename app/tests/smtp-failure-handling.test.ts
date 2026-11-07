import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { assertSourceMatch, assertSourceNoMatch } from "./compact-source.ts";
import {
  isMailCredentialFailure,
  isPermanentRecipientSmtpFailure,
  isSmtpAuthenticationFailure,
  isTransientSmtpFailure,
  visibleSendJobError,
} from "../../shared/smtp-failure.ts";

const queueSource = readFileSync(new URL("../src/send-queue.ts", import.meta.url), "utf8");

test("SMTP authentication failures are account-scoped, not recipient bounces", () => {
  assert.equal(
    isSmtpAuthenticationFailure(
      new Error("Inloggning misslyckades (535): 535 5.7.8 Error: authentication failed"),
    ),
    true,
  );
  assert.equal(
    isSmtpAuthenticationFailure(new Error("RCPT TO nekades (550): 550 5.1.1 User unknown")),
    false,
  );
});

test("stored SMTP decryption failures are account-scoped", () => {
  const error = new Error(
    "Det sparade SMTP-lösenordet kan inte dekrypteras. Spara app-lösenordet på nytt under Inställningar → Mail.",
  );
  assert.equal(isMailCredentialFailure(error), true);
  assert.equal(visibleSendJobError("sending", error.message), null);
  assert.equal(visibleSendJobError("aborted", error.message), error.message);
  assertSourceMatch(queueSource, /decryptSecret\(c\.encrypted_password,env\.MAIL_CRED_KEY\)/);
});

test("explicit SMTP 4xx responses are transient", () => {
  assert.equal(
    isTransientSmtpFailure(new Error("RCPT TO nekades (451): 451 4.2.0 Temporary failure")),
    true,
  );
  assert.equal(
    isTransientSmtpFailure(new Error("MAIL FROM nekades (fick 450: 450 4.2.0 Try again later)")),
    true,
  );
  assert.equal(
    isTransientSmtpFailure(
      new Error("Servern accepterade inte DATA (fick 421: 421 4.3.2 Service unavailable)"),
    ),
    true,
  );
  assert.equal(
    isTransientSmtpFailure(new Error("RCPT TO nekades (550): 550 5.1.1 User unknown")),
    false,
  );
  assert.equal(
    isTransientSmtpFailure(
      new Error("Inloggning misslyckades (454): 454 4.7.0 Temporary authentication failure"),
    ),
    false,
  );
});

test("non-aborted jobs hide stale SMTP authentication diagnostics", () => {
  const error = "Inloggning misslyckades (535): 535 5.7.8 Error: authentication failed";
  for (const status of ["pending", "queued", "sending", "done", "cancelled"]) {
    assert.equal(visibleSendJobError(status, error), null);
  }
});

test("aborted jobs still show SMTP authentication diagnostics", () => {
  const error = "Inloggning misslyckades (535): 535 5.7.8 Error: authentication failed";
  assert.equal(visibleSendJobError("aborted", error), error);
});

test("active jobs still show non-authentication send errors", () => {
  const error = "RCPT TO nekades (550): 550 5.1.1 User unknown";
  assert.equal(visibleSendJobError("sending", error), error);
});

test("only permanent recipient rejections mark an address as dead", () => {
  assert.equal(
    isPermanentRecipientSmtpFailure(new Error("RCPT TO nekades (550): 550 5.1.1 User unknown")),
    true,
  );
  assert.equal(
    isPermanentRecipientSmtpFailure(new Error("RCPT TO nekades (550): 550 5.7.1 Policy rejection")),
    false,
  );
  assert.equal(
    isPermanentRecipientSmtpFailure(
      new Error("RCPT TO nekades (451): 451 4.2.0 Temporary failure"),
    ),
    false,
  );
  assert.equal(
    isPermanentRecipientSmtpFailure(
      new Error("Inloggning misslyckades (535): authentication failed"),
    ),
    false,
  );
});

test("queue aborts on credential failures without counting them as sent or poisoning the recipient", () => {
  assertSourceMatch(
    queueSource,
    /if\s*\(\s*isMailCredentialFailure\(err\)\s*\)\s*\{[\s\S]*?recordBlockingSendError\(env\s*,\s*m\s*,\s*errorMsg\)[\s\S]*?queueMsg\.ack\(\)[\s\S]*?aborted\s*=\s*true[\s\S]*?continue\s*;/,
  );
  assertSourceMatch(
    queueSource,
    /\.bind\(\s*sentCount\s*,\s*bounceCount\s*,\s*aborted\s*\?\s*"aborted"\s*:\s*"sending"\s*,\s*sendJobId\s*\)/,
  );
  assertSourceMatch(
    queueSource,
    /else\s+if\s*\(\s*markRecipientDead\s*\)\s*await\s+env\.DB\.prepare\(\s*"UPDATE public_contacts SET verification_status='dead_via_send'/,
  );
});

test("queue retries transient SMTP failures before recording a bounce", () => {
  assertSourceMatch(
    queueSource,
    /isTransientSmtpFailure\(err\)&&queueMsg\.attempts<TRANSIENT_SMTP_MAX_ATTEMPTS/,
  );
  assertSourceMatch(
    queueSource,
    /recordTransientSendError\(env,m,errorMsg\);queueMsg\.retry\(\{delaySeconds:transientSmtpRetryDelaySeconds\(queueMsg\.attempts\)\}\);continue;/,
  );
  assert.ok(
    queueSource.indexOf("if(isTransientSmtpFailure(err)") < queueSource.indexOf("bounceCount++;"),
  );
});

test("remaining batch messages are acknowledged after a job aborts", () => {
  assertSourceMatch(
    queueSource,
    /if\s*\(\s*aborted\s*\)\s*\{\s*queueMsg\.ack\(\)\s*;\s*continue\s*;\s*\}/,
  );
});
