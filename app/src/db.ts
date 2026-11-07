import { randomId } from "../../shared/crypto";
import { canonicalRole } from "./roles";
import { isIrrelevantRecipientRole } from "./recipient-roles";
import { parseIncludedRecipient } from "./recipient-address";
import { explicitEmailJsonChunks } from "./explicit-email-chunks";
import type { EmailSendBinding } from "../../shared/types";

export interface Env {
  DB: D1Database;
  SESSIONS: KVNamespace;
  SEND_QUEUE: Queue;
  ASSETS: Fetcher;
  ATTACHMENTS: R2Bucket;
  MAIL_CRED_KEY: string;
  SYSTEM_SMTP_HOST: string;
  SYSTEM_SMTP_PORT: string;
  SYSTEM_SMTP_USER: string;
  SYSTEM_SMTP_PASSWORD: string;
  SYSTEM_FROM_ADDRESS: string;
  FEEDBACK_NOTIFY_EMAIL: string;
  OAUTH_GOOGLE_CLIENT_ID?: string;
  OAUTH_GOOGLE_CLIENT_SECRET?: string;
  OAUTH_MICROSOFT_CLIENT_ID?: string;
  OAUTH_MICROSOFT_CLIENT_SECRET?: string;
  VISITOR_SALT?: string;
  TURNSTILE_SECRET?: string;
  TURNSTILE_HOSTNAMES?: string;
  EMAIL?: EmailSendBinding;
  RESEND_API_KEY?: string;
  RATE_LIMITER: DurableObjectNamespace;
}

export async function getAccountByEmail(db: D1Database, email: string) {
  return db.prepare("SELECT * FROM accounts WHERE email = ?").bind(email).first();
}
export async function getAccountById(db: D1Database, id: string) {
  return db.prepare("SELECT * FROM accounts WHERE id = ?").bind(id).first();
}

export async function deleteAccount(env: Env, accountId: string): Promise<void> {
  const target = await env.DB.prepare("SELECT is_admin FROM accounts WHERE id = ?")
    .bind(accountId)
    .first<{ is_admin: number }>();
  if (target?.is_admin) {
    const row = await env.DB.prepare(
      "SELECT COUNT(*) as n FROM accounts WHERE is_admin = 1",
    ).first<{ n: number }>();
    if ((row?.n ?? 0) <= 1)
      throw new Error("Kan inte radera det sista admin-kontot — utse en annan administratör först");
  }
  const { results: attachmentRows } = await env.DB.prepare(
    "SELECT r2_key FROM letter_attachments WHERE letter_id IN (SELECT id FROM letters WHERE account_id = ?)",
  )
    .bind(accountId)
    .all<{ r2_key: string }>();
  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM letter_attachments WHERE letter_id IN (SELECT id FROM letters WHERE account_id = ?)",
    ).bind(accountId),
    env.DB.prepare("DELETE FROM send_log WHERE account_id = ?").bind(accountId),
    env.DB.prepare("DELETE FROM send_jobs WHERE account_id = ?").bind(accountId),
    env.DB.prepare("DELETE FROM letters WHERE account_id = ?").bind(accountId),
    env.DB.prepare("DELETE FROM mail_credentials WHERE account_id = ?").bind(accountId),
    env.DB.prepare("DELETE FROM account_contact_list_members WHERE account_id = ?").bind(accountId),
    env.DB.prepare("DELETE FROM account_contact_lists WHERE account_id = ?").bind(accountId),
    env.DB.prepare("DELETE FROM account_contacts WHERE account_id = ?").bind(accountId),
    env.DB.prepare("DELETE FROM letter_intro_presets WHERE account_id = ?").bind(accountId),
    env.DB.prepare("DELETE FROM oauth_identities WHERE account_id = ?").bind(accountId),
    env.DB.prepare("DELETE FROM api_keys WHERE account_id = ?").bind(accountId),
    env.DB.prepare("UPDATE feedback SET account_id = NULL WHERE account_id = ?").bind(accountId),
    env.DB.prepare("UPDATE worker_errors SET account_id = NULL WHERE account_id = ?").bind(
      accountId,
    ),
    env.DB.prepare("DELETE FROM accounts WHERE id = ?").bind(accountId),
  ]);
  if (attachmentRows.length) {
    try {
      await env.ATTACHMENTS.delete(attachmentRows.map((r) => r.r2_key));
    } catch {}
  }
}

