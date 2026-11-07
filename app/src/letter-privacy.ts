import { decryptSecret, encryptSecret } from "../../shared/crypto";
import type { Env } from "./db";

const PREFIX = "enc:v1:";
const REDACTED = "redacted:v1";
const BACKFILL_BATCH = 50;
type PrivacyEnv = Env & { LETTER_DATA_KEY?: string };

function keyFor(env: PrivacyEnv): string {
  return env.LETTER_DATA_KEY || env.MAIL_CRED_KEY;
}
export function isEncryptedLetterData(value: string): boolean {
  return value.startsWith(PREFIX);
}
export async function encryptLetterData(env: PrivacyEnv, plaintext: string): Promise<string> {
  if (isEncryptedLetterData(plaintext) || plaintext === REDACTED) return plaintext;
  return PREFIX + (await encryptSecret(plaintext, keyFor(env)));
}
export async function decryptLetterData(env: PrivacyEnv, stored: string): Promise<string> {
  if (stored === REDACTED) return "";
  if (!isEncryptedLetterData(stored)) return stored;
  return decryptSecret(stored.slice(PREFIX.length), keyFor(env));
}

async function backfillUserLetters(env: PrivacyEnv): Promise<void> {
  const { results } = await env.DB.prepare(
    "SELECT id,html_body AS content FROM letters WHERE html_body NOT LIKE 'enc:v1:%' AND html_body != ? LIMIT ?",
  )
    .bind(REDACTED, BACKFILL_BATCH)
    .all<{ id: string; content: string }>();
  for (const row of results) {
    await env.DB.prepare(
      "UPDATE letters SET html_body=? WHERE id=? AND html_body NOT LIKE 'enc:v1:%' AND html_body != ?",
    )
      .bind(await encryptLetterData(env, row.content), row.id, REDACTED)
      .run();
  }
}

async function redactFinishedUserLetters(env: PrivacyEnv, now: number): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT l.id FROM letters l JOIN send_jobs sj ON sj.letter_id=l.id WHERE sj.status IN ('done','aborted','cancelled') AND sj.content_delete_at IS NOT NULL AND sj.content_delete_at <= ? AND l.html_body != ? LIMIT 100`,
  )
    .bind(now, REDACTED)
    .all<{ id: string }>();
  for (const row of results) {
    const { results: attachments } = await env.DB.prepare(
      "SELECT r2_key FROM letter_attachments WHERE letter_id=?",
    )
      .bind(row.id)
      .all<{ r2_key: string }>();
    if (attachments.length) {
      try {
        await env.ATTACHMENTS.delete(attachments.map((a) => a.r2_key));
      } catch (error) {
        console.warn("letter-retention: R2 cleanup failed", {
          letterId: row.id,
          error: String(error),
        });
        continue;
      }
    }
    await env.DB.batch([
      env.DB.prepare("DELETE FROM letter_attachments WHERE letter_id=?").bind(row.id),
      env.DB.prepare("UPDATE letters SET html_body=? WHERE id=?").bind(REDACTED, row.id),
      env.DB.prepare(
        "UPDATE send_jobs SET intro_text=? WHERE letter_id=? AND intro_text IS NOT NULL",
      ).bind(REDACTED, row.id),
    ]);
  }
}

export async function protectStoredLetterData(env: PrivacyEnv): Promise<void> {
  await backfillUserLetters(env);
}
export async function enforceLetterRetention(env: PrivacyEnv): Promise<void> {
  await redactFinishedUserLetters(env, Date.now());
}
