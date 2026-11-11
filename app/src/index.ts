import {
  signup,
  verifyEmail,
  login,
  getAccountFromSession,
  requestPasswordReset,
  resetPassword,
  startTotpSetup,
  confirmTotpSetup,
  disableTotp,
  setPassword,
  adminResetPassword,
  reauthenticateAccount,
  writeSession,
  setAccountDisabled,
  deleteOwnAccount,
} from "./auth";
import { getAdminStats, exportAdminData, getTimeSeries, type Granularity } from "./admin-stats";
import { recordVisit } from "./visits";
import { cachedAggregate } from "./aggregate-cache";
import {
  addMailCredential,
  listMailCredentials,
  deleteMailCredential,
  addMicrosoftGraphMailCredential,
  updateMailCredentialCapPct,
  testStoredSmtpCredential,
  updateStoredSmtpCredentialPassword,
  PROVIDER_PRESETS,
  getCeiling,
  MICROSOFT_GRAPH_DAILY_LIMIT,
} from "./mail-credentials";
import {
  listAreas,
  listParties,
  listRoles,
  searchPublicContactsInAreas,
  getRecipientsForAreas,
  deleteAccount,
} from "./db";
import {
  deletePrivateContact,
  deletePrivateContactList,
  importPrivateContactList,
  listPrivateContacts,
  savePrivateContact,
  type PrivateContactInput,
} from "./private-contacts";
import {
  createAndEnqueueSendJob,
  enqueuePendingUserSendJobs,
  getSendJobsForAccount,
  updateSendJobRate,
} from "./send";
import { submitFeedback, reportClientError } from "./feedback";
import { processAttachments, type AttachmentInput } from "./attachments";
import { createApiKey, listApiKeys, revokeApiKey, getAccountFromApiKey } from "./api-keys";
import {
  getAuthorizeUrl,
  handleOAuthCallback,
  getLinkAuthorizeUrl,
  handleOAuthLinkCallback,
  getOAuthIdentities,
  unlinkOAuthIdentity,
  providerSharesLoginCallback,
} from "./oauth";
import { getMicrosoftMailAuthorizeUrl } from "../../shared/graph-mail";
import { randomId } from "../../shared/crypto";
import { verifyTurnstile } from "./turnstile";
import type { Env } from "./db";
import { handleSendQueue } from "./send-queue";
import type { SendJobMessage } from "../../shared/types";
import { encryptLetterData } from "./letter-privacy";
import {
  createLetterIntroPreset,
  deleteLetterIntroPreset,
  listLetterIntroPresets,
  normalizeSelectedLetterIntroText,
  updateLetterIntroPreset,
  type LetterIntroPresetInput,
} from "./letter-intro-presets";

export { CredentialRateLimiter } from "./rate-limiter";

