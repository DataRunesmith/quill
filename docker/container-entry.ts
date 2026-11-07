// Container entry: the production Worker plus a first-admin bootstrap. A fresh
// install has no admin, so the account registered with ADMIN_EMAIL is made
// admin (and marked verified) by the per-minute scheduled run.
import worker, { CredentialRateLimiter } from "../app/src/access-index";

export { CredentialRateLimiter };

type Env = Parameters<typeof worker.fetch>[1] & { ADMIN_EMAIL?: string };

async function promoteAdmin(env: Env): Promise<void> {
  const email = env.ADMIN_EMAIL?.trim().toLowerCase();
  if (!email) return;
  await env.DB.prepare(
    `UPDATE accounts SET is_admin = 1, email_verified = 1
     WHERE lower(email) = ? AND (is_admin = 0 OR email_verified = 0)`,
  )
    .bind(email)
    .run();
}

export default {
  fetch: worker.fetch,
  queue: worker.queue,
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    await promoteAdmin(env);
    return worker.scheduled(event, env, ctx);
  },
};
