import { randomId } from "../../shared/crypto";
import {
  getRecipientsForAreas,
  countSentToday,
  countSentTodayForCredential,
  getMailCredential,
} from "./db";
import type { Env } from "./db";
import type { SendJobMessage } from "../../shared/types";
import { decryptLetterData, encryptLetterData } from "./letter-privacy";
import { visibleSendJobError } from "../../shared/smtp-failure";
import { normalizeSelectedLetterIntroText } from "./letter-intro-presets";

const STAGE_CHUNK_SIZE = 500;
const MAX_LETTER_HTML_BYTES = 1024 * 1024;
const STALE_QUEUED_MS = 2 * 60 * 60 * 1000;
const COMMON_MOJIBAKE = /(?:Ã¥|Ã¤|Ã¶|Ã…|Ã„|Ã–|Ã©|Ã¨|Ã¼|Ã±|â€“|â€”|â€™|â€œ|â€|â€¦|Â |ï¿½)/;
type SendJobAction = "cancel" | "retry" | "delete";

interface StagedRecipient {
  email: string;
  name: string;
}

interface SendRateInput {
  dailyLimit?: number | null;
  switchAfterDays?: number | null;
  nextDailyLimit?: number | null;
  action?: SendJobAction;
  mailCredentialId?: string;
  letterHtml?: string;
  subject?: string;
}

interface SendJobListRow {
  id: string;
  letter_id: string;
  mail_credential_id: string;
  total_recipients: number;
  sent_count: number;
  bounce_count: number;
  status: string;
  daily_limit: number | null;
  next_daily_limit: number | null;
  limit_switch_at: number | null;
  created_at: number;
  finished_at: number | null;
  pending_count: number;
  queued_count: number;
  last_error: string | null;
  subject: string | null;
  stored_letter_html: string;
}

export function validateLetterContent(letterHtml: string): void {
  if (typeof letterHtml !== "string" || !letterHtml.trim()) throw new Error("Brevtext krävs");
  if (new TextEncoder().encode(letterHtml).byteLength > MAX_LETTER_HTML_BYTES)
    throw new Error("Brevtexten är för stor");
  if (letterHtml.includes("\uFFFD"))
    throw new Error(
      "Brevtexten innehåller trasiga ersättningstecken (�). Rätta texten innan du fortsätter.",
    );
  if (COMMON_MOJIBAKE.test(letterHtml))
    throw new Error("Brevtexten ser felkodad ut. Rätta texten eller importera dokumentet på nytt.");
  if (/[\u0000\u0001-\u0008\u000B\u000C\u000E-\u001F]/.test(letterHtml))
    throw new Error("Brevtexten innehåller ogiltiga kontrolltecken");
}

function parseRateInput(input: SendRateInput, now = Date.now()) {
  const normalize = (value: number | null | undefined, label: string): number | null => {
    if (value == null) return null;
    if (!Number.isInteger(value) || value < 1 || value > 10_000) {
      throw new Error(`${label} måste vara ett heltal mellan 1 och 10 000`);
    }
    return value;
  };
  const dailyLimit = normalize(input.dailyLimit, "Gräns nu");
  const nextDailyLimit = normalize(input.nextDailyLimit, "Gräns därefter");
  let limitSwitchAt: number | null = null;
  if (nextDailyLimit != null) {
    if (
      !Number.isInteger(input.switchAfterDays) ||
      (input.switchAfterDays ?? 0) < 1 ||
      (input.switchAfterDays ?? 0) > 365
    ) {
      throw new Error("Antal dagar måste vara ett heltal mellan 1 och 365");
    }
    limitSwitchAt = now + Number(input.switchAfterDays) * 24 * 60 * 60 * 1000;
  }
  return { dailyLimit, nextDailyLimit, limitSwitchAt };
}

