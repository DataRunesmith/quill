import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { assertSourceMatch, assertSourceNoMatch } from "./compact-source.ts";

const sendSource = readFileSync(new URL("../src/send.ts", import.meta.url), "utf8");
const queueSource = readFileSync(new URL("../src/send-queue.ts", import.meta.url), "utf8");
const typesSource = readFileSync(new URL("../../shared/types.ts", import.meta.url), "utf8");

test("queued messages carry the enqueue timestamp as an attempt generation", () => {
  assertSourceMatch(typesSource, /queuedAt\?:\s*number/);
  assertSourceMatch(sendSource, /const queuedAt\s*=\s*Date\.now\(\)/);
  assertSourceMatch(sendSource, /SET status = 'queued', queued_at = \?[\s\S]*?\.bind\(queuedAt,/);
  assertSourceMatch(sendSource, /queuedAt,/);
});

test("cron releases stale queued recipients before re-enqueueing", () => {
  assertSourceMatch(sendSource, /const STALE_QUEUED_MS\s*=\s*2\s*\*\s*60\s*\*\s*60\s*\*\s*1000/);
  assertSourceMatch(
    sendSource,
    /export async function recoverStaleQueuedRecipients[\s\S]*?r\.status = 'queued'[\s\S]*?r\.queued_at <= \?[\s\S]*?j\.status IN \('pending', 'sending'\)/,
  );
  assertSourceMatch(sendSource, /SET status = 'pending', queued_at = NULL, error = NULL/);
  assertSourceMatch(
    sendSource,
    /export async function enqueuePendingUserSendJobs[\s\S]*?await recoverStaleQueuedRecipients\(env\)/,
  );
});

test("consumer rejects legacy or superseded queue attempts", () => {
  assertSourceMatch(queueSource, /SELECT status,queued_at FROM send_job_recipients/);
  assertSourceMatch(queueSource, /m\.queuedAt==null/);
  assertSourceMatch(queueSource, /staged\.queued_at!==m\.queuedAt/);
  assertSourceMatch(
    queueSource,
    /maySendQueuedRecipient\(env,sendJobId,m\.recipientEmail,m\.queuedAt\)/,
  );
  assertSourceMatch(queueSource, /current\.queued_at!==m\.queuedAt/);
});
