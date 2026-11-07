import { decryptSecret, encryptSecret, randomId } from "../../shared/crypto";
import { sendSmtpMail } from "../../shared/smtp";
import {
  isMailCredentialFailure,
  isPermanentRecipientSmtpFailure,
  isTransientSmtpFailure,
} from "../../shared/smtp-failure";
import { sendGraphMail, refreshMicrosoftToken } from "../../shared/graph-mail";
import type { SendJobMessage } from "../../shared/types";
import { messagesPerMinuteFor } from "../../shared/provider-rates";
import type { Env } from "./db";
import { personalizeLetter } from "./personalize-letter";
import { maySendQueuedRecipient } from "./send";
import { decryptLetterData } from "./letter-privacy";

interface CredentialRow {
  provider: string;
  smtp_host: string;
  smtp_port: number;
  smtp_user: string;
  encrypted_password: string;
  from_address: string;
  oauth_access_token: string | null;
  oauth_refresh_token: string | null;
  oauth_token_expires_at: number | null;
}
type QueueMessage = MessageBatch<SendJobMessage>["messages"][number];
const BOUNCE_ABORT_RATE = 25,
  MIN_FOR_RATE_CHECK = 10,
  MAX_WAIT_MS = 4 * 60 * 1000,
  POLL_INTERVAL_CAP_MS = 15_000;
const TRANSIENT_SMTP_MAX_ATTEMPTS = 5,
  TRANSIENT_SMTP_BASE_DELAY_SECONDS = 60;

async function acquireSendSlot(
  env: Env,
  credentialId: string,
  provider: string,
): Promise<{ granted: boolean; retryAfterMs?: number }> {
  const id = env.RATE_LIMITER.idFromName(credentialId);
  try {
    const resp = await env.RATE_LIMITER.get(id).fetch("https://rate-limiter/acquire", {
      method: "POST",
      body: JSON.stringify({ capacity: 1, refillPerMinute: messagesPerMinuteFor(provider) }),
    });
    return resp.json<{ granted: boolean; retryAfterMs?: number }>();
  } catch {
    return { granted: false, retryAfterMs: 1000 };
  }
}
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function transientSmtpRetryDelaySeconds(attempts: number): number {
  const exponent = Math.max(0, Math.min(3, attempts - 1));
  return Math.min(15 * 60, TRANSIENT_SMTP_BASE_DELAY_SECONDS * 2 ** exponent);
}
async function waitForSendSlot(env: Env, credentialId: string, provider: string): Promise<boolean> {
  const deadline = Date.now() + MAX_WAIT_MS;
  while (true) {
    const slot = await acquireSendSlot(env, credentialId, provider);
    if (slot.granted) return true;
    const waitMs = Math.min(slot.retryAfterMs ?? 1000, POLL_INTERVAL_CAP_MS);
    if (Date.now() + waitMs > deadline) return false;
    await sleep(waitMs);
  }
}

export async function handleSendQueue(
  batch: MessageBatch<SendJobMessage>,
  env: Env,
): Promise<void> {
  const byJob = new Map<string, QueueMessage[]>();
  for (const message of batch.messages) {
    const arr = byJob.get(message.body.sendJobId) ?? [];
    arr.push(message);
    byJob.set(message.body.sendJobId, arr);
  }
  for (const [sendJobId, messages] of byJob) await processJobMessages(env, sendJobId, messages);
}