function effectiveJobDailyLimit(
  job: {
    daily_limit: number | null;
    next_daily_limit: number | null;
    limit_switch_at: number | null;
  },
  now = Date.now(),
) {
  if (job.next_daily_limit != null && job.limit_switch_at != null && now >= job.limit_switch_at)
    return job.next_daily_limit;
  return job.daily_limit;
}

function stableRecipientHash(seed: string, email: string): number {
  let hash = 2166136261;
  const value = `${seed}:${email.toLocaleLowerCase("sv-SE")}`;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

async function prioritizeRecipients(
  env: Env,
  sendJobId: string,
  recipients: StagedRecipient[],
): Promise<StagedRecipient[]> {
  const priorityByEmail = new Map<string, number>();
  for (let i = 0; i < recipients.length; i += STAGE_CHUNK_SIZE) {
    const emails = recipients
      .slice(i, i + STAGE_CHUNK_SIZE)
      .map((r) => r.email.trim().toLocaleLowerCase("sv-SE"));
    const { results } = await env.DB.prepare(
      `
      SELECT lower(trim(email)) AS email_key,
             MIN(CASE area_type
               WHEN 'eu' THEN 1
               WHEN 'regering' THEN 2
               WHEN 'riksdag' THEN 3
               WHEN 'media' THEN 4
               WHEN 'region' THEN 5
               WHEN 'kommun' THEN 6
               WHEN 'academia' THEN 7
               ELSE 8
             END) AS priority
      FROM public_contacts
      WHERE lower(trim(email)) IN (SELECT lower(trim(value)) FROM json_each(?))
      GROUP BY lower(trim(email))
    `,
    )
      .bind(JSON.stringify(emails))
      .all<{ email_key: string; priority: number }>();
    for (const row of results) priorityByEmail.set(row.email_key, Number(row.priority));
  }

  return [...recipients].sort((a, b) => {
    const aKey = a.email.trim().toLocaleLowerCase("sv-SE");
    const bKey = b.email.trim().toLocaleLowerCase("sv-SE");
    const aPriority = priorityByEmail.get(aKey) ?? 7;
    const bPriority = priorityByEmail.get(bKey) ?? 7;
    if (aPriority !== bPriority) return aPriority - bPriority;
    if (aPriority === 6)
      return stableRecipientHash(sendJobId, aKey) - stableRecipientHash(sendJobId, bKey);
    return aKey.localeCompare(bKey, "sv-SE");
  });
}

export async function maySendQueuedRecipient(
  env: Env,
  sendJobId: string,
  recipientEmail: string,
  queuedAt: number,
): Promise<boolean> {
  const job = await env.DB.prepare(
    "SELECT daily_limit, next_daily_limit, limit_switch_at, status FROM send_jobs WHERE id = ?",
  )
    .bind(sendJobId)
    .first<{
      daily_limit: number | null;
      next_daily_limit: number | null;
      limit_switch_at: number | null;
      status: string;
    }>();
  if (!job || !["pending", "sending"].includes(job.status)) return false;

  const dailyLimit = effectiveJobDailyLimit(job);
  if (dailyLimit == null) return true;

  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const sent = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM send_log WHERE send_job_id = ? AND sent_at >= ? AND status = 'ok'",
  )
    .bind(sendJobId, startOfDay.getTime())
    .first<{ n: number }>();
  const available = Math.max(0, dailyLimit - (sent?.n ?? 0));
  const allowed =
    available > 0
      ? await env.DB.prepare(
          `SELECT 1 AS allowed FROM (
         SELECT recipient_email FROM send_job_recipients
         WHERE send_job_id = ? AND status = 'queued'
         ORDER BY queued_at, rowid LIMIT ?
       ) WHERE recipient_email = ? COLLATE NOCASE`,
        )
          .bind(sendJobId, available, recipientEmail)
          .first<{ allowed: number }>()
      : null;
  if (allowed) return true;

  await env.DB.prepare(
    `UPDATE send_job_recipients SET status = 'pending', queued_at = NULL
     WHERE send_job_id = ? AND recipient_email = ? AND status = 'queued' AND queued_at = ?`,
  )
    .bind(sendJobId, recipientEmail, queuedAt)
    .run();
  return false;
}

