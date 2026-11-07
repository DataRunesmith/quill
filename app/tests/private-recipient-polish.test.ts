import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script, createContext } from "node:vm";
import { test } from "node:test";
import { assertSourceMatch, assertSourceNoMatch } from "./compact-source.ts";

const source = readFileSync(
  new URL("../public/private-recipient-polish.js", import.meta.url),
  "utf8",
);

function loadParser(): (text: string) => { email: string; name: string }[] {
  const context = createContext({});
  new Script(source).runInContext(context);
  return context.parseContactText as (text: string) => { email: string; name: string }[];
}

function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

test("extracts CSV, plain and display-name recipient formats", () => {
  const parse = loadParser();
  assert.deepEqual(
    plain(
      parse(
        [
          "Namn,E-post",
          "Anna Andersson,anna@example.com",
          "erik@example.com",
          "Lisa Larsson <lisa@example.com>",
        ].join("\n"),
      ),
    ),
    [
      { email: "anna@example.com", name: "Anna Andersson" },
      { email: "erik@example.com", name: "" },
      { email: "lisa@example.com", name: "Lisa Larsson" },
    ],
  );
});

test("extracts several addresses from the same line and deduplicates them", () => {
  const parse = loadParser();
  assert.deepEqual(plain(parse("anna@example.com; Erik <erik@example.com>; ANNA@example.com")), [
    { email: "anna@example.com", name: "" },
    { email: "erik@example.com", name: "Erik" },
  ]);
});

test("ignores surrounding prose but requires at least one valid address", () => {
  const parse = loadParser();
  assert.deepEqual(plain(parse("Lokala journalister\nKontakta anna@example.com först.")), [
    { email: "anna@example.com", name: "" },
  ]);
  assert.throws(() => parse("Här finns inga adresser"), /inga giltiga e-postadresser/i);
});

test("clarifies the document import action and gives it a dedicated style hook", () => {
  assertSourceMatch(source, /useFile\.textContent='Använd vald fil som brevtext'/);
  assertSourceMatch(source, /useFile\.classList\.add\('compose-use-file'\)/);
});
