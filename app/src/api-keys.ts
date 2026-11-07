import { randomId, generateApiKey, sha256Hex } from "../../shared/crypto";
import { getAccountById, type Env } from "./db";

// API-nycklar har medvetet en fast, liten capability-yta. Själva route-
// enforcementen ligger i secure-index.ts; dessa scopes visas i UI/API så
// användaren ser exakt vad en nyckel får göra. Nycklar får aldrig admin- eller
// kontosäkerhetsbehörighet.
export const API_KEY_SCOPES = ["recipients:read", "send:write", "jobs:read", "jobs:write"] as const;

export async function createApiKey(
  env: Env,
  accountId: string,
  name: string,
): Promise<{ id: string; key: string; scopes: readonly string[] }> {
  const key = generateApiKey();
  const keyHash = await sha256Hex(key);
  const id = randomId();
  const safeName = (name || "Namnlös nyckel").trim().slice(0, 120) || "Namnlös nyckel";
  await env.DB.prepare(
    "INSERT INTO api_keys (id, account_id, key_hash, name, created_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(id, accountId, keyHash, safeName, Date.now())
    .run();
  return { id, key, scopes: API_KEY_SCOPES }; // klartexten returneras bara här, en gång
}

export async function listApiKeys(env: Env, accountId: string) {
  const { results } = await env.DB.prepare(
    "SELECT id, name, created_at, last_used_at FROM api_keys WHERE account_id = ? ORDER BY created_at DESC",
  )
    .bind(accountId)
    .all<Record<string, unknown>>();
  return results.map((row) => ({ ...row, scopes: API_KEY_SCOPES }));
}

export async function revokeApiKey(env: Env, accountId: string, id: string): Promise<void> {
  await env.DB.prepare("DELETE FROM api_keys WHERE id = ? AND account_id = ?")
    .bind(id, accountId)
    .run();
}

export async function getAccountFromApiKey(env: Env, key: string) {
  if (!key.startsWith("pwapi_") || key.length < 40 || key.length > 80) return null;
  const keyHash = await sha256Hex(key);
  const row = await env.DB.prepare("SELECT id, account_id FROM api_keys WHERE key_hash = ?")
    .bind(keyHash)
    .first<{ id: string; account_id: string }>();
  if (!row) return null;

  // Uppdatera last_used_at best effort. Det är diagnostik, inte en del av
  // autentiseringsbeslutet och får därför inte göra en giltig request skör.
  env.DB.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?")
    .bind(Date.now(), row.id)
    .run()
    .catch(() => {});

  const account = await getAccountById(env.DB, row.account_id);
  if (!account?.id || account.disabled) return null;

  // Defense in depth: även om route-gaten skulle regressa kan en API-nyckel
  // aldrig bli admin bara för att ägarkontot är admin.
  return { ...account, is_admin: 0 };
}