async function remainingQuotaForCredential(
  env: Env,
  accountId: string,
  mailCredentialId: string,
): Promise<{ remaining: number; label: string }> {
  const account = await env.DB.prepare("SELECT daily_send_cap FROM accounts WHERE id = ?")
    .bind(accountId)
    .first<{ daily_send_cap: number }>();
  if (!account) throw new Error("Konto saknas");

  const credential = await getMailCredential(env.DB, mailCredentialId);
  if (!credential || credential.account_id !== accountId) throw new Error("Mailkoppling saknas");

  if (credential.daily_cap != null) {
    const sentViaCredentialToday = await countSentTodayForCredential(env.DB, mailCredentialId);
    const queuedViaCredential = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM send_job_recipients r
       JOIN send_jobs j ON j.id = r.send_job_id
       WHERE j.mail_credential_id = ? AND r.status = 'queued'`,
    )
      .bind(mailCredentialId)
      .first<{ n: number }>();
    return {
      remaining: Math.max(
        0,
        Number(credential.daily_cap) - sentViaCredentialToday - (queuedViaCredential?.n ?? 0),
      ),
      label: `dygnsgränsen för detta mailkonto (${credential.daily_cap}/dygn)`,
    };
  }

  const sentToday = await countSentToday(env.DB, accountId);
  const queued = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM send_job_recipients r
     JOIN send_jobs j ON j.id = r.send_job_id
     WHERE j.account_id = ? AND r.status = 'queued'`,
  )
    .bind(accountId)
    .first<{ n: number }>();
  return {
    remaining: Math.max(0, account.daily_send_cap - sentToday - (queued?.n ?? 0)),
    label: `kontots dygnsgräns (${account.daily_send_cap}/dygn)`,
  };
}

