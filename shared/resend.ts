// Minimal Resend-klient (https://resend.com) — används för nyhetsbrevet och
// kvartalsbrevet. Avsändaren måste ligga på en domän som är verifierad i Resend.
//
// Kvoter (free-planen): 100 mail/dag, 3 000/mån, max 2 anrop/sekund.
// 429 = kvot/rate limit — kastas som ResendQuotaError så anroparen kan pausa
// och låta nästa cron-slot fortsätta, istället för att felmarkera mottagare.

export interface ResendMail {
  to: string;
  from: string; // "Namn <noreply@example.com>" — måste ligga på den verifierade domänen
  replyTo?: string;
  subject: string;
  html?: string;
  text?: string;
  headers?: Record<string, string>;
}

export class ResendQuotaError extends Error {}

export async function sendResendMail(apiKey: string, mail: ResendMail): Promise<void> {
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: mail.from,
      to: [mail.to],
      reply_to: mail.replyTo,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      headers: mail.headers,
    }),
  });
  if (resp.status === 429) throw new ResendQuotaError((await resp.text()).slice(0, 200));
  if (!resp.ok) throw new Error(`Resend ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
}