async function processJobMessages(
  env: Env,
  sendJobId: string,
  messages: QueueMessage[],
): Promise<void> {
  const job = await env.DB.prepare(
    `SELECT sj.letter_id, sj.mail_credential_id, sj.intro_text FROM send_jobs sj WHERE sj.id=?`,
  )
    .bind(sendJobId)
    .first<{ letter_id: string; mail_credential_id: string; intro_text: string | null }>();
  if (!job) {
    for (const message of messages) message.ack();
    return;
  }
  const credentialId = job.mail_credential_id;
  const introText = job.intro_text ? await decryptLetterData(env, job.intro_text) : "";
  let credentialRow = await env.DB.prepare(
    `SELECT provider,smtp_host,smtp_port,smtp_user,encrypted_password,from_address,oauth_access_token,oauth_refresh_token,oauth_token_expires_at FROM mail_credentials WHERE id=? AND revoked_at IS NULL`,
  )
    .bind(credentialId)
    .first<CredentialRow>();
  if (!credentialRow) {
    for (const message of messages) message.ack();
    await markJobAborted(env, sendJobId, "Mailkontot finns inte längre");
    return;
  }
  if (
    credentialRow.provider === "microsoft_graph" &&
    (credentialRow.oauth_token_expires_at ?? 0) < Date.now() + 5 * 60 * 1000
  )
    credentialRow = await refreshAndPersistMicrosoftToken(env, credentialId, credentialRow);
  const attachments = await fetchAttachments(env, job.letter_id);
  let bounceCount = 0,
    attempted = 0,
    sentCount = 0,
    aborted = false,
    cachedStoredBody: string | null = null,
    cachedLetterBody = "";
  for (const queueMsg of messages) {
    const m = queueMsg.body;
    if (m.mailCredentialId !== credentialId) {
      queueMsg.ack();
      continue;
    }
    if (aborted) {
      queueMsg.ack();
      continue;
    }
    const staged = await env.DB.prepare(
      "SELECT status,queued_at FROM send_job_recipients WHERE send_job_id=? AND recipient_email=?",
    )
      .bind(sendJobId, m.recipientEmail)
      .first<{ status: string; queued_at: number | null }>();
    if (!staged || staged.status !== "queued") {
      queueMsg.ack();
      continue;
    }
    if (m.queuedAt == null || staged.queued_at !== m.queuedAt) {
      queueMsg.ack();
      continue;
    }
    if (!(await maySendQueuedRecipient(env, sendJobId, m.recipientEmail, m.queuedAt))) {
      queueMsg.ack();
      continue;
    }
    if (!(await waitForSendSlot(env, credentialId, credentialRow.provider))) {
      queueMsg.retry({ delaySeconds: 30 });
      continue;
    }
    const current = await env.DB.prepare(
      `SELECT r.status,r.queued_at,r.subject,l.html_body FROM send_job_recipients r JOIN send_jobs sj ON sj.id=r.send_job_id JOIN letters l ON l.id=sj.letter_id WHERE r.send_job_id=? AND r.recipient_email=?`,
    )
      .bind(sendJobId, m.recipientEmail)
      .first<{
        status: string;
        queued_at: number | null;
        subject: string | null;
        html_body: string;
      }>();
    if (!current || current.status !== "queued" || current.queued_at !== m.queuedAt) {
      queueMsg.ack();
      continue;
    }
    if (current.html_body !== cachedStoredBody) {
      cachedStoredBody = current.html_body;
      cachedLetterBody = await decryptLetterData(env, current.html_body);
    }
    if (!cachedLetterBody) {
      queueMsg.ack();
      await markJobAborted(env, sendJobId, "Brevets innehåll har raderats");
      aborted = true;
      continue;
    }
    attempted++;
    try {
      const html = personalizeLetter(
        cachedLetterBody,
        m.recipientName,
        m.recipientEmail,
        introText,
      );
      await sendOneMail(
        env,
        credentialRow,
        m.recipientEmail,
        html,
        current.subject ?? undefined,
        attachments,
      );
      await logSend(env, m, "ok", null);
      sentCount++;
      queueMsg.ack();
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Okänt fel";
      if (isMailCredentialFailure(err)) {
        await recordBlockingSendError(env, m, errorMsg);
        queueMsg.ack();
        aborted = true;
        continue;
      }
      if (isTransientSmtpFailure(err) && queueMsg.attempts < TRANSIENT_SMTP_MAX_ATTEMPTS) {
        await recordTransientSendError(env, m, errorMsg);
        queueMsg.retry({ delaySeconds: transientSmtpRetryDelaySeconds(queueMsg.attempts) });
        continue;
      }
      bounceCount++;
      await logSend(env, m, "bounce", errorMsg, isPermanentRecipientSmtpFailure(err));
      queueMsg.ack();
      if (bounceCount >= 5 && attempted >= MIN_FOR_RATE_CHECK) {
        const rate = (bounceCount / attempted) * 100;
        if (rate >= BOUNCE_ABORT_RATE) {
          aborted = true;
          await markJobAborted(
            env,
            sendJobId,
            `Hög bounce-andel (${rate.toFixed(0)}%) — stoppat för granskning`,
          );
        }
      }
    }
  }
  if (attempted > 0 || aborted)
    await env.DB.prepare(
      `UPDATE send_jobs SET sent_count=sent_count+?,bounce_count=bounce_count+?,status=? WHERE id=?`,
    )
      .bind(sentCount, bounceCount, aborted ? "aborted" : "sending", sendJobId)
      .run();
  await maybeFinishJob(env, sendJobId);
}