export async function createAccount(
  db: D1Database,
  fields: { email: string; passwordHash: string; passwordSalt: string; verificationCode: string },
) {
  const id = randomId(),
    now = Date.now(),
    expires = now + 30 * 60 * 1000;
  await db
    .prepare(
      `INSERT INTO accounts (id, email, password_hash, password_salt, password_set_by_user, email_verified, verification_code, verification_expires_at, created_at) VALUES (?, ?, ?, ?, 1, 0, ?, ?, ?)`,
    )
    .bind(
      id,
      fields.email,
      fields.passwordHash,
      fields.passwordSalt,
      fields.verificationCode,
      expires,
      now,
    )
    .run();
  return id;
}
export async function verifyAccountEmail(
  db: D1Database,
  accountId: string,
  code: string,
): Promise<boolean> {
  const a = await db
    .prepare("SELECT verification_code, verification_expires_at FROM accounts WHERE id = ?")
    .bind(accountId)
    .first<{ verification_code: string; verification_expires_at: number }>();
  if (!a || a.verification_code !== code || Date.now() > a.verification_expires_at) return false;
  await db.prepare("UPDATE accounts SET email_verified = 1 WHERE id = ?").bind(accountId).run();
  return true;
}
export async function listAreas(db: D1Database) {
  const { results } = await db
    .prepare(
      "SELECT area_name, area_type, COUNT(*) as count FROM public_contacts GROUP BY area_name, area_type ORDER BY area_type, area_name",
    )
    .all();
  return results;
}
export async function listParties(db: D1Database) {
  const { results } = await db
    .prepare(
      `SELECT area_type, area_name, TRIM(party) AS party, COUNT(*) as count FROM public_contacts WHERE party IS NOT NULL AND TRIM(party) != '' GROUP BY area_type, area_name, TRIM(party) ORDER BY area_type, area_name, TRIM(party)`,
    )
    .all();
  return results;
}

export async function listRoles(db: D1Database) {
  const { results } = await db
    .prepare(
      `SELECT role, COUNT(*) as count FROM public_contacts WHERE area_type NOT IN ('media','academia') AND role IS NOT NULL AND TRIM(role) != '' GROUP BY role`,
    )
    .all<{ role: string; count: number }>();
  const merged = new Map<
    string,
    { role_key: string; role: string; count: number; kind?: string }
  >();
  for (const row of results) {
    const { key, label } = canonicalRole(row.role),
      e = merged.get(key);
    if (e) e.count += row.count;
    else merged.set(key, { role_key: key, role: label, count: row.count, kind: "role" });
  }
  return [...merged.values()].sort((a, b) => b.count - a.count);
}
async function rawRolesForCanonicalKeys(db: D1Database, keys: string[]): Promise<string[]> {
  if (!keys.length) return [];
  const wanted = new Set(keys);
  const { results } = await db
    .prepare(
      "SELECT DISTINCT role FROM public_contacts WHERE role IS NOT NULL AND TRIM(role) != ''",
    )
    .all<{ role: string }>();
  return results.filter((r) => wanted.has(canonicalRole(r.role).key)).map((r) => r.role);
}

export interface PublicContactSearchHit {
  name: string;
  email: string;
  affiliations: { role: string | null; area_name: string; party: string | null }[];
}
const AFF_SEP = "\x1e",
  FIELD_SEP = "\x1f";
export async function searchPublicContactsInAreas(
  db: D1Database,
  areaNames: string[],
  query: string,
): Promise<PublicContactSearchHit[]> {
  let sql = `SELECT email, MAX(name) as name, GROUP_CONCAT(COALESCE(NULLIF(TRIM(role), ''), '') || CHAR(31) || area_name || CHAR(31) || COALESCE(party, ''), CHAR(30)) as affiliations FROM public_contacts WHERE name LIKE ? AND email IS NOT NULL AND email != ''`;
  const params: unknown[] = [`%${query}%`];
  if (areaNames.length) {
    sql += ` AND area_name IN (${areaNames.map(() => "?").join(",")})`;
    params.push(...areaNames);
  }
  sql += ` GROUP BY email ORDER BY name LIMIT 50`;
  const { results } = await db
    .prepare(sql)
    .bind(...params)
    .all<{ email: string; name: string; affiliations: string | null }>();
  return results.map((r) => {
    const seen = new Set<string>(),
      affiliations: PublicContactSearchHit["affiliations"] = [];
    for (const part of (r.affiliations ?? "").split(AFF_SEP)) {
      if (seen.has(part)) continue;
      seen.add(part);
      const [role, area_name, party] = part.split(FIELD_SEP);
      affiliations.push({ role: role || null, area_name: area_name ?? "", party: party || null });
    }
    return { name: r.name, email: r.email, affiliations };
  });
}

