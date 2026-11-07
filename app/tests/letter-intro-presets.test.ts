import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/letter-intro-presets.ts", import.meta.url), "utf8");
const migration = readFileSync(
  new URL("../../infra/migrations/0004_letter_intro_presets.sql", import.meta.url),
  "utf8",
);
const privacy = readFileSync(new URL("../src/letter-privacy.ts", import.meta.url), "utf8");
const indexSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

test("preset inputs require a heading and body with bounded lengths", () => {
  assert.match(source, /MAX_TITLE_LENGTH = 80/);
  assert.match(source, /MAX_BODY_LENGTH = 4000/);
  assert.match(source, /Rubrik krävs/);
  assert.match(source, /Inledningstext krävs/);
});

test("preset bodies and selected send-job intros are encrypted", () => {
  assert.match(source, /encryptLetterData\(env, preset\.body\)/);
  assert.match(source, /decryptLetterData\(env, row\.body\)/);
  assert.match(migration, /ALTER TABLE send_jobs ADD COLUMN intro_text TEXT/);
  assert.match(privacy, /UPDATE send_jobs SET intro_text=\?/);
});

test("presets are account scoped", () => {
  assert.match(migration, /account_id TEXT NOT NULL REFERENCES accounts\(id\) ON DELETE CASCADE/);
  assert.match(source, /WHERE account_id = \?/);
});

test("preset management requires a normal web session instead of expanding API-key access", () => {
  assert.match(indexSource, /letter-intro-presets[\s\S]*?Kräver webbsession/);
});
