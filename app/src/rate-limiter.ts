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
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const pathname = new URL(request.url).pathname;

    if (pathname === "/attempt") {
      const { max, windowSeconds } = await request.json<{ max: number; windowSeconds: number }>();
      if (!Number.isSafeInteger(max) || max < 1 || !Number.isSafeInteger(windowSeconds) || windowSeconds < 1)
        return Response.json({ error: "Invalid attempt limit" }, { status: 400 });
      const now = Date.now();
      const current = await this.state.storage.get<{ count: number; lastAttemptMs: number }>("attempt");
      const count =
        !current || now - current.lastAttemptMs >= windowSeconds * 1000 ? 0 : current.count;
      if (count >= max) return Response.json({ allowed: false });
      await this.state.storage.put("attempt", { count: count + 1, lastAttemptMs: now });
      return Response.json({ allowed: true });
    }

    if (pathname === "/clear-attempts") {
      await this.state.storage.delete("attempt");
      return Response.json({ cleared: true });
    }

    if (pathname !== "/acquire") return new Response("Not found", { status: 404 });
    const { capacity, refillPerMinute } = await request.json<AcquireRequest>();
    if (
      !Number.isFinite(capacity) ||
      capacity < 1 ||
      !Number.isFinite(refillPerMinute) ||
      refillPerMinute <= 0
    ) {
      return Response.json({ error: "Invalid token bucket parameters" }, { status: 400 });
    }
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