const POLICY_PREFIX = "policy-area:";
const MEDIA_PREFIX = "media-category:";
const ACADEMIC_PREFIX = "academic-field:";
const EXCLUDE_BODY_PREFIX = "exclude-body:";
const POLICY_TERMS: Record<string, string[]> = {
  ledning: ["kommunstyrelse", "regionstyrelse"],
  "social-omsorg": [
    "social",
    "omsorg",
    "äldre",
    "aldre",
    "individ",
    "familj",
    "välfärd",
    "valfard",
    "funktionsstöd",
    "funktionsstod",
  ],
  utbildning: ["utbild", "skol", "förskol", "forskol", "gymnasi", "bildning", "kunskap"],
  "halso-sjukvard": ["hälso", "halso", "sjukvård", "sjukvard", "patient"],
  samhallsbyggnad: ["samhällsbygg", "samhallsbygg", "stadsbygg", "byggnads", "bygglov", "plan"],
  miljo: ["miljö", "miljo", "hälsoskydd", "halsoskydd"],
  "teknik-infrastruktur": ["tekn", "trafik", "infrastruktur", "kollektivtrafik", "fastighet"],
  "kultur-fritid": ["kultur", "fritid"],
  "arbetsmarknad-naringsliv": [
    "arbetsmarknad",
    "näringsliv",
    "naringsliv",
    "tillväxt",
    "tillvaxt",
    "kompetens",
  ],
  "regional-utveckling": ["regional utveck", "regionutveck", "regionala utveck"],
  "raddning-samhallsskydd": ["räddning", "raddning", "samhällsskydd", "samhallsskydd"],
};
const MEDIA_TERMS: Record<string, string[]> = {
  politik: ["politik", "granskning"],
  "opinion-debatt": ["ledare", "opinion", "debatt"],
  nyhetsredaktion: ["nyhetsredaktion", "redaktionsledning"],
};
const GENERIC_MEDIA_LOCALS = new Set(["tips", "tipsa", "redaktionen"]);
function policySql(keys: string[]): { sql: string; params: string[] } {
  const terms = [...new Set(keys.flatMap((k) => POLICY_TERMS[k] ?? []))];
  if (!terms.length) return { sql: "0", params: [] };
  return {
    sql: `(${terms.map(() => "LOWER(a.body) LIKE ?").join(" OR ")})`,
    params: terms.map((t) => `%${t}%`),
  };
}
function mediaCategoryMatch(role: string | null, email: string, keys: string[]): boolean {
  const local = email.trim().toLocaleLowerCase("sv-SE").split("@", 1)[0];
  if (GENERIC_MEDIA_LOCALS.has(local)) return false;
  const hay = (role ?? "").toLocaleLowerCase("sv-SE");
  return keys.some((key) => (MEDIA_TERMS[key] ?? []).some((term) => hay.includes(term)));
}