async function sendOneMail(
  env: Env,
  c: CredentialRow,
  to: string,
  html: string,
  subject: string | undefined,
  attachments: Array<{ filename: string; contentType: string; bytes: ArrayBuffer }>,
): Promise<void> {
  if (c.provider === "microsoft_graph") {
    const accessToken = await decryptSecret(c.oauth_access_token!, env.MAIL_CRED_KEY);
    await sendGraphMail(accessToken, { to, html, subject, attachments });
    return;
  }
  let password: string;
  try {
    password = await decryptSecret(c.encrypted_password, env.MAIL_CRED_KEY);
  } catch {
    throw new Error(
      "Det sparade SMTP-lösenordet kan inte dekrypteras. Spara app-lösenordet på nytt under Inställningar → Mail.",
    );
  }
  await sendSmtpMail(
    {
      host: c.smtp_host,
      port: c.smtp_port,
      user: c.smtp_user,
      password,
      fromAddress: c.from_address,
    },
    { to, html, subject, attachments },
  );
}
async function fetchAttachments(
  env: Env,
  letterId: string,
): Promise<Array<{ filename: string; contentType: string; bytes: ArrayBuffer }>> {
  const { results } = await env.DB.prepare(
    "SELECT filename,content_type,r2_key FROM letter_attachments WHERE letter_id=? AND mode='attach'",
  )
    .bind(letterId)
    .all<{ filename: string; content_type: string; r2_key: string }>();
  const attachments: Array<{ filename: string; contentType: string; bytes: ArrayBuffer }> = [];
  for (const row of results) {
    const obj = await env.ATTACHMENTS.get(row.r2_key);
    if (obj)
      attachments.push({
        filename: row.filename,
        contentType: row.content_type,
        bytes: await obj.arrayBuffer(),
      });
  }
  return attachments;
}
async function refreshAndPersistMicrosoftToken(
  env: Env,
  credentialId: string,
  c: CredentialRow,
): Promise<CredentialRow> {
  if (!c.oauth_refresh_token) throw new Error("Microsoft-kopplingen saknar refresh token");
  const refreshToken = await decryptSecret(c.oauth_refresh_token, env.MAIL_CRED_KEY);
  const fresh = await refreshMicrosoftToken(
    env.OAUTH_MICROSOFT_CLIENT_ID!,
    env.OAUTH_MICROSOFT_CLIENT_SECRET!,
    refreshToken,
  );
  const encryptedAccessToken = await encryptSecret(fresh.accessToken, env.MAIL_CRED_KEY),
    encryptedRefreshToken = await encryptSecret(fresh.refreshToken, env.MAIL_CRED_KEY);
  await env.DB.prepare(
    "UPDATE mail_credentials SET oauth_access_token=?,oauth_refresh_token=?,oauth_token_expires_at=? WHERE id=? AND revoked_at IS NULL",
  )
    .bind(encryptedAccessToken, encryptedRefreshToken, fresh.expiresAt, credentialId)
    .run();
  return {
    ...c,
    oauth_access_token: encryptedAccessToken,
    oauth_refresh_token: encryptedRefreshToken,
    oauth_token_expires_at: fresh.expiresAt,
  };
}
async function logSend(
  env: Env,
  m: SendJobMessage,
  status: "ok" | "bounce",
  error: string | null,
  markRecipientDead = false,
): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO send_log (id,send_job_id,account_id,recipient_email,status,error,sent_at) VALUES (?,?,?,?,?,?,?)",
  )
    .bind(randomId(), m.sendJobId, m.accountId, m.recipientEmail, status, error, now)
    .run();
  await env.DB.prepare(
    "UPDATE send_job_recipients SET status=?,finished_at=?,error=? WHERE send_job_id=? AND recipient_email=?",
  )
    .bind(status, now, error, m.sendJobId, m.recipientEmail)
    .run();
  if (status === "ok")
    await env.DB.prepare(
      "UPDATE public_contacts SET verification_status='valid_via_send',last_verified_at=? WHERE email=?",
    )
      .bind(now, m.recipientEmail)
      .run();
  else if (markRecipientDead)
    await env.DB.prepare(
      "UPDATE public_contacts SET verification_status='dead_via_send',last_verified_at=? WHERE email=?",
    )
      .bind(now, m.recipientEmail)
      .run();
}
async function recordTransientSendError(env: Env, m: SendJobMessage, error: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE send_job_recipients SET error=? WHERE send_job_id=? AND recipient_email=? AND status='queued'",
  )
    .bind(error.slice(0, 300), m.sendJobId, m.recipientEmail)
    .run();
}
async function recordBlockingSendError(env: Env, m: SendJobMessage, error: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE send_job_recipients SET error=? WHERE send_job_id=? AND recipient_email=? AND status='queued'",
  )
    .bind(error.slice(0, 300), m.sendJobId, m.recipientEmail)
    .run();
  await markJobAborted(env, m.sendJobId, error);
}
async function markJobAborted(env: Env, sendJobId: string, _reason: string): Promise<void> {
  await env.DB.prepare("UPDATE send_jobs SET status='aborted',finished_at=? WHERE id=?")
    .bind(Date.now(), sendJobId)
    .run();
}
async function maybeFinishJob(env: Env, sendJobId: string): Promise<void> {
  const job = await env.DB.prepare(
    "SELECT total_recipients,sent_count,bounce_count,status FROM send_jobs WHERE id=?",
  )
    .bind(sendJobId)
    .first<{
      total_recipients: number;
      sent_count: number;
      bounce_count: number;
      status: string;
    }>();
  if (!job || job.status === "aborted") return;
  if (job.sent_count + job.bounce_count >= job.total_recipients)
    await env.DB.prepare("UPDATE send_jobs SET status='done',finished_at=? WHERE id=?")
      .bind(Date.now(), sendJobId)
      .run();
}