async function stageRecipients(
  env: Env,
  sendJobId: string,
  recipients: StagedRecipient[],
  subject?: string,
): Promise<void> {
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < recipients.length; i += STAGE_CHUNK_SIZE) {
    const chunk = recipients.slice(i, i + STAGE_CHUNK_SIZE);
    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO send_job_recipients
         (send_job_id, recipient_email, recipient_name, subject)
       SELECT ?, json_extract(value, '$.email'), json_extract(value, '$.name'), ?
       FROM json_each(?)`,
      ).bind(sendJobId, subject ?? null, JSON.stringify(chunk)),
    );
  }
  if (statements.length > 0) await env.DB.batch(statements);
}

export async function enqueuePendingRecipientsForJob(
  env: Env,
  sendJobId: string,
  limit: number,
): Promise<number> {
  if (limit <= 0) return 0;
  const job = await env.DB.prepare(
    `SELECT account_id, mail_credential_id FROM send_jobs
     WHERE id = ? AND status IN ('pending', 'sending')`,
  )
    .bind(sendJobId)
    .first<{ account_id: string; mail_credential_id: string }>();
  if (!job) return 0;

  const { results } = await env.DB.prepare(
    `SELECT recipient_email, recipient_name, subject
     FROM send_job_recipients
     WHERE send_job_id = ? AND status = 'pending'
     ORDER BY rowid LIMIT ?`,
  )
    .bind(sendJobId, limit)
    .all<{ recipient_email: string; recipient_name: string; subject: string | null }>();

  let queued = 0;
  for (const recipient of results) {
    const queuedAt = Date.now();
    const claimed = await env.DB.prepare(
      `UPDATE send_job_recipients SET status = 'queued', queued_at = ?
       WHERE send_job_id = ? AND recipient_email = ? AND status = 'pending'`,
    )
      .bind(queuedAt, sendJobId, recipient.recipient_email)
      .run();
    if (claimed.meta.changes !== 1) continue;

    const message: SendJobMessage = {
      sendJobId,
      accountId: job.account_id,
      mailCredentialId: job.mail_credential_id,
      recipientEmail: recipient.recipient_email,
      recipientName: recipient.recipient_name,
      subject: recipient.subject ?? undefined,
      queuedAt,
    };
    try {
      await env.SEND_QUEUE.send(message);
      queued++;
    } catch (error) {
      await env.DB.prepare(
        `UPDATE send_job_recipients SET status = 'pending', queued_at = NULL, error = ?
         WHERE send_job_id = ? AND recipient_email = ? AND status = 'queued' AND queued_at = ?`,
      )
        .bind(String(error).slice(0, 300), sendJobId, recipient.recipient_email, queuedAt)
        .run();
      throw error;
    }
  }

  if (queued > 0) {
    await env.DB.prepare(
      "UPDATE send_jobs SET status = 'sending' WHERE id = ? AND status = 'pending'",
    )
      .bind(sendJobId)
      .run();
  }
  return queued;
}

async function remainingJobQuota(env: Env, sendJobId: string): Promise<number | null> {
  const job = await env.DB.prepare(
    "SELECT daily_limit, next_daily_limit, limit_switch_at FROM send_jobs WHERE id = ?",
  )
    .bind(sendJobId)
    .first<{
      daily_limit: number | null;
      next_daily_limit: number | null;
      limit_switch_at: number | null;
    }>();
  if (!job) return 0;
  const dailyLimit = effectiveJobDailyLimit(job);
  if (dailyLimit == null) return null;

  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const sent = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM send_log WHERE send_job_id = ? AND sent_at >= ? AND status = 'ok'",
  )
    .bind(sendJobId, startOfDay.getTime())
    .first<{ n: number }>();
  const queued = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM send_job_recipients WHERE send_job_id = ? AND status = 'queued'",
  )
    .bind(sendJobId)
    .first<{ n: number }>();
  return Math.max(0, dailyLimit - (sent?.n ?? 0) - (queued?.n ?? 0));
}

async function enqueueWithinLimits(
  env: Env,
  sendJobId: string,
  providerRemaining: number,
): Promise<number> {
  const jobRemaining = await remainingJobQuota(env, sendJobId);
  return enqueuePendingRecipientsForJob(
    env,
    sendJobId,
    Math.min(providerRemaining, jobRemaining ?? providerRemaining),
  );
}

export async function recoverStaleQueuedRecipients(env: Env, now = Date.now()): Promise<number> {
  const cutoff = now - STALE_QUEUED_MS;
  const recovered = await env.DB.prepare(
    `UPDATE send_job_recipients
     SET status = 'pending', queued_at = NULL, error = NULL
     WHERE rowid IN (
       SELECT r.rowid
       FROM send_job_recipients r
       JOIN send_jobs j ON j.id = r.send_job_id
       WHERE r.status = 'queued'
         AND r.queued_at IS NOT NULL
         AND r.queued_at <= ?
         AND j.status IN ('pending', 'sending')
         AND NOT EXISTS (
           SELECT 1 FROM send_log l
           WHERE l.send_job_id = r.send_job_id
             AND l.recipient_email = r.recipient_email COLLATE NOCASE
             AND l.status = 'ok'
         )
       ORDER BY r.queued_at
       LIMIT 250
     )`,
  )
    .bind(cutoff)
    .run();
  return recovered.meta.changes ?? 0;
}

export async function enqueuePendingUserSendJobs(env: Env): Promise<void> {
  await recoverStaleQueuedRecipients(env);
  const { results: jobs } = await env.DB.prepare(
    `SELECT id, account_id, mail_credential_id FROM send_jobs
     WHERE status IN ('pending', 'sending')
       AND EXISTS (SELECT 1 FROM send_job_recipients r WHERE r.send_job_id = send_jobs.id AND r.status = 'pending')
     ORDER BY created_at`,
  ).all<{ id: string; account_id: string; mail_credential_id: string }>();

  for (const job of jobs) {
    try {
      const quota = await remainingQuotaForCredential(env, job.account_id, job.mail_credential_id);
      if (quota.remaining > 0) await enqueueWithinLimits(env, job.id, quota.remaining);
    } catch (error) {
      // Ett borttaget mailkonto ska inte få hela cron-körningen att fallera.
      // Jobbet ligger kvar tills användaren väljer ett nytt konto och kör retry.
      console.warn(`Kunde inte återköa utskick ${job.id}:`, error);
    }
  }
}

export async function createAndEnqueueSendJob(
  env: Env,
  accountId: string,
  input: {
    letterId: string;
    introText?: string;
    subject?: string;
    mailCredentialId: string;
    areaNames: string[];
    excludeParties?: string[];
    excludeEmails?: string[];
    includeRoles?: string[];
    includeEmails?: string[];
    dailyLimit?: number | null;
    switchAfterDays?: number | null;
    nextDailyLimit?: number | null;
  },
): Promise<{ sendJobId: string; totalRecipients: number }> {
  const account = await env.DB.prepare("SELECT daily_send_cap FROM accounts WHERE id = ?")
    .bind(accountId)
    .first<{ daily_send_cap: number }>();
  if (!account) throw new Error("Konto saknas");

  const credential = await getMailCredential(env.DB, input.mailCredentialId);
  if (!credential || credential.account_id !== accountId) throw new Error("Mailkoppling saknas");

  const recipients = await getRecipientsForAreas(
    env.DB,
    input.areaNames,
    input.excludeParties ?? [],
    input.excludeEmails ?? [],
    input.includeRoles ?? [],
    input.includeEmails ?? [],
  );
  if (recipients.length === 0)
    throw new Error(
      "Inga mottagare matchar valda filter — välj område, befattning eller enskilda politiker",
    );

  const sendJobId = randomId();
  const orderedRecipients = await prioritizeRecipients(env, sendJobId, recipients);
  const rate = parseRateInput(input);
  const introText = normalizeSelectedLetterIntroText(input.introText);
  const storedIntroText = introText ? await encryptLetterData(env, introText) : null;
  await env.DB.prepare(
    `INSERT INTO send_jobs
       (id, account_id, letter_id, mail_credential_id, total_recipients, status,
        daily_limit, next_daily_limit, limit_switch_at, intro_text, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
  )
    .bind(
      sendJobId,
      accountId,
      input.letterId,
      input.mailCredentialId,
      recipients.length,
      rate.dailyLimit,
      rate.nextDailyLimit,
      rate.limitSwitchAt,
      storedIntroText,
      Date.now(),
    )
    .run();

  await stageRecipients(env, sendJobId, orderedRecipients, input.subject);
  const quota = await remainingQuotaForCredential(env, accountId, input.mailCredentialId);
  await enqueueWithinLimits(env, sendJobId, quota.remaining);
  return { sendJobId, totalRecipients: recipients.length };
}

