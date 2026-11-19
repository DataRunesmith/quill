import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assertSourceMatch } from "./compact-source.ts";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const queue = read("../src/send-queue.ts");
const send = read("../src/send.ts");
const db = read("../src/db.ts");
const oauth = read("../src/oauth.ts");
const auth = read("../src/auth.ts");
const index = read("../src/index.ts");
const client = read("../public/app-send.js");

test("batch end never overwrites a cancelled, aborted or done job status", () => {
  assertSourceMatch(queue, /status=CASE WHEN status IN \('pending','sending'\) THEN \? ELSE status END/);
});

test("a failed log write after delivery is not treated as a send failure", () => {
  assertSourceMatch(queue, /catch \(logErr\)/);
});

test("outcomes from user-supplied SMTP servers do not touch shared contacts", () => {
  assertSourceMatch(queue, /shareOutcome = credentialRow\.provider !== "generic"/);
  assertSourceMatch(queue, /if \(!shareOutcome\) return;/);
});

test("disabled accounts are not sent for and their jobs are aborted", () => {
  assertSourceMatch(send, /if \(account\.disabled\) return deferRecipient\(\);/);
  assertSourceMatch(auth, /UPDATE send_jobs SET status = 'aborted', finished_at = \? WHERE account_id = \?/);
});

test("deleting a job that sent today hides it and keeps the quota rows", () => {
  assertSourceMatch(send, /UPDATE send_jobs SET deleted_at = \?, idempotency_key = NULL WHERE id = \? AND account_id = \?/);
  assertSourceMatch(send, /DELETE FROM send_job_recipients WHERE send_job_id = \?/);
  assertSourceMatch(send, /sj\.deleted_at IS NULL/);
});

test("starting a send is idempotent per client key", () => {
  assertSourceMatch(index, /findSendJobByIdempotencyKey\(c\.env, c\.accountId, idempotencyKey\)/);
  assertSourceMatch(client, /idempotencyKey,/);
  assert.match(
    read("../../infra/migrations/0009_send_job_idempotency_and_soft_delete.sql"),
    /CREATE UNIQUE INDEX idx_send_jobs_idempotency/,
  );
});

test("revoked mail credentials cannot be selected for sending", () => {
  assertSourceMatch(db, /WHERE id = \? AND revoked_at IS NULL/);
});

test("adopting an unverified account through OAuth discards everything it held", () => {
  assertSourceMatch(oauth, /!existingAccount\.email_verified/);
  assertSourceMatch(oauth, /await purgeAccountData\(env, existingAccount\.id as string\);/);
});

test("password reset proves ownership of the e-mail address", () => {
  assertSourceMatch(auth, /password_set_by_user = 1, email_verified = 1/);
});

test("OAuth login state is bound to the browser and mail callback to the session", () => {
  assertSourceMatch(index, /getCookie\(req, "oauth_state"\) !== state/);
  assertSourceMatch(index, /stateAccountId !== \(account\.id as string\)/);
});

test("queue retries match the transient attempt limit", () => {
  assert.match(read("../wrangler.jsonc"), /"max_retries": 5/);
  assert.match(read("../../docker/wrangler.template.jsonc"), /"max_retries": 5/);
});

test("the start-sending button is guarded against double clicks", () => {
  assertSourceMatch(client, /if \(sendButton\.disabled\) return;/);
  assertSourceMatch(client, /sendButton\.disabled = true;/);
});
