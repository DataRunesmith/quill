import baseApp from "./index";
import { getSessionContext, writeSession } from "./auth";
import { getAccountFromApiKey } from "./api-keys";
import { d1ReplicaEligibleRequest, d1SessionBookmark, withD1Session } from "./d1-session";
import { pruneVisits } from "./visits";
import { getAccountById, type Env } from "./db";
import type { SendJobMessage } from "../../shared/types";
import { enforceLetterRetention, protectStoredLetterData } from "./letter-privacy";

export { CredentialRateLimiter } from "./rate-limiter";

const FRESH_AUTH_MS = 15 * 60 * 1000;
const MAX_SEND_REQUEST_BYTES = 30 * 1024 * 1024;

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self' https://challenges.cloudflare.com https://cdn.jsdelivr.net",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    "connect-src 'self' https://challenges.cloudflare.com",
    "frame-src https://challenges.cloudflare.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
  ].join("; "),
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Resource-Policy": "same-origin",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
function getCookie(req: Request, name: string): string | null {
  const cookie = req.headers.get("Cookie") ?? "";
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? match[1] : null;
}
function apiKeyRouteAllowed(method: string, pathname: string): boolean {
  if (
    method === "GET" &&
    [
      "/api/me",
      "/api/areas",
      "/api/parties",
      "/api/roles",
      "/api/provider-ceilings",
      "/api/send-jobs",
    ].includes(pathname)
  )
    return true;
  if (
    method === "GET" &&
    ["/api/public-contacts/search", "/api/politicians/search"].includes(pathname)
  )
    return true;
  if (method === "POST" && ["/api/recipients/count", "/api/send"].includes(pathname)) return true;
  if (method === "PATCH" && /^\/api\/send-jobs\/[^/]+\/rate$/.test(pathname)) return true;
  return false;
}
/**
 * Avgör om en route kräver en nyligen autentiserad vanlig webbsession.
 *
 * SMTP-anslutningstest behandlas som en säkerhetskänslig credential-operation
 * och tillåts därför inte enbart med en äldre session eller API-nyckel.
 *
 * @param method - HTTP-metod med versaler.
 * @param pathname - URL-sökväg utan query string.
 * @returns `true` när anroparen måste verifiera en fresh web session.
 */