export async function getSendJobsForAccount(env: Env, accountId: string) {
  const now = Date.now();
  const { results } = await env.DB.prepare(
    `SELECT sj.id, sj.letter_id, sj.mail_credential_id, sj.total_recipients, sj.sent_count, sj.bounce_count, sj.status,
            CASE WHEN sj.next_daily_limit IS NOT NULL AND sj.limit_switch_at <= ?
                 THEN sj.next_daily_limit ELSE sj.daily_limit END AS daily_limit,
            CASE WHEN sj.next_daily_limit IS NOT NULL AND sj.limit_switch_at <= ?
                 THEN NULL ELSE sj.next_daily_limit END AS next_daily_limit,
            CASE WHEN sj.next_daily_limit IS NOT NULL AND sj.limit_switch_at <= ?
                 THEN NULL ELSE sj.limit_switch_at END AS limit_switch_at,
            sj.created_at, sj.finished_at,
            (SELECT COUNT(*) FROM send_job_recipients r WHERE r.send_job_id = sj.id AND r.status = 'pending') AS pending_count,
            (SELECT COUNT(*) FROM send_job_recipients r WHERE r.send_job_id = sj.id AND r.status = 'queued') AS queued_count,
            (SELECT error FROM send_job_recipients r WHERE r.send_job_id = sj.id AND r.error IS NOT NULL ORDER BY COALESCE(r.finished_at, r.queued_at) DESC LIMIT 1) AS last_error,
            (SELECT subject FROM send_job_recipients r WHERE r.send_job_id = sj.id AND r.status IN ('pending','queued') ORDER BY r.rowid LIMIT 1) AS subject,
            l.html_body AS stored_letter_html
     FROM send_jobs sj
     JOIN letters l ON l.id = sj.letter_id
     WHERE sj.account_id = ? ORDER BY sj.created_at DESC LIMIT 50`,
  )
    .bind(now, now, now, accountId)
    .all<SendJobListRow>();

  return Promise.all(
    results.map(async (row) => {
      const { stored_letter_html: storedLetterHtml, ...job } = row;
      let letter_html: string | null = null;
      if (["pending", "sending"].includes(row.status)) {
        try {
          const decrypted = await decryptLetterData(env, storedLetterHtml);
          letter_html = decrypted || null;
        } catch {
          letter_html = null;
        }
      }
      return { ...job, last_error: visibleSendJobError(row.status, row.last_error), letter_html };
    }),
  );
}

