import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  normalizeImportedContacts,
  normalizePrivateContactInput,
  parseIncludedRecipient,
} from "../src/recipient-address.ts";

const here = dirname(fileURLToPath(import.meta.url));

test("private contacts normalize email and sanitize display names", () => {
  assert.deepEqual(
    normalizePrivateContactInput({ email: "  ANNA@Example.COM ", name: "Anna\r\nAndersson" }),
    { email: "anna@example.com", name: "Anna  Andersson" },
  );
  assert.throws(
    () => normalizePrivateContactInput({ email: "inte-en-adress" }),
    /Ogiltig e-postadress/,
  );
});

test("private contact imports deduplicate case-insensitive addresses", () => {
  assert.deepEqual(
    normalizeImportedContacts([
      { email: "ANNA@example.com" },
      { email: "anna@example.com", name: "Anna Andersson" },
      { email: "erik@example.com", name: "Erik" },
    ]),
    [
      { email: "anna@example.com", name: "Anna Andersson" },
      { email: "erik@example.com", name: "Erik" },
    ],
  );
});

test("explicit recipients support both raw addresses and display names", () => {
  assert.deepEqual(parseIncludedRecipient("EXTRA@example.com"), {
    email: "extra@example.com",
    name: "",
  });
  assert.deepEqual(parseIncludedRecipient("Extra Person <EXTRA@example.com>"), {
    email: "extra@example.com",
    name: "Extra Person",
  });
  assert.equal(parseIncludedRecipient("not-an-email"), null);
});

test("too long email addresses are rejected instead of truncated", () => {
  const tooLongEmail = `${"a".repeat(250)}@e.se`;
  assert.throws(
    () => normalizePrivateContactInput({ email: tooLongEmail }),
    /Ogiltig e-postadress/,
  );
  assert.equal(parseIncludedRecipient(tooLongEmail), null);
});

test("private contact schema enforces account ownership on lists, contacts, and membership", () => {
  const migration = readFileSync(
    join(here, "..", "..", "infra", "migrations", "0002_account_private_contacts.sql"),
    "utf8",
  );
  assert.match(
    migration,
    /account_contact_lists[\s\S]*account_id TEXT NOT NULL REFERENCES accounts\(id\)/,
  );
  assert.match(
    migration,
    /account_contacts[\s\S]*account_id TEXT NOT NULL REFERENCES accounts\(id\)/,
  );
  assert.match(
    migration,
    /FOREIGN KEY\(list_id, account_id\) REFERENCES account_contact_lists\(id, account_id\)/,
  );
  assert.match(
    migration,
    /FOREIGN KEY\(contact_id, account_id\) REFERENCES account_contacts\(id, account_id\)/,
  );
});
