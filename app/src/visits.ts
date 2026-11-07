import { randomId } from "../../shared/crypto";
import type { Env } from "./db";

const VISIT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

async function visitorHash(env: Env, req: Request): Promise<string> {
  const ip = req.headers.get("CF-Connecting-IP") ?? req.headers.get("X-Forwarded-For") ?? "okänd";
  const ua = req.headers.get("User-Agent") ?? "okänd";
  const day = new Date().toISOString().slice(0, 10);

  // Hashen är medvetet dagsbunden: samma besökare får en annan identifierare
  // nästa UTC-dag och kan därför inte följas långsiktigt via visits-tabellen.
  // Nyckeln är hemlig (VISITOR_SALT om satt, annars den redan existerande
  // MAIL_CRED_KEY) och HMAC används i stället för en publik saltssträng.
  const secret = env.VISITOR_SALT ?? env.MAIL_CRED_KEY;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${day}|${ip}|${ua}`),
  );
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Spelar in högst en rad per besökare och UTC-dag. Det gör adminstatistiken
// användbar utan att varje refresh/page-load växer D1-tabellen. Best-effort:
// anropas via ctx.waitUntil och får aldrig blockera eller fälla svaret.
export async function recordVisit(env: Env, req: Request): Promise<void> {
  try {
    const hash = await visitorHash(env, req);
    const existing = await env.DB.prepare("SELECT 1 FROM visits WHERE visitor_hash = ? LIMIT 1")
      .bind(hash)
      .first();
    if (existing) return;

    const cf = (req as unknown as { cf?: { country?: string } }).cf;
    const country = cf?.country && cf.country !== "XX" ? cf.country : null;
    await env.DB.prepare(
      "INSERT INTO visits (id, visitor_hash, visited_at, country) VALUES (?, ?, ?, ?)",
    )
      .bind(randomId(), hash, Date.now(), country)
      .run();
  } catch {
    // Statistik får aldrig påverka sidladdningen.
  }
}

// Körs från secure-index.ts tillsammans med befintliga cron-körningar. Råa
// pseudonyma besöksrader är kortlivade och tabellstorleken får ett hårt
// tidsmässigt tak i stället för att växa under tjänstens hela livstid.
export async function pruneVisits(env: Env): Promise<void> {
  try {
    await env.DB.prepare("DELETE FROM visits WHERE visited_at < ?")
      .bind(Date.now() - VISIT_RETENTION_MS)
      .run();
  } catch {
    // Äldre installationer kan sakna tabellen under migration/deploy.
  }
}