async function handleSendJobAction(
  env: Env,
  accountId: string,
  sendJobId: string,
  input: SendRateInput,
): Promise<Record<string, unknown>> {
  const action = input.action!;
  const job = await env.DB.prepare(
    "SELECT id, letter_id, mail_credential_id, status, bounce_count FROM send_jobs WHERE id = ? AND account_id = ?",
  )
    .bind(sendJobId, accountId)
    .first<{
      id: string;
      letter_id: string;
      mail_credential_id: string;
      status: string;
      bounce_count: number;
    }>();
  if (!job) throw new Error("Utskicket hittades inte");

  if (action === "cancel") {
    if (!["pending", "sending"].includes(job.status))
      throw new Error("Bara ett pågående utskick kan avbrytas");
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE send_jobs SET status = 'cancelled', finished_at = ? WHERE id = ? AND account_id = ?",
      ).bind(now, sendJobId, accountId),
      env.DB.prepare(
        "UPDATE send_job_recipients SET status = 'cancelled', finished_at = ?, queued_at = NULL WHERE send_job_id = ? AND status IN ('pending', 'queued')",
      ).bind(now, sendJobId),
    ]);
    return { ok: true, status: "cancelled" };
  }

  if (action === "retry") {
    const retryable =
      job.status === "aborted" || job.status === "cancelled" || job.bounce_count > 0;
    if (!retryable) throw new Error("Det finns inget misslyckat eller avbrutet att försöka igen");

    const credentialId = input.mailCredentialId ?? job.mail_credential_id;
    const credential = await getMailCredential(env.DB, credentialId);
    if (!credential || credential.account_id !== accountId) {
      throw new Error("Välj ett giltigt mailkonto för det nya försöket");
    }

    await env.DB.batch([
      env.DB.prepare(
        `UPDATE send_job_recipients
         SET status = 'pending', queued_at = NULL, finished_at = NULL, error = NULL
         WHERE send_job_id = ? AND status IN ('bounce', 'cancelled', 'queued')`,
      ).bind(sendJobId),
      env.DB.prepare(
        "UPDATE send_jobs SET mail_credential_id = ?, status = 'pending', bounce_count = 0, finished_at = NULL WHERE id = ? AND account_id = ?",
      ).bind(credentialId, sendJobId, accountId),
    ]);

    const quota = await remainingQuotaForCredential(env, accountId, credentialId);
    const queued =
      quota.remaining > 0 ? await enqueueWithinLimits(env, sendJobId, quota.remaining) : 0;
    return {
      ok: true,
      status: queued > 0 ? "sending" : "pending",
      queued,
      mailCredentialId: credentialId,
    };
  }

  if (["pending", "sending"].includes(job.status)) {
    throw new Error("Avbryt utskicket innan det tas bort");
  }

  await env.DB.batch([
    env.DB.prepare("DELETE FROM send_log WHERE send_job_id = ? AND account_id = ?").bind(
      sendJobId,
      accountId,
    ),
    env.DB.prepare("DELETE FROM send_jobs WHERE id = ? AND account_id = ?").bind(
      sendJobId,
      accountId,
    ),
  ]);
  return { ok: true, deleted: true };
}

