import { randomId } from "../../shared/crypto";
import type { Env } from "./db";
import { decryptLetterData, encryptLetterData } from "./letter-privacy";

const MAX_PRESETS = 50;
const MAX_TITLE_LENGTH = 80;
const MAX_BODY_LENGTH = 4000;
const MAX_SELECTED_INTRO_LENGTH = 20_000;
const INVALID_BODY_CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const PRESET_FIELDS = "id, title, body_text AS body, created_at, updated_at";

export interface LetterIntroPresetInput {
  title: string;
  body: string;
}

export interface LetterIntroPreset {
  id: string;
  title: string;
  body: string;
  created_at: number;
  updated_at: number;
}

export function normalizeSelectedLetterIntroText(value: unknown): string {
  if (value == null || value === "") return "";
  if (typeof value !== "string") throw new Error("Ogiltig inledningstext");
  const body = value.replace(/\r\n?/g, "\n").trim();
  if (body.length > MAX_SELECTED_INTRO_LENGTH)
    throw new Error(
      `Valda inledningar får tillsammans vara högst ${MAX_SELECTED_INTRO_LENGTH} tecken`,
    );
  if (INVALID_BODY_CONTROLS.test(body))
    throw new Error("Inledningstexten innehåller ogiltiga kontrolltecken");
  return body;
}

export function normalizeLetterIntroPresetInput(
  input: LetterIntroPresetInput,
): LetterIntroPresetInput {
  const title =
    typeof input?.title === "string"
      ? input.title.replace(/[\u0000-\u001f\u007f]/g, " ").trim()
      : "";
  const body = typeof input?.body === "string" ? input.body.replace(/\r\n?/g, "\n").trim() : "";
  if (!title) throw new Error("Rubrik krävs");
  if (title.length > MAX_TITLE_LENGTH)
    throw new Error(`Rubriken får vara högst ${MAX_TITLE_LENGTH} tecken`);
  if (!body) throw new Error("Inledningstext krävs");
  if (body.length > MAX_BODY_LENGTH)
    throw new Error(`Inledningstexten får vara högst ${MAX_BODY_LENGTH} tecken`);
  if (INVALID_BODY_CONTROLS.test(body))
    throw new Error("Inledningstexten innehåller ogiltiga kontrolltecken");
  return { title, body };
}

async function decryptPreset(env: Env, row: LetterIntroPreset): Promise<LetterIntroPreset> {
  return { ...row, body: await decryptLetterData(env, row.body) };
}

export async function listLetterIntroPresets(
  env: Env,
  accountId: string,
): Promise<LetterIntroPreset[]> {
  const { results } = await env.DB.prepare(
    `SELECT ${PRESET_FIELDS} FROM letter_intro_presets WHERE account_id = ? ORDER BY created_at, id`,
  )
    .bind(accountId)
    .all<LetterIntroPreset>();
  return Promise.all(results.map((row) => decryptPreset(env, row)));
}

export async function createLetterIntroPreset(
  env: Env,
  accountId: string,
  input: LetterIntroPresetInput,
): Promise<LetterIntroPreset> {
  const preset = normalizeLetterIntroPresetInput(input);
  const count = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM letter_intro_presets WHERE account_id = ?",
  )
    .bind(accountId)
    .first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_PRESETS)
    throw new Error(`Högst ${MAX_PRESETS} inledningar kan sparas`);
  const id = randomId();
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO letter_intro_presets (id, account_id, title, body_text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(id, accountId, preset.title, await encryptLetterData(env, preset.body), now, now)
    .run();
  return { id, ...preset, created_at: now, updated_at: now };
}

export async function updateLetterIntroPreset(
  env: Env,
  accountId: string,
  id: string,
  input: LetterIntroPresetInput,
): Promise<LetterIntroPreset> {
  const preset = normalizeLetterIntroPresetInput(input);
  const updatedAt = Date.now();
  const result = await env.DB.prepare(
    "UPDATE letter_intro_presets SET title = ?, body_text = ?, updated_at = ? WHERE id = ? AND account_id = ?",
  )
    .bind(preset.title, await encryptLetterData(env, preset.body), updatedAt, id, accountId)
    .run();
  if ((result.meta.changes ?? 0) !== 1) throw new Error("Inledningen finns inte");
  const row = await env.DB.prepare(
    `SELECT ${PRESET_FIELDS} FROM letter_intro_presets WHERE id = ? AND account_id = ?`,
  )
    .bind(id, accountId)
    .first<LetterIntroPreset>();
  if (!row) throw new Error("Inledningen finns inte");
  return decryptPreset(env, row);
}

export async function deleteLetterIntroPreset(
  env: Env,
  accountId: string,
  id: string,
): Promise<void> {
  const result = await env.DB.prepare(
    "DELETE FROM letter_intro_presets WHERE id = ? AND account_id = ?",
  )
    .bind(id, accountId)
    .run();
  if ((result.meta.changes ?? 0) !== 1) throw new Error("Inledningen finns inte");
}
