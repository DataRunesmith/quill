import { randomId } from "../../shared/crypto";
import { escapeHtml } from "../../shared/html";
import { sendSystemMail } from "./auth";
import type { Env } from "./db";

const MAX_NEW_AUTO_ERROR_EMAILS_PER_DAY = 20;
const MAX_FEEDBACK_CHARS = 5_000;
const MAX_CONTEXT_CHARS = 12_000;
const MAX_REPLY_TO_CHARS = 254;

export async function reportClientError(
  env: Env,
  input: { message: string; stack?: string; url?: string },
): Promise<{ reported: boolean }> {
  const message = (input.message || "okänt fel").slice(0, 300);
  const stack = (input.stack ?? "").slice(0, 2000);
  const frame = stack.match(/(\w+\.(?:js|ts|css)):(\d+)/);
  const signature = `${message}|${frame ? `${frame[1]}:${frame[2]}` : ""}`;
  const now = Date.now();

  const existing = await env.DB.prepare("SELECT 1 FROM client_errors WHERE signature = ?")
    .bind(signature)
    .first();
  if (existing) {
    await env.DB.prepare(
      "UPDATE client_errors SET count = count + 1, last_seen = ? WHERE signature = ?",
    )
      .bind(now, signature)
      .run();
    return { reported: false };
  }

  await env.DB.prepare(
    "INSERT INTO client_errors (signature, message, count, first_seen, last_seen) VALUES (?, ?, 1, ?, ?)",
  )
    .bind(signature, message, now, now)
    .run();

  const since24h = now - 24 * 60 * 60 * 1000;
  const day = await env.DB.prepare(
    "SELECT COUNT(*) as n FROM client_errors WHERE email_notified_at >= ?",
  )
    .bind(since24h)
    .first<{ n: number }>();
  if ((day?.n ?? 0) >= MAX_NEW_AUTO_ERROR_EMAILS_PER_DAY) return { reported: false };

  try {
    const subject = `Automatiskt klientfel — ${message.slice(0, 80)}`;
    const html = [
      "<p>Automatiskt rapporterat JavaScript-fel i produktion.</p>",
      `<p><strong>Fel:</strong> ${escapeHtml(message)}</p>`,
      input.url ? `<p><strong>Sida:</strong> ${escapeHtml(input.url.slice(0, 500))}</p>` : "",
      stack ? `<pre>${escapeHtml(stack)}</pre>` : "",
    ].join("");
    await sendSystemMail(env, env.FEEDBACK_NOTIFY_EMAIL, subject, html);
    await env.DB.prepare("UPDATE client_errors SET email_notified_at = ? WHERE signature = ?")
      .bind(now, signature)
      .run();
    return { reported: true };
  } catch {
    // Best effort — felet är redan sparat i client_errors.
  }
  return { reported: false };
}

interface WorkerError {
  method: string;
  endpoint: string;
  status: number;
  error_message: string;
  created_at: number;
}

export async function submitFeedback(
  env: Env,
  input: {
    accountId: string | null;
    message: string;
    context?: Record<string, unknown>;
    type?: "bug" | "contact";
    replyTo?: string;
  },
): Promise<{ received: true; id: string }> {
  const message = (input.message ?? "").trim();
  if (!message) throw new Error("Meddelande krävs");
  if (message.length > MAX_FEEDBACK_CHARS)
    throw new Error(`Meddelandet får vara högst ${MAX_FEEDBACK_CHARS} tecken`);

  const isContact = input.type === "contact";
  const replyTo = input.replyTo?.trim() || null;
  if (replyTo && replyTo.length > MAX_REPLY_TO_CHARS) throw new Error("Svarsadressen är för lång");

  let contextJson = "";
  if (input.context) {
    contextJson = JSON.stringify(input.context, null, 2);
    if (contextJson.length > MAX_CONTEXT_CHARS) throw new Error("Klientkontexten är för stor");
  }

  const wantsReply = replyTo ? 1 : 0;
  const feedbackId = randomId();

  const since48h = Date.now() - 48 * 60 * 60 * 1000;
  const serverErrors: WorkerError[] = [];
  if (input.accountId) {
    const { results } = await env.DB.prepare(
      "SELECT method, endpoint, status, error_message, created_at FROM worker_errors WHERE account_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 20",
    )
      .bind(input.accountId, since48h)
      .all<WorkerError>();
    serverErrors.push(...results);
  }

  env.DB.prepare("DELETE FROM worker_errors WHERE created_at < ?")
    .bind(since48h)
    .run()
    .catch(() => {});

  await env.DB.prepare(
    "INSERT INTO feedback (id, account_id, message, github_issue_url, created_at, reply_to, wants_reply, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      feedbackId,
      input.accountId,
      message,
      null,
      Date.now(),
      replyTo,
      wantsReply,
      isContact ? "contact" : "feedback",
    )
    .run();

  const mailSubject = isContact
    ? "Ny kontaktfråga — __PUBLIC_HOST__"
    : "Ny feedback — __PUBLIC_HOST__";
  const mailHtml = [
    replyTo
      ? `<p>Svar önskas till: ${escapeHtml(replyTo)}</p>`
      : "<p>Ingen återkoppling via e-post begärd.</p>",
    `<p>${escapeHtml(message)}</p>`,
    `<p><strong>Ärende:</strong> ${escapeHtml(feedbackId)}</p>`,
    `<p><strong>Konto:</strong> ${escapeHtml(input.accountId ?? "ej inloggad")}</p>`,
    contextJson
      ? `<p><strong>Klientkontext:</strong></p><pre>${escapeHtml(contextJson)}</pre>`
      : "",
    serverErrors.length > 0
      ? `<p><strong>Serverfel senaste 48 timmarna:</strong></p><pre>${escapeHtml(
          serverErrors
            .map((error) => {
              const timestamp = new Date(error.created_at).toISOString();
              return `${timestamp}  ${error.method} ${error.endpoint}  ${error.status}  ${error.error_message}`;
            })
            .join("\n"),
        )}</pre>`
      : "",
  ].join("");

  await sendSystemMail(env, env.FEEDBACK_NOTIFY_EMAIL, mailSubject, mailHtml);

  return { received: true, id: feedbackId };
}