function needsFreshSession(method: string, pathname: string): boolean {
  if (
    method === "POST" &&
    ([
      "/api/totp/setup",
      "/api/totp/confirm",
      "/api/totp/disable",
      "/api/set-password",
      "/api/delete-account",
      "/api/api-keys",
      "/api/mail-credentials",
    ].includes(pathname) ||
      /^\/api\/mail-credentials\/[^/]+\/(?:test|password)$/.test(pathname))
  )
    return true;
  if (
    method === "DELETE" &&
    (/^\/api\/api-keys\/[^/]+$/.test(pathname) ||
      /^\/api\/oauth-identities\/[a-z]+$/.test(pathname) ||
      /^\/api\/mail-credentials\/[^/]+$/.test(pathname))
  )
    return true;
  if (
    method === "GET" &&
    /^\/api\/(?:oauth-link\/[a-z]+|oauth-mail\/microsoft)\/start$/.test(pathname)
  )
    return true;
  return false;
}
function isCrossSiteMutation(req: Request, url: URL, bearer: boolean): boolean {
  if (
    bearer ||
    !url.pathname.startsWith("/api/") ||
    ["GET", "HEAD", "OPTIONS"].includes(req.method)
  )
    return false;
  const fetchSite = req.headers.get("Sec-Fetch-Site");
  if (fetchSite === "cross-site") return true;
  // Cookie-authenticated mutations must carry the exact same-origin Origin.
  // Missing Origin is not proof of same-origin and must fail closed.
  return req.headers.get("Origin") !== url.origin;
}
async function takeRateLimit(
  env: Env,
  key: string,
  capacity: number,
  refillPerMinute: number,
): Promise<boolean> {
  const id = env.RATE_LIMITER.idFromName(`web-abuse:${key}`);
  try {
    const response = await env.RATE_LIMITER.get(id).fetch("https://rate-limiter/acquire", {
      method: "POST",
      body: JSON.stringify({ capacity, refillPerMinute }),
    });
    const result = await response.json<{ granted?: boolean }>();
    return result.granted === true;
  } catch {
    return false;
  }
}
async function allowPublicWrite(req: Request, env: Env, pathname: string): Promise<boolean> {
  const ip = req.headers.get("CF-Connecting-IP") ?? "unknown";
  if (pathname === "/api/feedback")
    return (
      (await takeRateLimit(env, `feedback:${ip}`, 10, 2)) &&
      (await takeRateLimit(env, "feedback:global", 120, 60))
    );
  return (
    (await takeRateLimit(env, `client-error:${ip}`, 30, 10)) &&
    (await takeRateLimit(env, "client-error:global", 300, 120))
  );
}
async function upgradeOAuthSession(req: Request, env: Env, response: Response): Promise<void> {
  const pathname = new URL(req.url).pathname;
  if (
    req.method !== "GET" ||
    !/^\/api\/oauth\/[a-z]+\/callback$/.test(pathname) ||
    response.status !== 302
  )
    return;
  const token = (response.headers.get("Set-Cookie") ?? "").match(/(?:^|;\s*)session=([^;]+)/)?.[1];
  if (!token) return;
  const raw = await env.SESSIONS.get(`session:${token}`);
  if (!raw || (await getSessionContext(env, token))) return;
  try {
    const account = await getAccountById(env.DB, raw);
    if (!account) throw new Error("Konto saknas eller är inaktiverat");
    await writeSession(env, token, account, Date.now());
  } catch (error) {
    await env.SESSIONS.delete(`session:${token}`).catch(() => {});
    throw error;
  }
}
function applyCachePolicy(headers: Headers, pathname: string): void {
  if (pathname.startsWith("/api/")) {
    headers.set("Cache-Control", "no-store");
    return;
  }
  if (pathname === "/recipient-meta.json") {
    headers.set("Cache-Control", "public, max-age=300, stale-while-revalidate=86400");
    return;
  }
  if (/\.(?:js|css)$/.test(pathname)) {
    // Filnamnen är ännu inte innehållshashade, därför kort browser-TTL med
    // lång stale-while-revalidate i stället för immutable.
    headers.set("Cache-Control", "public, max-age=3600, stale-while-revalidate=86400");
    return;
  }
  if (/\.(?:svg|png|webp|ico)$/.test(pathname)) {
    headers.set("Cache-Control", "public, max-age=86400, stale-while-revalidate=604800");
    return;
  }
  // HTML ska alltid kunna revalideras så deployer syns direkt utan att
  // användaren behöver rensa cache eller ladda om hårt.
  headers.set("Cache-Control", "no-cache");
}
function withSecurityHeaders(response: Response, pathname: string): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  applyCachePolicy(headers, pathname);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function baseAppEnvForRequest(req: Request, primaryEnv: Env, bearer: boolean): Promise<Env> {
  const pathname = new URL(req.url).pathname;
  if (!d1ReplicaEligibleRequest(req.method, pathname)) return primaryEnv;

  let authenticated = Boolean(
    (await getSessionContext(primaryEnv, getCookie(req, "session")))?.account,
  );
  if (!authenticated && bearer) {
    const token = req.headers.get("Authorization")?.slice("Bearer ".length) ?? "";
    authenticated = Boolean(await getAccountFromApiKey(primaryEnv, token));
  }
  if (!authenticated) return primaryEnv;

  const bookmark = d1SessionBookmark(primaryEnv);
  return withD1Session(primaryEnv, bookmark ?? "first-unconstrained");
}