const ALLOWED_RETENTION_MS = new Set([300000, 86400000, 259200000, 604800000]);
const MAX_LETTER_HTML_BYTES = 1024 * 1024;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
function getCookie(req: Request, name: string): string | null {
  const cookie = req.headers.get("Cookie") ?? "";
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\function getCookie(req: Request, name: string): string | null {
  const cookie = req.headers.get("Cookie") ?? "";
  const match = cookie.match(new RegExp(`${name}=([^;]+)`));
  return match ? match[1] : null;
}");
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${escapedName}=([^;]*)`));
  return match ? match[1] : null;
}
function setSessionCookie(token: string): string {
  return `session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 30}`;
}
function requestedRetentionMs(req: Request): number {
  const raw =
    req.headers.get("X-Letter-Retention-Ms") ?? getCookie(req, "letter_retention_ms") ?? "300000";
  const value = Number(raw);
  return ALLOWED_RETENTION_MS.has(value) ? value : 300000;
}

export default {
  async fetch(req: Request, env: Env, execCtx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/") execCtx.waitUntil(recordVisit(env, req));
    const resp = await handleRequest(req, env, url);
    const headers = new Headers(resp.headers);
    headers.delete("Speculation-Rules");
    headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    if (url.pathname.startsWith("/api/")) headers.set("Cache-Control", "no-store");
    if (
      url.pathname.startsWith("/api/") &&
      resp.status >= 400 &&
      resp.status !== 401 &&
      resp.status !== 404
    ) {
      try {
        const data = await resp.clone().json<{ error?: string }>();
        const sessionToken = getCookie(req, "session");
        const account = sessionToken ? await getAccountFromSession(env, sessionToken) : null;
        await env.DB.prepare(
          "INSERT INTO worker_errors (id, account_id, method, endpoint, status, error_message, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
          .bind(
            randomId(),
            account?.id ?? null,
            req.method,
            url.pathname,
            resp.status,
            data.error ?? "okänt fel",
            Date.now(),
          )
          .run();
      } catch {}
    }
    return new Response(resp.body, { status: resp.status, headers });
  },
  async queue(batch: MessageBatch<SendJobMessage>, env: Env): Promise<void> {
    await handleSendQueue(batch, env);
  },
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(enqueuePendingUserSendJobs(env));
  },
} satisfies ExportedHandler<Env, SendJobMessage>;

interface RouteCtx {
  env: Env;
  req: Request;
  url: URL;
  accountId: string;
  isAdmin: boolean;
  sessionToken: string | null;
}
type RouteHandler = (c: RouteCtx, m: RegExpMatchArray) => Promise<Response> | Response;
interface RouteDef {
  method: string;
  rx: RegExp;
  h: RouteHandler;
}
async function runRoutes(routes: RouteDef[], c: RouteCtx): Promise<Response | null> {
  for (const route of routes) {
    if (c.req.method !== route.method) continue;
    const match = c.url.pathname.match(route.rx);
    if (match) return route.h(c, match);
  }
  return null;
}

const AUTHED_ROUTES: RouteDef[] = [
  {
    method: "POST",
    rx: /^\/api\/reauth$/,
    h: async (c) => {
      if (!c.sessionToken)
        return json({ error: "Återautentisering kräver en vanlig webbsession" }, 403);
      const { password, totpCode } = await c.req.json<{ password?: string; totpCode?: string }>();
      const account = await reauthenticateAccount(c.env, c.accountId, password, totpCode);
      await writeSession(c.env, c.sessionToken, account);
      return json({ ok: true });
    },
  },
  {
    method: "POST",
    rx: /^\/api\/totp\/setup$/,
    h: async (c) => json(await startTotpSetup(c.env, c.accountId)),
  },
  {
    method: "POST",
    rx: /^\/api\/totp\/confirm$/,
    h: async (c) => {
      const { code } = await c.req.json<{ code: string }>();
      await confirmTotpSetup(c.env, c.accountId, code);
      return json({ ok: true });
    },
  },
  {
    method: "POST",
    rx: /^\/api\/totp\/disable$/,
    h: async (c) => {
      await disableTotp(c.env, c.accountId);
      return json({ ok: true });
    },
  },
  {
    method: "POST",
    rx: /^\/api\/set-password$/,
    h: async (c) => {
      const { newPassword } = await c.req.json<{ newPassword: string }>();
      await setPassword(c.env, c.accountId, newPassword);
      return json({ ok: true });
    },
  },
  {
    method: "POST",
    rx: /^\/api\/delete-account$/,
    h: async (c) => {
      const { password, totpCode } = await c.req.json<{ password?: string; totpCode?: string }>();
      await deleteOwnAccount(c.env, c.accountId, password, totpCode);
      const token = getCookie(c.req, "session");
      if (token) await c.env.SESSIONS.delete(`session:${token}`);
      const resp = json({ ok: true });
      resp.headers.set("Set-Cookie", "session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0");
      return resp;
    },
  },
  {
    method: "GET",
    rx: /^\/api\/oauth-identities$/,
    h: async (c) => json(await getOAuthIdentities(c.env, c.accountId)),
  },
  {
    method: "DELETE",
    rx: /^\/api\/oauth-identities\/([a-z]+)$/,
    h: async (c, m) => {
      await unlinkOAuthIdentity(c.env, c.accountId, m[1]);
      return json({ ok: true });
    },
  },
  {
    method: "GET",
    rx: /^\/api\/api-keys$/,
    h: async (c) => json(await listApiKeys(c.env, c.accountId)),
  },
  {
    method: "POST",
    rx: /^\/api\/api-keys$/,
    h: async (c) => {
      const { name } = await c.req.json<{ name: string }>();
      return json(await createApiKey(c.env, c.accountId, name));
    },
  },
  {
    method: "DELETE",
    rx: /^\/api\/api-keys\/([^/]+)$/,
    h: async (c, m) => {
      await revokeApiKey(c.env, c.accountId, m[1]);
      return json({ ok: true });
    },
  },
  {
    method: "GET",
    rx: /^\/api\/letter-intro-presets$/,
    h: async (c) => {
      if (!c.sessionToken) return json({ error: "Kräver webbsession" }, 403);
      return json(await listLetterIntroPresets(c.env, c.accountId));
    },
  },
  {
    method: "POST",
    rx: /^\/api\/letter-intro-presets$/,
    h: async (c) => {
      if (!c.sessionToken) return json({ error: "Kräver webbsession" }, 403);
      return json(
        await createLetterIntroPreset(
          c.env,
          c.accountId,
          await c.req.json<LetterIntroPresetInput>(),
        ),
      );
    },
  },
  {
    method: "PATCH",
    rx: /^\/api\/letter-intro-presets\/([^/]+)$/,
    h: async (c, m) => {
      if (!c.sessionToken) return json({ error: "Kräver webbsession" }, 403);
      return json(
        await updateLetterIntroPreset(
          c.env,
          c.accountId,
          m[1],
          await c.req.json<LetterIntroPresetInput>(),
        ),
      );
    },
  },
  {
    method: "DELETE",
    rx: /^\/api\/letter-intro-presets\/([^/]+)$/,
    h: async (c, m) => {
      if (!c.sessionToken) return json({ error: "Kräver webbsession" }, 403);
      await deleteLetterIntroPreset(c.env, c.accountId, m[1]);
      return json({ ok: true });
    },
  },
  {
    method: "GET",
    rx: /^\/api\/areas$/,
    h: (c) => cachedAggregate("areas", () => listAreas(c.env.DB)),
  },
  {
    method: "GET",
    rx: /^\/api\/parties$/,
    h: (c) => cachedAggregate("parties", () => listParties(c.env.DB)),
  },
  {
    method: "GET",
    rx: /^\/api\/roles$/,
    h: (c) => cachedAggregate("roles", () => listRoles(c.env.DB)),
  },
  {
    method: "GET",
    rx: /^\/api\/public-contacts\/search$/,
    h: async (c) => {
      const areaNames = c.url.searchParams.getAll("areaName"),
        q = c.url.searchParams.get("q") ?? "";
      if (q.length < 2) return json([]);
      return json(await searchPublicContactsInAreas(c.env.DB, areaNames, q));
    },
  },
  {
    method: "GET",
    rx: /^\/api\/politicians\/search$/,
    h: async (c) => {
      const areaNames = c.url.searchParams.getAll("areaName"),
        q = c.url.searchParams.get("q") ?? "";
      if (q.length < 2) return json([]);
      return json(await searchPublicContactsInAreas(c.env.DB, areaNames, q));
    },
  },
  {
    method: "GET",
    rx: /^\/api\/private-contacts$/,
    h: async (c) => json(await listPrivateContacts(c.env, c.accountId)),
  },
  {
    method: "POST",
    rx: /^\/api\/private-contacts$/,
    h: async (c) =>
      json(await savePrivateContact(c.env, c.accountId, await c.req.json<PrivateContactInput>())),
  },
  {
    method: "DELETE",
    rx: /^\/api\/private-contacts\/([^/]+)$/,
    h: async (c, m) => {
      await deletePrivateContact(c.env, c.accountId, m[1]);
      return json({ ok: true });
    },
  },
  {
    method: "POST",
    rx: /^\/api\/private-contact-lists\/import$/,
    h: async (c) =>
      json(
        await importPrivateContactList(
          c.env,
          c.accountId,
          await c.req.json<{ name: string; contacts: PrivateContactInput[] }>(),
        ),
      ),
  },
  {
    method: "DELETE",
    rx: /^\/api\/private-contact-lists\/([^/]+)$/,
    h: async (c, m) => {
      await deletePrivateContactList(c.env, c.accountId, m[1]);
      return json({ ok: true });
    },
  },
  {
    method: "GET",
    rx: /^\/api\/mail-credentials$/,
    h: async (c) => json(await listMailCredentials(c.env, c.accountId)),
  },
  {
    method: "GET",
    rx: /^\/api\/provider-ceilings$/,
    h: async () => {
      const providers = [...Object.keys(PROVIDER_PRESETS), "microsoft_graph"];
      const result: Record<string, { providerDailyLimit: number | null; ceiling: number | null }> =
        {};
      for (const p of providers)
        result[p] = {
          providerDailyLimit:
            p === "microsoft_graph"
              ? MICROSOFT_GRAPH_DAILY_LIMIT
              : PROVIDER_PRESETS[p].providerDailyLimit,
          ceiling: getCeiling(p),
        };
      return json(result);
    },
  },
  {
    method: "POST",
    rx: /^\/api\/mail-credentials$/,
    h: async (c) =>
      json(
        await addMailCredential(
          c.env,
          c.accountId,
          await c.req.json<Parameters<typeof addMailCredential>[2]>(),
        ),
      ),
  },
  {
    method: "POST",
    rx: /^\/api\/mail-credentials\/([^/]+)\/test$/,
    h: async (c, m) => json(await testStoredSmtpCredential(c.env, c.accountId, m[1])),
  },
  {
    method: "POST",
    rx: /^\/api\/mail-credentials\/([^/]+)\/password$/,
    h: async (c, m) => {
      const { password } = await c.req.json<{ password: string }>();
      return json(await updateStoredSmtpCredentialPassword(c.env, c.accountId, m[1], password));
    },
  },
  {
    method: "POST",
    rx: /^\/api\/mail-credentials\/([^/]+)\/cap-pct$/,
    h: async (c, m) => {
      const { userCapPct } = await c.req.json<{ userCapPct: number }>();
      return json(await updateMailCredentialCapPct(c.env, c.accountId, m[1], userCapPct));
    },
  },
  {
    method: "DELETE",
    rx: /^\/api\/mail-credentials\/([^/]+)$/,
    h: async (c, m) => {
      await deleteMailCredential(c.env, c.accountId, m[1]);
      return json({ ok: true });
    },
  },
  {
    method: "POST",
    rx: /^\/api\/recipients\/count$/,
    h: async (c) => {
      const input = await c.req
        .json<{
          areaNames?: string[];
          excludeParties?: string[];
          excludeEmails?: string[];
          includeRoles?: string[];
          includeEmails?: string[];
        }>()
        .catch(() => ({}) as Record<string, never>);
      const recipients = await getRecipientsForAreas(
        c.env.DB,
        input.areaNames ?? [],
        input.excludeParties ?? [],
        input.excludeEmails ?? [],
        input.includeRoles ?? [],
        input.includeEmails ?? [],
      );
      return json({ count: recipients.length });
    },
  },
  {
    method: "POST",
    rx: /^\/api\/send$/,
    h: async (c) => {
      const input = await c.req.json<{
        letterHtml: string;
        introText?: string;
        subject?: string;
        mailCredentialId: string;
        areaNames: string[];
        excludeParties?: string[];
        excludeEmails?: string[];
        includeRoles?: string[];
        includeEmails?: string[];
        attachments?: AttachmentInput[];
        dailyLimit?: number | null;
        switchAfterDays?: number | null;
        nextDailyLimit?: number | null;
      }>();
      if (typeof input.letterHtml !== "string" || !input.letterHtml.trim())
        throw new Error("Brevtext krävs");
      if (new TextEncoder().encode(input.letterHtml).byteLength > MAX_LETTER_HTML_BYTES)
        throw new Error("Brevtexten är för stor");
      const introText = normalizeSelectedLetterIntroText(input.introText);
      const letterId = randomId();
      let htmlBody = input.letterHtml;
      await c.env.DB.prepare(
        "INSERT INTO letters (id, account_id, html_body, created_at) VALUES (?, ?, ?, ?)",
      )
        .bind(letterId, c.accountId, await encryptLetterData(c.env, htmlBody), Date.now())
        .run();
      if (input.attachments?.length) {
        const { extractedHtml } = await processAttachments(c.env, letterId, input.attachments);
        htmlBody += extractedHtml;
        await c.env.DB.prepare("UPDATE letters SET html_body = ? WHERE id = ?")
          .bind(await encryptLetterData(c.env, htmlBody), letterId)
          .run();
      }
      const result = await createAndEnqueueSendJob(c.env, c.accountId, {
        letterId,
        introText,
        subject: input.subject,
        mailCredentialId: input.mailCredentialId,
        areaNames: input.areaNames,
        excludeParties: input.excludeParties,
        excludeEmails: input.excludeEmails,
        includeRoles: input.includeRoles,
        includeEmails: input.includeEmails,
        dailyLimit: input.dailyLimit,
        switchAfterDays: input.switchAfterDays,
        nextDailyLimit: input.nextDailyLimit,
      });
      const retentionMs = requestedRetentionMs(c.req);
      await c.env.DB.prepare(
        "UPDATE send_jobs SET content_retention_ms=?, content_delete_at=CASE WHEN finished_at IS NOT NULL AND status IN ('done','aborted','cancelled') THEN finished_at+? ELSE content_delete_at END WHERE id=? AND account_id=?",
      )
        .bind(retentionMs, retentionMs, result.sendJobId, c.accountId)
        .run();
      return json(result);
    },
  },
  {
    method: "GET",
    rx: /^\/api\/send-jobs$/,
    h: async (c) => json(await getSendJobsForAccount(c.env, c.accountId)),
  },
  {
    method: "PATCH",
    rx: /^\/api\/send-jobs\/([^/]+)\/rate$/,
    h: async (c, m) =>
      json(
        await updateSendJobRate(
          c.env,
          c.accountId,
          m[1],
          await c.req.json<{
            dailyLimit?: number | null;
            switchAfterDays?: number | null;
            nextDailyLimit?: number | null;
          }>(),
        ),
      ),
  },
];

const ADMIN_ROUTES: RouteDef[] = [
  {
    method: "GET",
    rx: /^\/api\/admin\/accounts$/,
    h: async (c) => {
      const { results } = await c.env.DB.prepare(
        "SELECT id, email, email_verified, daily_send_cap, is_admin, disabled, created_at FROM accounts ORDER BY created_at DESC",
      ).all();
      return json(results);
    },
  },
  {
    method: "POST",
    rx: /^\/api\/admin\/accounts\/([^/]+)\/reset-password$/,
    h: async (c, m) => {
      await adminResetPassword(c.env, m[1]);
      return json({ ok: true });
    },
  },
  {
    method: "POST",
    rx: /^\/api\/admin\/accounts\/([^/]+)\/toggle-disabled$/,
    h: async (c, m) => {
      const { disabled } = await c.req.json<{ disabled: boolean }>();
      await setAccountDisabled(c.env, m[1], disabled);
      return json({ ok: true });
    },
  },
  {
    method: "DELETE",
    rx: /^\/api\/admin\/accounts\/([^/]+)$/,
    h: async (c, m) => {
      if (m[1] === c.accountId)
        return json({ error: "Du kan inte radera ditt eget konto från adminvyn" }, 400);
      await deleteAccount(c.env, m[1]);
      return json({ ok: true });
    },
  },
  {
    method: "GET",
    rx: /^\/api\/admin\/feedback$/,
    h: async (c) => {
      const { results } = await c.env.DB.prepare(
        "SELECT * FROM feedback ORDER BY created_at DESC LIMIT 100",
      ).all();
      return json(results);
    },
  },
  {
    method: "DELETE",
    rx: /^\/api\/admin\/feedback\/([^/]+)$/,
    h: async (c, m) => {
      const result = await c.env.DB.prepare("DELETE FROM feedback WHERE id = ?").bind(m[1]).run();
      return json({ ok: true, deleted: result.meta.changes ?? 0 });
    },
  },
  {
    method: "DELETE",
    rx: /^\/api\/admin\/feedback$/,
    h: async (c) => {
      const result = await c.env.DB.prepare("DELETE FROM feedback").run();
      return json({ ok: true, deleted: result.meta.changes ?? 0 });
    },
  },
  {
    method: "GET",
    rx: /^\/api\/admin\/send-jobs$/,
    h: async (c) => {
      const { results } = await c.env.DB.prepare(
        "SELECT sj.*, a.email FROM send_jobs sj JOIN accounts a ON a.id = sj.account_id ORDER BY sj.created_at DESC LIMIT 100",
      ).all();
      return json(results);
    },
  },
  { method: "GET", rx: /^\/api\/admin\/stats$/, h: async (c) => json(await getAdminStats(c.env)) },
  {
    method: "GET",
    rx: /^\/api\/admin\/timeseries$/,
    h: async (c) =>
      json({
        series: await getTimeSeries(
          c.env,
          (c.url.searchParams.get("granularity") ?? "month") as Granularity,
        ),
      }),
  },
  {
    method: "GET",
    rx: /^\/api\/admin\/export$/,
    h: async (c) => {
      const section = (c.url.searchParams.get("section") ?? "all") as
          "accounts" | "feedback" | "stats" | "public_contacts" | "politicians" | "all",
        format = (c.url.searchParams.get("format") ?? "json") as "csv" | "json",
        { filename, content, contentType } = await exportAdminData(c.env, section, format);
      return new Response(content, {
        headers: {
          "Content-Type": contentType,
          "Content-Disposition": `attachment; filename="${filename}"`,
        },
      });
    },
  },
];

async function handleRequest(req: Request, env: Env, url: URL): Promise<Response> {
  const oauthMatch = url.pathname.match(/^\/api\/oauth\/([a-z]+)\/(start|callback)$/);
  if (oauthMatch) {
    const [, provider, step] = oauthMatch;
    try {
      if (step === "start") {
        const state = randomId();
        await env.SESSIONS.put(`oauthstate:${state}`, "1", { expirationTtl: 600 });
        return Response.redirect(getAuthorizeUrl(provider, env, state), 302);
      }
      const code = url.searchParams.get("code"),
        state = url.searchParams.get("state");
      if (!code || !state) return json({ error: "Saknar code/state" }, 400);
      const storedState = await env.SESSIONS.get(`oauthstate:${state}`);
      if (!storedState) return json({ error: "Ogiltig eller utgången state — försök igen" }, 400);
      await env.SESSIONS.delete(`oauthstate:${state}`);
      if (storedState.startsWith("link:")) {
        const linkAccountId = storedState.slice(5),
          sessionToken = getCookie(req, "session"),
          account = await getAccountFromSession(env, sessionToken);
        if (!account || (account.id as string) !== linkAccountId)
          return json({ error: "State tillhör en annan session — försök igen" }, 400);
        await handleOAuthLinkCallback(provider, env, code, linkAccountId);
        return Response.redirect("https://__PUBLIC_HOST__/", 302);
      }
      const { accountId } = await handleOAuthCallback(provider, env, code),
        sessionToken = randomId() + randomId();
      await env.SESSIONS.put(`session:${sessionToken}`, accountId, { expirationTtl: 2592000 });
      const resp = Response.redirect("https://__PUBLIC_HOST__/", 302),
        headers = new Headers(resp.headers);
      headers.set("Set-Cookie", setSessionCookie(sessionToken));
      return new Response(null, { status: 302, headers });
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : "OAuth-fel" }, 400);
    }
  }

  const oauthMailMatch = url.pathname.match(/^\/api\/oauth-mail\/microsoft\/(start|callback)$/);
  if (oauthMailMatch) {
    const [, step] = oauthMailMatch;
    try {
      const sessionToken = getCookie(req, "session"),
        account = await getAccountFromSession(env, sessionToken);
      if (!account) return json({ error: "Inte inloggad" }, 401);
      if (step === "start") {
        if (!env.OAUTH_MICROSOFT_CLIENT_ID)
          return json(
            { error: "Microsoft-koppling för mailsändning är inte konfigurerad än" },
            400,
          );
        const state = randomId();
        await env.SESSIONS.put(`oauthmailstate:${state}`, account.id as string, {
          expirationTtl: 600,
        });
        return Response.redirect(
          getMicrosoftMailAuthorizeUrl(env.OAUTH_MICROSOFT_CLIENT_ID, state),
          302,
        );
      }
      const code = url.searchParams.get("code"),
        state = url.searchParams.get("state");
      if (!code || !state) return json({ error: "Saknar code/state" }, 400);
      const stateAccountId = await env.SESSIONS.get(`oauthmailstate:${state}`);
      if (!stateAccountId)
        return json({ error: "Ogiltig eller utgången state — försök igen" }, 400);
      await env.SESSIONS.delete(`oauthmailstate:${state}`);
      await addMicrosoftGraphMailCredential(env, stateAccountId, code);
      return new Response(null, {
        status: 302,
        headers: { Location: "https://__PUBLIC_HOST__/" },
      });
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : "OAuth-fel" }, 400);
    }
  }

  const oauthLinkMatch = url.pathname.match(/^\/api\/oauth-link\/([a-z]+)\/(start|callback)$/);
  if (oauthLinkMatch) {
    const [, provider, step] = oauthLinkMatch;
    try {
      const sessionToken = getCookie(req, "session"),
        account = await getAccountFromSession(env, sessionToken);
      if (!account) return json({ error: "Inte inloggad" }, 401);
      if (step === "start") {
        const state = randomId();
        if (providerSharesLoginCallback(provider))
          await env.SESSIONS.put(`oauthstate:${state}`, `link:${account.id as string}`, {
            expirationTtl: 600,
          });
        else
          await env.SESSIONS.put(`oauthlinkstate:${state}`, account.id as string, {
            expirationTtl: 600,
          });
        return Response.redirect(getLinkAuthorizeUrl(provider, env, state), 302);
      }
      const code = url.searchParams.get("code"),
        state = url.searchParams.get("state");
      if (!code || !state) return json({ error: "Saknar code/state" }, 400);
      const stateAccountId = await env.SESSIONS.get(`oauthlinkstate:${state}`);
      if (!stateAccountId)
        return json({ error: "Ogiltig eller utgången state — försök igen" }, 400);
      await env.SESSIONS.delete(`oauthlinkstate:${state}`);
      if (stateAccountId !== account.id)
        return json({ error: "State tillhör en annan session — försök igen" }, 400);
      await handleOAuthLinkCallback(provider, env, code, stateAccountId);
      return new Response(null, {
        status: 302,
        headers: { Location: "https://__PUBLIC_HOST__/" },
      });
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : "OAuth-fel" }, 400);
    }
  }

  if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
  try {
    const sessionToken = getCookie(req, "session");
    let account = await getAccountFromSession(env, sessionToken);
    if (!account) {
      const authHeader = req.headers.get("Authorization");
      if (authHeader?.startsWith("Bearer "))
        account = await getAccountFromApiKey(env, authHeader.slice(7));
    }
    if (url.pathname === "/api/signup" && req.method === "POST") {
      const { email, password, turnstileToken } = await req.json<{
        email: string;
        password: string;
        turnstileToken?: string;
      }>();
      if (
        !(await verifyTurnstile(
          env.TURNSTILE_SECRET,
          turnstileToken,
          req.headers.get("CF-Connecting-IP"),
          "turnstile-spin-v1",
          env.TURNSTILE_HOSTNAMES,
        ))
      )
        return json({ error: "Bekräfta att du inte är en robot och försök igen." }, 400);
      return json(await signup(env, email, password));
    }
    if (url.pathname === "/api/verify" && req.method === "POST") {
      const { accountId, code } = await req.json<{ accountId: string; code: string }>();
      await verifyEmail(env, accountId, code);
      return json({ ok: true });
    }
    if (url.pathname === "/api/login" && req.method === "POST") {
      const { email, password, totpCode } = await req.json<{
          email: string;
          password: string;
          totpCode?: string;
        }>(),
        { sessionToken: token } = await login(env, email, password, totpCode),
        resp = json({ ok: true });
      resp.headers.set("Set-Cookie", setSessionCookie(token));
      return resp;
    }
    if (url.pathname === "/api/logout" && req.method === "POST") {
      if (sessionToken) await env.SESSIONS.delete(`session:${sessionToken}`);
      const resp = json({ ok: true });
      resp.headers.set("Set-Cookie", "session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0");
      return resp;
    }
    if (url.pathname === "/api/request-password-reset" && req.method === "POST") {
      const { email, turnstileToken } = await req.json<{
        email: string;
        turnstileToken?: string;
      }>();
      if (
        !(await verifyTurnstile(
          env.TURNSTILE_SECRET,
          turnstileToken,
          req.headers.get("CF-Connecting-IP"),
          "turnstile-spin-v1",
          env.TURNSTILE_HOSTNAMES,
        ))
      )
        return json({ error: "Bekräfta att du inte är en robot och försök igen." }, 400);
      await requestPasswordReset(env, email);
      return json({ ok: true });
    }
    if (url.pathname === "/api/reset-password" && req.method === "POST") {
      const { token, newPassword } = await req.json<{ token: string; newPassword: string }>();
      await resetPassword(env, token, newPassword);
      return json({ ok: true });
    }
    if (url.pathname === "/api/me" && req.method === "GET") {
      if (!account) return json({ loggedIn: false });
      return json({
        loggedIn: true,
        email: account.email,
        dailySendCap: account.daily_send_cap,
        isAdmin: !!account.is_admin,
        totpEnabled: !!account.totp_enabled,
        passwordSetByUser: !!account.password_set_by_user,
      });
    }
    if (url.pathname === "/api/feedback" && req.method === "POST") {
      const { message, context, type, replyTo } = await req.json<{
        message: string;
        context?: Record<string, unknown>;
        type?: "bug" | "contact";
        replyTo?: string;
      }>();
      return json(
        await submitFeedback(env, {
          accountId: account ? (account.id as string) : null,
          message,
          context,
          type,
          replyTo,
        }),
      );
    }
    if (url.pathname === "/api/client-error" && req.method === "POST") {
      const {
        message,
        stack,
        url: pageUrl,
      } = await req.json<{ message?: string; stack?: string; url?: string }>();
      if (message) await reportClientError(env, { message, stack, url: pageUrl });
      return json({ ok: true });
    }
    if (!account) return json({ error: "Inte inloggad" }, 401);
    const ctx: RouteCtx = {
      env,
      req,
      url,
      accountId: account.id as string,
      isAdmin: !!account.is_admin,
      sessionToken,
    };
    const authedResp = await runRoutes(AUTHED_ROUTES, ctx);
    if (authedResp) return authedResp;
    if (url.pathname.startsWith("/api/admin/")) {
      if (!ctx.isAdmin) return json({ error: "Kräver admin-behörighet" }, 403);
      return (await runRoutes(ADMIN_ROUTES, ctx)) ?? json({ error: "Not found" }, 404);
    }
    return json({ error: "Not found" }, 404);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : "Okänt fel" }, 400);
  }
}