async function updateRemainingLetter(
  env: Env,
  accountId: string,
  sendJobId: string,
  input: SendRateInput,
): Promise<Record<string, unknown>> {
  const job = await env.DB.prepare(
    "SELECT id, letter_id, status FROM send_jobs WHERE id = ? AND account_id = ?",
  )
    .bind(sendJobId, accountId)
    .first<{ id: string; letter_id: string; status: string }>();
  if (!job) throw new Error("Utskicket hittades inte");
  if (!["pending", "sending"].includes(job.status))
    throw new Error("Bara ett pågående utskick kan redigeras");

  const statements: D1PreparedStatement[] = [];
  if (input.letterHtml !== undefined) {
    validateLetterContent(input.letterHtml);
    statements.push(
      env.DB.prepare("UPDATE letters SET html_body = ? WHERE id = ?").bind(
        await encryptLetterData(env, input.letterHtml),
        job.letter_id,
      ),
    );
  }
  if (input.subject !== undefined) {
    if (input.subject.length > 998) throw new Error("Ämnesraden är för lång");
    const subject = input.subject.trim() || null;
    statements.push(
      env.DB.prepare(
        "UPDATE send_job_recipients SET subject = ? WHERE send_job_id = ? AND status IN ('pending','queued')",
      ).bind(subject, sendJobId),
    );
  }
  if (!statements.length) throw new Error("Ingen brevändring angavs");
  await env.DB.batch(statements);
  return { ok: true, updated: true };
}

export async function updateSendJobRate(
  env: Env,
  accountId: string,
  sendJobId: string,
  input: SendRateInput,
): Promise<Record<string, unknown>> {
  if (input.action) return handleSendJobAction(env, accountId, sendJobId, input);
  if (input.letterHtml !== undefined || input.subject !== undefined) {
    return updateRemainingLetter(env, accountId, sendJobId, input);
  }

  const job = await env.DB.prepare(
    "SELECT id, mail_credential_id, status FROM send_jobs WHERE id = ? AND account_id = ?",
  )
    .bind(sendJobId, accountId)
    .first<{ id: string; mail_credential_id: string; status: string }>();
  if (!job) throw new Error("Utskicket hittades inte");
  if (!["pending", "sending"].includes(job.status))
    throw new Error("Takt kan bara ändras för ett pågående utskick");

  const rate = parseRateInput(input);
  await env.DB.prepare(
    "UPDATE send_jobs SET daily_limit = ?, next_daily_limit = ?, limit_switch_at = ? WHERE id = ? AND account_id = ?",
  )
    .bind(rate.dailyLimit, rate.nextDailyLimit, rate.limitSwitchAt, sendJobId, accountId)
    .run();

  const providerQuota = await remainingQuotaForCredential(env, accountId, job.mail_credential_id);
  if (providerQuota.remaining > 0)
    await enqueueWithinLimits(env, sendJobId, providerQuota.remaining);
  return rate;
}
