import type { Env } from "./db";

export interface AdminStats {
  totalAccounts: number;
  totalLetters: number;
  totalSent: number;
  totalVisitors: number;
  visitors15m: number;
  visitors24h: number;
  visitors7d: number;
  activeSends: number;
  queuedRecipients: number;
  sent24h: number;
  sent7d: number;
  platformErrors24h: number;
  visitorCountries: { country: string; n: number }[];
  dailySeries: { day: string; sent: number }[];
  leaderboard: { accountId: string; email: string; sentCount: number }[];
}

const CACHE_TTL_SECONDS = 60;
const DAY = 24 * 60 * 60 * 1000;

async function readCache<T>(env: Env, key: string): Promise<T | null> {
  try {
    const raw = await env.SESSIONS.get(`cache:${key}`);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
async function writeCache(env: Env, key: string, value: unknown): Promise<void> {
  try {
    await env.SESSIONS.put(`cache:${key}`, JSON.stringify(value), {
      expirationTtl: CACHE_TTL_SECONDS,
    });
  } catch {}
}

export async function getAdminStats(env: Env): Promise<AdminStats> {
  const cached = await readCache<AdminStats>(env, "admin-stats:v4");
  if (cached) return cached;
  const now = Date.now(),
    since15m = now - 15 * 60 * 1000,
    since24h = now - DAY,
    since7d = now - 7 * DAY,
    since365 = now - 365 * DAY;
  const totalsPromise = env.DB.prepare(
    `SELECT
    (SELECT COUNT(*) FROM accounts) totalAccounts,
    (SELECT COUNT(*) FROM letters) totalLetters,
    (SELECT COUNT(*) FROM send_log WHERE status='ok') totalSent,
    (SELECT COUNT(*) FROM send_log WHERE status='ok' AND sent_at>=?) sent24h,
    (SELECT COUNT(*) FROM send_log WHERE status='ok' AND sent_at>=?) sent7d,
    (SELECT COUNT(*) FROM send_jobs WHERE status IN ('pending','queued','sending','running')) activeSends,
    (SELECT COALESCE(SUM(CASE WHEN total_recipients>sent_count THEN total_recipients-sent_count ELSE 0 END),0) FROM send_jobs WHERE status IN ('pending','queued','sending','running')) queuedRecipients,
    (SELECT COUNT(*) FROM worker_errors WHERE created_at>=? AND status>=500) platformErrors24h`,
  )
    .bind(since24h, since7d, since24h)
    .first<Record<string, number>>();
  const visitorPromise = (async () => {
    try {
      const v = await env.DB.prepare(
        `SELECT
      COUNT(DISTINCT visitor_hash) total,
      COUNT(DISTINCT CASE WHEN visited_at>=? THEN visitor_hash END) visitors15m,
      COUNT(DISTINCT CASE WHEN visited_at>=? THEN visitor_hash END) visitors24h,
      COUNT(DISTINCT CASE WHEN visited_at>=? THEN visitor_hash END) visitors7d FROM visits`,
      )
        .bind(since15m, since24h, since7d)
        .first<Record<string, number>>();
      const c = await env.DB.prepare(
        `SELECT country,COUNT(DISTINCT visitor_hash) n FROM visits WHERE country IS NOT NULL GROUP BY country ORDER BY n DESC,country`,
      ).all<{ country: string; n: number }>();
      const rows = c.results,
        total = v?.total ?? 0,
        known = rows.reduce((s, r) => s + r.n, 0);
      if (total > known) rows.push({ country: "??", n: total - known });
      return {
        total,
        visitors15m: v?.visitors15m ?? 0,
        visitors24h: v?.visitors24h ?? 0,
        visitors7d: v?.visitors7d ?? 0,
        rows,
      };
    } catch {
      return {
        total: 0,
        visitors15m: 0,
        visitors24h: 0,
        visitors7d: 0,
        rows: [] as { country: string; n: number }[],
      };
    }
  })();
  const dailyPromise = env.DB.prepare(
    `SELECT date(sent_at/1000,'unixepoch') day,COUNT(*) sent FROM send_log WHERE status='ok' AND sent_at>=? GROUP BY day ORDER BY day`,
  )
    .bind(since365)
    .all<{ day: string; sent: number }>();
  const leaderboardPromise = env.DB.prepare(
    `SELECT a.id accountId,a.email email,COUNT(sl.id) sentCount FROM accounts a LEFT JOIN send_log sl ON sl.account_id=a.id AND sl.status='ok' GROUP BY a.id ORDER BY sentCount DESC LIMIT 50`,
  ).all<{ accountId: string; email: string; sentCount: number }>();
  const [totals, visitors, daily, leaderboard] = await Promise.all([
    totalsPromise,
    visitorPromise,
    dailyPromise,
    leaderboardPromise,
  ]);
  const result: AdminStats = {
    totalAccounts: totals?.totalAccounts ?? 0,
    totalLetters: totals?.totalLetters ?? 0,
    totalSent: totals?.totalSent ?? 0,
    totalVisitors: visitors.total,
    visitors15m: visitors.visitors15m,
    visitors24h: visitors.visitors24h,
    visitors7d: visitors.visitors7d,
    activeSends: totals?.activeSends ?? 0,
    queuedRecipients: totals?.queuedRecipients ?? 0,
    sent24h: totals?.sent24h ?? 0,
    sent7d: totals?.sent7d ?? 0,
    platformErrors24h: totals?.platformErrors24h ?? 0,
    visitorCountries: visitors.rows,
    dailySeries: daily.results,
    leaderboard: leaderboard.results,
  };
  await writeCache(env, "admin-stats:v4", result);
  return result;
}

export type Granularity =
  "minute" | "hour" | "day" | "week" | "month" | "quarter" | "half" | "year";
export interface TimeSeriesPoint {
  bucket: string;
  sent: number;
  visitors: number;
}
const GRAN: Record<Granularity, { expr: (col: string) => string; windowMs: number | null }> = {
  minute: {
    expr: (c) => `strftime('%Y-%m-%d %H:%M', ${c} / 1000, 'unixepoch')`,
    windowMs: 6 * 60 * 60 * 1000,
  },
  hour: { expr: (c) => `strftime('%Y-%m-%d %H:00', ${c} / 1000, 'unixepoch')`, windowMs: 7 * DAY },
  day: { expr: (c) => `date(${c} / 1000, 'unixepoch')`, windowMs: 365 * DAY },
  week: { expr: (c) => `strftime('%Y-W%W', ${c} / 1000, 'unixepoch')`, windowMs: 2 * 365 * DAY },
  month: { expr: (c) => `strftime('%Y-%m', ${c} / 1000, 'unixepoch')`, windowMs: 5 * 365 * DAY },
  quarter: {
    expr: (c) =>
      `strftime('%Y', ${c} / 1000, 'unixepoch') || '-Q' || ((cast(strftime('%m', ${c} / 1000, 'unixepoch') as integer) + 2) / 3)`,
    windowMs: null,
  },
  half: {
    expr: (c) =>
      `strftime('%Y', ${c} / 1000, 'unixepoch') || '-H' || ((cast(strftime('%m', ${c} / 1000, 'unixepoch') as integer) + 5) / 6)`,
    windowMs: null,
  },
  year: { expr: (c) => `strftime('%Y', ${c} / 1000, 'unixepoch')`, windowMs: null },
};
export async function getTimeSeries(
  env: Env,
  granularity: Granularity,
): Promise<TimeSeriesPoint[]> {
  const selected: Granularity = GRAN[granularity] ? granularity : "month",
    cached = await readCache<TimeSeriesPoint[]>(env, `timeseries:v2:${selected}`);
  if (cached) return cached;
  const g = GRAN[selected],
    since = g.windowMs === null ? 0 : Date.now() - g.windowMs;
  const sentPromise = env.DB.prepare(
    `SELECT ${g.expr("sent_at")} bucket,COUNT(*) n FROM send_log WHERE status='ok' AND sent_at>=? GROUP BY bucket`,
  )
    .bind(since)
    .all<{ bucket: string; n: number }>();
  const visitorsPromise = (async () => {
    try {
      return await env.DB.prepare(
        `SELECT ${g.expr("visited_at")} bucket,COUNT(DISTINCT visitor_hash) n FROM visits WHERE visited_at>=? GROUP BY bucket`,
      )
        .bind(since)
        .all<{ bucket: string; n: number }>();
    } catch {
      return { results: [] as { bucket: string; n: number }[] };
    }
  })();
  const [sentRows, visitorRows] = await Promise.all([sentPromise, visitorsPromise]);
  const byBucket = new Map<string, TimeSeriesPoint>();
  for (const { bucket, n } of sentRows.results)
    byBucket.set(bucket, { bucket, sent: n, visitors: 0 });
  for (const { bucket, n } of visitorRows.results) {
    const p = byBucket.get(bucket) ?? { bucket, sent: 0, visitors: 0 };
    p.visitors = n;
    byBucket.set(bucket, p);
  }
  const result = [...byBucket.values()].sort((a, b) =>
    a.bucket < b.bucket ? -1 : a.bucket > b.bucket ? 1 : 0,
  );
  await writeCache(env, `timeseries:v2:${selected}`, result);
  return result;
}
function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]),
    escape = (v: unknown) => {
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
  return [
    headers.join(","),
    ...rows.map((row) => headers.map((h) => escape(row[h])).join(",")),
  ].join("\n");
}
export async function exportAdminData(
  env: Env,
  section: "accounts" | "feedback" | "stats" | "public_contacts" | "politicians" | "all",
  format: "csv" | "json",
): Promise<{ filename: string; content: string; contentType: string }> {
  const accountsRows = async () => {
    const { results } = await env.DB.prepare(
      "SELECT id, email, is_admin, email_verified, disabled, daily_send_cap, created_at FROM accounts ORDER BY created_at",
    ).all<Record<string, unknown>>();
    return results;
  };
  const feedbackRows = async () => {
    const { results } = await env.DB.prepare(
      "SELECT id, account_id, message, github_issue_url, created_at FROM feedback ORDER BY created_at DESC",
    ).all<Record<string, unknown>>();
    return results;
  };
  const publicContactRows = async () => {
    const { results } = await env.DB.prepare(
      "SELECT id, name, email, area_name, area_type, party, role, organisation, unit, title, academic_field, source_url, verification_status, last_scraped_at, last_verified_at FROM public_contacts ORDER BY area_type, area_name, name",
    ).all<Record<string, unknown>>();
    return results;
  };
  let data: Record<string, unknown> | Record<string, unknown>[], baseName: string;
  if (section === "accounts") {
    data = await accountsRows();
    baseName = "konton";
  } else if (section === "feedback") {
    data = await feedbackRows();
    baseName = "feedback";
  } else if (section === "public_contacts" || section === "politicians") {
    data = await publicContactRows();
    baseName = "offentliga-mottagare";
  } else if (section === "stats") {
    const stats = await getAdminStats(env);
    data = format === "csv" ? stats.dailySeries : (stats as unknown as Record<string, unknown>);
    baseName = "statistik";
  } else {
    const [accounts, feedback, stats, publicContacts] = await Promise.all([
      accountsRows(),
      feedbackRows(),
      getAdminStats(env),
      publicContactRows(),
    ]);
    data = { accounts, feedback, stats, public_contacts: publicContacts };
    baseName = "allt";
  }
  const date = new Date().toISOString().slice(0, 10);
  if (format === "json")
    return {
      filename: `quill-${baseName}-${date}.json`,
      content: JSON.stringify(data, null, 2),
      contentType: "application/json",
    };
  const rows = Array.isArray(data)
    ? data
    : section === "all"
      ? (data as { accounts: Record<string, unknown>[] }).accounts
      : [data as Record<string, unknown>];
  return {
    filename: `quill-${baseName}-${date}.csv`,
    content: toCsv(rows),
    contentType: "text/csv",
  };
}