export async function getRecipientsForAreas(
  db: D1Database,
  areaNames: string[],
  excludeParties: string[] = [],
  excludeEmails: string[] = [],
  includeRoles: string[] = [],
  includeEmails: string[] = [],
) {
  const policyKeys = includeRoles
    .filter((k) => k.startsWith(POLICY_PREFIX))
    .map((k) => k.slice(POLICY_PREFIX.length));
  const mediaKeys = includeRoles
    .filter((k) => k.startsWith(MEDIA_PREFIX))
    .map((k) => k.slice(MEDIA_PREFIX.length));
  const academicKeys = includeRoles
    .filter((k) => k.startsWith(ACADEMIC_PREFIX))
    .map((k) => k.slice(ACADEMIC_PREFIX.length));
  const excludedBodyKeys = includeRoles
    .filter((k) => k.startsWith(EXCLUDE_BODY_PREFIX))
    .map((k) => k.slice(EXCLUDE_BODY_PREFIX.length));
  const includedRoleKeys = includeRoles.filter(
    (k) =>
      !k.startsWith(POLICY_PREFIX) &&
      !k.startsWith(MEDIA_PREFIX) &&
      !k.startsWith(ACADEMIC_PREFIX) &&
      !k.startsWith(EXCLUDE_BODY_PREFIX),
  );
  const byEmail = new Map<string, { name: string; email: string; area_name: string }>();
  const hasPoolIntent = areaNames.length > 0 || includedRoleKeys.length > 0;
  if (hasPoolIntent) {
    const rawRoles = includedRoleKeys.length
      ? await rawRolesForCanonicalKeys(db, includedRoleKeys)
      : [];
    if (!(includedRoleKeys.length && rawRoles.length === 0)) {
      let sql = `SELECT name,email,area_name,area_type,role FROM public_contacts WHERE email IS NOT NULL AND TRIM(email) != '' AND (verification_status IS NULL OR verification_status NOT IN ('dead','dead_via_send'))`;
      const params: unknown[] = [];
      if (areaNames.length) {
        sql += ` AND area_name IN (SELECT value FROM json_each(?))`;
        params.push(JSON.stringify(areaNames));
      }
      if (rawRoles.length) {
        sql += ` AND role IN (SELECT value FROM json_each(?))`;
        params.push(JSON.stringify(rawRoles));
      }
      if (excludeParties.length) {
        sql += ` AND (party IS NULL OR TRIM(party) NOT IN (SELECT value FROM json_each(?)))`;
        params.push(JSON.stringify(excludeParties));
      }
      const { results } = await db
        .prepare(sql)
        .bind(...params)
        .all<{
          name: string;
          email: string;
          area_name: string;
          area_type: string;
          role: string | null;
        }>();
      for (const r of results)
        if (!isIrrelevantRecipientRole(r.area_type, r.role))
          byEmail.set(r.email.trim().toLocaleLowerCase("sv-SE"), {
            name: r.name,
            email: r.email.trim(),
            area_name: r.area_name,
          });
    }
  }
  if (policyKeys.length && byEmail.size) {
    const p = policySql(policyKeys);
    try {
      const { results } = await db
        .prepare(
          `SELECT DISTINCT lower(trim(pol.email)) AS email_key FROM public_contact_assignments a JOIN public_contacts pol ON pol.id=a.contact_id WHERE pol.area_type IN ('kommun','region') AND pol.area_name IN (SELECT value FROM json_each(?)) AND ${p.sql}`,
        )
        .bind(JSON.stringify(areaNames), ...p.params)
        .all<{ email_key: string }>();
      const allowed = new Set(results.map((r) => r.email_key));
      const { results: locals } = await db
        .prepare(
          `SELECT DISTINCT lower(trim(email)) AS email_key FROM public_contacts WHERE area_type IN ('kommun','region') AND area_name IN (SELECT value FROM json_each(?))`,
        )
        .bind(JSON.stringify(areaNames))
        .all<{ email_key: string }>();
      for (const r of locals) if (!allowed.has(r.email_key)) byEmail.delete(r.email_key);
    } catch {}
  }
  if (excludedBodyKeys.length && byEmail.size && areaNames.length) {
    const p = policySql(excludedBodyKeys);
    if (p.sql !== "0") {
      try {
        const { results } = await db
          .prepare(
            `SELECT DISTINCT lower(trim(pol.email)) AS email_key FROM public_contact_assignments a JOIN public_contacts pol ON pol.id=a.contact_id WHERE pol.area_type IN ('kommun','region') AND pol.area_name IN (SELECT value FROM json_each(?)) AND ${p.sql}`,
          )
          .bind(JSON.stringify(areaNames), ...p.params)
          .all<{ email_key: string }>();
        const excluded = new Set(results.map((r) => r.email_key));
        const { results: otherBranches } = await db
          .prepare(
            `SELECT DISTINCT lower(trim(email)) AS email_key FROM public_contacts WHERE area_name IN (SELECT value FROM json_each(?)) AND area_type NOT IN ('kommun','region') AND email IS NOT NULL AND TRIM(email) != ''`,
          )
          .bind(JSON.stringify(areaNames))
          .all<{ email_key: string }>();
        const preserved = new Set(otherBranches.map((r) => r.email_key));
        for (const key of excluded) if (!preserved.has(key)) byEmail.delete(key);
      } catch {}
    }
  }
  if (mediaKeys.length && byEmail.size) {
    const { results: mediaRows } = await db
      .prepare(
        `SELECT email, role FROM public_contacts WHERE area_type='media' AND area_name IN (SELECT value FROM json_each(?)) AND email IS NOT NULL AND TRIM(email) != ''`,
      )
      .bind(JSON.stringify(areaNames))
      .all<{ email: string; role: string | null }>();
    const allowed = new Set(
      mediaRows
        .filter((r) => mediaCategoryMatch(r.role, r.email, mediaKeys))
        .map((r) => r.email.trim().toLocaleLowerCase("sv-SE")),
    );
    for (const r of mediaRows) {
      const key = r.email.trim().toLocaleLowerCase("sv-SE");
      if (!allowed.has(key)) byEmail.delete(key);
    }
  }
  if (academicKeys.length && byEmail.size) {
    const { results: academicRows } = await db
      .prepare(
        `SELECT email, academic_field FROM public_contacts WHERE area_type='academia' AND area_name IN (SELECT value FROM json_each(?)) AND email IS NOT NULL AND TRIM(email) != ''`,
      )
      .bind(JSON.stringify(areaNames))
      .all<{ email: string; academic_field: string | null }>();
    const wanted = new Set(academicKeys);
    const allowed = new Set(
      academicRows
        .filter((r) => r.academic_field && wanted.has(r.academic_field))
        .map((r) => r.email.trim().toLocaleLowerCase("sv-SE")),
    );
    for (const r of academicRows) {
      const key = r.email.trim().toLocaleLowerCase("sv-SE");
      if (!allowed.has(key)) byEmail.delete(key);
    }
  }
  if (includeEmails.length) {
    if (includeEmails.length > 10000)
      throw new Error(`För många explicita mottagare: ${includeEmails.length} (max 10 000)`);
    const requestedByEmail = new Map<string, { email: string; name: string }>();
    for (const parsed of includeEmails
      .map(parseIncludedRecipient)
      .filter((r): r is { email: string; name: string } => r !== null)) {
      const existing = requestedByEmail.get(parsed.email);
      if (!existing || (!existing.name && parsed.name)) requestedByEmail.set(parsed.email, parsed);
    }
    if (requestedByEmail.size) {
      const deadEmails = new Set<string>();
      for (const emailJson of explicitEmailJsonChunks([...requestedByEmail.keys()])) {
        const { results } = await db
          .prepare(
            `SELECT name,email,area_name,verification_status FROM public_contacts WHERE lower(trim(email)) IN (SELECT lower(value) FROM json_each(?))`,
          )
          .bind(emailJson)
          .all<{
            name: string;
            email: string;
            area_name: string;
            verification_status: string | null;
          }>();
        for (const r of results) {
          const key = r.email.trim().toLocaleLowerCase("sv-SE");
          if (r.verification_status === "dead" || r.verification_status === "dead_via_send")
            deadEmails.add(key);
          else byEmail.set(key, { name: r.name, email: r.email.trim(), area_name: r.area_name });
        }
      }
      for (const r of requestedByEmail.values())
        if (!byEmail.has(r.email) && !deadEmails.has(r.email))
          byEmail.set(r.email, {
            name: r.name || r.email,
            email: r.email,
            area_name: "Egen mottagare",
          });
    }
  }
  for (const e of excludeEmails) byEmail.delete(e.trim().toLocaleLowerCase("sv-SE"));
  return [...byEmail.values()];
}

export async function countSentToday(db: D1Database, accountId: string): Promise<number> {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  const r = await db
    .prepare(
      "SELECT COUNT(*) as n FROM send_log WHERE account_id = ? AND sent_at >= ? AND status = 'ok'",
    )
    .bind(accountId, d.getTime())
    .first<{ n: number }>();
  return r?.n ?? 0;
}
export async function countSentTodayForCredential(
  db: D1Database,
  mailCredentialId: string,
): Promise<number> {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  const r = await db
    .prepare(
      `SELECT COUNT(*) as n FROM send_log sl JOIN send_jobs sj ON sj.id = sl.send_job_id WHERE sj.mail_credential_id = ? AND sl.sent_at >= ? AND sl.status = 'ok'`,
    )
    .bind(mailCredentialId, d.getTime())
    .first<{ n: number }>();
  return r?.n ?? 0;
}
export async function getMailCredential(db: D1Database, id: string) {
  return db.prepare("SELECT * FROM mail_credentials WHERE id = ?").bind(id).first();
}
