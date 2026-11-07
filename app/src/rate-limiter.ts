// En Durable Object-instans per mail_credential_id — ger en sann, serialiserad
// koordinationspunkt mellan kö-konsumentens samtidiga invocations (max_concurrency
// i wrangler.jsonc), något D1/KV inte kan garantera utan kapplöpningar.
//
// Token bucket: samma mailkonto delar EN bucket oavsett vilket send_job
// meddelandet kommer från, så två jobb mot samma konto håller sig
// tillsammans under leverantörens takt. Olika mailkonton (skilda
// credential-id:n) får varsin DO-instans och påverkar aldrig varandra.

interface BucketState {
  tokens: number;
  lastRefillMs: number;
}

interface AcquireRequest {
  capacity: number;
  refillPerMinute: number;
}

export class CredentialRateLimiter {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const { capacity, refillPerMinute } = await request.json<AcquireRequest>();
    const now = Date.now();

    let bucket = await this.state.storage.get<BucketState>("bucket");
    if (!bucket) {
      bucket = { tokens: capacity, lastRefillMs: now };
    }

    const refillPerMs = refillPerMinute / 60_000;
    const elapsedMs = Math.max(0, now - bucket.lastRefillMs);
    const refilled = Math.min(capacity, bucket.tokens + elapsedMs * refillPerMs);

    if (refilled >= 1) {
      await this.state.storage.put<BucketState>("bucket", {
        tokens: refilled - 1,
        lastRefillMs: now,
      });
      return Response.json({ granted: true });
    }

    await this.state.storage.put<BucketState>("bucket", { tokens: refilled, lastRefillMs: now });
    const msUntilNextToken = Math.ceil((1 - refilled) / refillPerMs);
    return Response.json({ granted: false, retryAfterMs: msUntilNextToken });
  }
}
