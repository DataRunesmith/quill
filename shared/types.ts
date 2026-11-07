// Delade typer mellan app-worker (producent) och sender-worker (konsument).

// OBS: brevkroppen ligger MEDVETET inte i meddelandet — den kan vara stor
// (inline-extraherade bilagor) och skulle annars dupliceras en gång per
// mottagare genom kön. Sender hämtar html_body från letters via send_jobs
// .letter_id, en gång per jobb. Ämnet är litet och får ligga kvar här.
export interface SendJobMessage {
  sendJobId: string;
  accountId: string;
  mailCredentialId: string;
  recipientEmail: string;
  recipientName: string;
  subject?: string;
  // Saknas bara på meddelanden som skapades före generationskontrollen.
  queuedAt?: number;
}
// Cloudflare Email Service-bindingen (send_email i wrangler.jsonc). Objekt-
// API:t (send({to, from, ...})) finns ännu inte i @cloudflare/workers-types —
// typad minimalt här tills dess. Delad av app (bekräftelsemail) och campaign
// (nyhetsbrev + kvartalsdränering).
export interface EmailSendBinding {
  send(options: {
    to: string | string[];
    from: { email: string; name?: string };
    replyTo?: string;
    subject: string;
    html?: string;
    text?: string;
    headers?: Record<string, string>;
  }): Promise<{ messageId?: string }>;
}
