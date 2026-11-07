import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runInNewContext } from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "public", "app-send.js"), "utf8");

test("send payload deduplicates public and private recipients case-insensitively", () => {
  const state = {
    includeEmails: new Map([["Mixed@Example.COM", "Offentlig mottagare"]]),
    excludeEmails: new Map(),
    selectedAreas: new Set(),
    excludeParties: new Set(),
    includeRoles: new Set(),
    excludeBodies: new Set(),
    mediaCategories: new Set(),
    academicFields: new Set(["public-law"]),
    privateRecipientData: {
      contacts: [{ id: "c1", email: "mixed@example.com", name: "Privat mottagare" }],
      lists: [],
    },
    privateSelectedContactIds: new Set(["c1"]),
    privateSelectedListIds: new Set(),
    oneTimeRecipients: new Map(),
  };
  const context: Record<string, unknown> = { state };

  runInNewContext(source, context);
  const payload = (
    context.filterPayload as () => { includeEmails: string[]; includeRoles: string[] }
  )();

  assert.equal(payload.includeEmails.length, 1);
  assert.equal(payload.includeEmails[0], "Offentlig mottagare <mixed@example.com>");
  assert.ok(payload.includeRoles.includes("academic-field:public-law"));
});

test("contact import parser ignores semicolons inside quoted fields", () => {
  const context: Record<string, unknown> = {};
  runInNewContext(source, context);
  const parsed = (
    context.parseContactText as (text: string) => Array<{ email: string; name: string }>
  )('"Doe; Jane",jane@example.com');
  assert.deepEqual(JSON.parse(JSON.stringify(parsed)), [
    { email: "jane@example.com", name: "Doe; Jane" },
  ]);
});
