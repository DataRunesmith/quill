import type { Env } from "./db";

// Enkel försöksbegränsning för autentiseringsflöden, via SESSIONS-KV.
// Best-effort: KV är eventually consistent och läs+skriv är inte atomiskt,
// så enstaka samtidiga försök kan slinka förbi — samma medvetna kompromiss
// som dygnstaket i draft-letter. Räcker som broms mot brute-force i den här
// skalan; en hård spärr skulle kräva en Durable Object.
//
// Nyckeln innehåller aldrig hemligheter (bara e-post/konto-id + bucket-namn)
// och svaret är alltid samma generiska fel oavsett om kontot finns — så
// spärren i sig avslöjar inte om en e-postadress är registrerad.

const KEY_PREFIX = "ratelimit";

function bucketKey(bucket: string, identifier: string): string {
  return `${KEY_PREFIX}:${bucket}:${identifier.toLowerCase()}`;
}

export async function enforceAttemptLimit(
  env: Env,
  bucket: string,
  identifier: string,
  opts: { max: number; windowSeconds: number },
): Promise<void> {
  const count = parseInt((await env.SESSIONS.get(bucketKey(bucket, identifier))) ?? "0", 10);
  if (count >= opts.max) {
    throw new Error("För många försök — vänta en stund och försök igen.");
  }
}

// Glidande fönster: varje nytt misslyckande förlänger TTL:en, så ihållande
// försök håller spärren aktiv tills det varit tyst i windowSeconds.
export async function recordFailedAttempt(
  env: Env,
  bucket: string,
  identifier: string,
  windowSeconds: number,
): Promise<void> {
  const key = bucketKey(bucket, identifier);
  const count = parseInt((await env.SESSIONS.get(key)) ?? "0", 10);
  await env.SESSIONS.put(key, String(count + 1), { expirationTtl: windowSeconds });
}

export async function clearAttempts(env: Env, bucket: string, identifier: string): Promise<void> {
  await env.SESSIONS.delete(bucketKey(bucket, identifier));
}
