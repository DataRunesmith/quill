// Container entry: the production Worker plus a one-time, password-backed
// first-admin bootstrap. An existing account is never promoted just because
// its email matches ADMIN_EMAIL; that would let an unverified signup claim admin.
import worker, { CredentialRateLimiter } from "../app/src/access-index";
import { hashPassword, randomId } from "../shared/crypto";
import { validateMailboxAddress } from "../shared/input-safety";

export { CredentialRateLimiter };

type Env = Parameters<typeof worker.fetch>[1] & {
  ADMIN_EMAIL?: string;
  ADMIN_PASSWORD?: string;
};

const ADMIN_BOOTSTRAP_KEY = "bootstrap:admin:complete";

async function ensureAdminBootstrap(env: Env): Promise<void> {
  const emailValue = env.ADMIN_EMAIL?.trim();
  const password = env.ADMIN_PASSWORD;
  if (!emailValue || !password || (await env.SESSIONS.get(ADMIN_BOOTSTRAP_KEY))) return;

  const email = validateMailboxAddress(emailValue, "ADMIN_EMAIL").toLocaleLowerCase("sv-SE");
  if (email.length > 254) throw new Error("ADMIN_EMAIL is too long");
  if (password.length < 12) throw new Error("ADMIN_PASSWORD must contain at least 12 characters");

  const existing = await env.DB.prepare(
    "SELECT id FROM accounts WHERE lower(trim(email)) = ? LIMIT 1",
  )
    .bind(email)
    .first<{ id: string }>();
  if (existing) {
    // Never adopt or elevate an account that may have been registered before
    // the bootstrap secret was configured.
    await env.SESSIONS.put(ADMIN_BOOTSTRAP_KEY, "existing-account-requires-manual-review");
    return;
  }

  const { hash, salt } = await hashPassword(password);
  await env.DB.prepare(
    `INSERT OR IGNORE INTO accounts
       (id, email, password_hash, password_salt, password_set_by_user,
        email_verified, is_admin, daily_send_cap, created_at)
     VALUES (?, ?, ?, ?, 1, 1, 1, 200, ?)`,
  )
    .bind(randomId(), email, hash, salt, Date.now())
    .run();

  const created = await env.DB.prepare(
    "SELECT is_admin FROM accounts WHERE lower(trim(email)) = ? LIMIT 1",
  )
    .bind(email)
    .first<{ is_admin: number }>();
  if (created?.is_admin === 1) {
    await env.SESSIONS.put(ADMIN_BOOTSTRAP_KEY, "created");
  } else {
    await env.SESSIONS.put(ADMIN_BOOTSTRAP_KEY, "existing-account-requires-manual-review");
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    await ensureAdminBootstrap(env);
    return worker.fetch(request, env, ctx);
  },
  queue: worker.queue,
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    await ensureAdminBootstrap(env);
    return worker.scheduled(event, env, ctx);
  },
};
