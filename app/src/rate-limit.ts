import { sha256Hex } from "../../shared/crypto";
import type { Env } from "./db";

// Authentication attempts are serialized by one Durable Object per
// (bucket, identifier). KV read/modify/write is not atomic and allowed
// parallel guesses to bypass the previous counter.

async function attemptObject(env: Env, bucket: string, identifier: string) {
  const key = await sha256Hex(`${bucket}:${identifier.trim().toLocaleLowerCase("sv-SE")}`);
  return env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(`auth-attempt:${key}`));
}

export async function enforceAttemptLimit(
  env: Env,
  bucket: string,
  identifier: string,
  opts: { max: number; windowSeconds: number },
): Promise<void> {
  const response = await (await attemptObject(env, bucket, identifier)).fetch(
    "https://rate-limiter/attempt",
    { method: "POST", body: JSON.stringify(opts) },
  );
  if (!response.ok) throw new Error("Inloggningsskyddet är tillfälligt otillgängligt");
  const result = await response.json<{ allowed?: boolean }>();
  if (result.allowed !== true)
    throw new Error("För många försök — vänta en stund och försök igen.");
}

export async function clearAttempts(env: Env, bucket: string, identifier: string): Promise<void> {
  const response = await (await attemptObject(env, bucket, identifier)).fetch(
    "https://rate-limiter/clear-attempts",
    { method: "POST" },
  );
  if (!response.ok) throw new Error("Inloggningsskyddet kunde inte återställas");
}