async function requestBodyExceedsLimit(req: Request, maxBytes: number): Promise<boolean> {
  const contentLengthHeader = req.headers.get("Content-Length");
  if (contentLengthHeader !== null) {
    if (!/^\\d+$/.test(contentLengthHeader)) return true;
    const contentLength = Number(contentLengthHeader);
    if (!Number.isSafeInteger(contentLength) || contentLength > maxBytes) return true;
    return false;
  }

  const body = req.clone().body;
  if (!body) return false;
  const reader = body.getReader();
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return false;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return true;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function requestBodyLimit(pathname: string): number {
  if (pathname === "/api/send") return MAX_SEND_REQUEST_BYTES;
  if (pathname === "/api/feedback") return 64 * 1024;
  if (pathname === "/api/client-error") return 32 * 1024;
  return 5 * 1024 * 1024;
}

async function secureFetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  const primaryEnv = withD1Session(env, "first-primary");
  const bearer = req.headers.get("Authorization")?.startsWith("Bearer ") === true;
  if (isCrossSiteMutation(req, url, bearer)) {
    return withSecurityHeaders(json({ error: "Cross-site-begäran blockerad" }, 403), url.pathname);
  }
  if (bearer && url.pathname.startsWith("/api/") && !apiKeyRouteAllowed(req.method, url.pathname)) {
    const session = await getSessionContext(primaryEnv, getCookie(req, "session"));
    if (!session)
      return withSecurityHeaders(
        json({ error: "API-nyckeln saknar behörighet för den här operationen" }, 403),
        url.pathname,
      );
  }
  if (needsFreshSession(req.method, url.pathname)) {
    const session = await getSessionContext(primaryEnv, getCookie(req, "session"));
    if (!session)
      return withSecurityHeaders(
        json({ error: "Den här säkerhetsändringen kräver en vanlig webbsession" }, 403),
        url.pathname,
      );
    if (Date.now() - session.authenticatedAt > FRESH_AUTH_MS)
      return withSecurityHeaders(
        json(
          { error: "Bekräfta att det är du för att fortsätta", code: "FRESH_AUTH_REQUIRED" },
          403,
        ),
        url.pathname,
      );
  }
  if (
    req.method !== "GET" &&
    req.method !== "HEAD" &&
    req.method !== "OPTIONS" &&
    url.pathname.startsWith("/api/") &&
    (await requestBodyExceedsLimit(req, requestBodyLimit(url.pathname)))
  ) {
    return withSecurityHeaders(json({ error: "För stor begäran" }, 413), url.pathname);
  }
  if (
    req.method === "POST" &&
    (url.pathname === "/api/feedback" || url.pathname === "/api/client-error")
  ) {
    if (!(await allowPublicWrite(req, primaryEnv, url.pathname)))
      return withSecurityHeaders(
        json({ error: "För många anrop — försök igen senare" }, 429),
        url.pathname,
      );
  }
  const appEnv = await baseAppEnvForRequest(req, primaryEnv, bearer);
  const response = await baseApp.fetch(req, appEnv, ctx);
  try {
    await upgradeOAuthSession(req, primaryEnv, response);
  } catch {
    return withSecurityHeaders(
      json({ error: "Kontot kunde inte skapa en giltig session" }, 403),
      url.pathname,
    );
  }
  return withSecurityHeaders(response, url.pathname);
}

export default {
  fetch: secureFetch,
  queue: (batch, env) => baseApp.queue(batch, withD1Session(env, "first-primary")),
  scheduled: async (event: ScheduledController, env: Env, ctx: ExecutionContext) => {
    env = withD1Session(env, "first-primary");
    ctx.waitUntil(pruneVisits(env));
    await baseApp.scheduled(event, env, ctx);
    await protectStoredLetterData(env);
    await enforceLetterRetention(env);
  },
} satisfies ExportedHandler<Env, SendJobMessage>;
