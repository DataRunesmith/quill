import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { assertSourceMatch, assertSourceNoMatch } from "./compact-source.ts";

const editor = await readFile(new URL("../public/letter-editor.js", import.meta.url), "utf8");
const intros = await readFile(new URL("../public/letter-intros.js", import.meta.url), "utf8");
const settings = await readFile(new URL("../public/app-settings.js", import.meta.url), "utf8");
const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const index = await readFile(new URL("../public/index.html", import.meta.url), "utf8");

test("intro feature has one browser module loaded before its consumers", () => {
  const introScript = index.indexOf("/letter-intros.js");
  const editorScript = index.indexOf("/letter-editor.js");
  const settingsScript = index.indexOf("/app-settings.js");
  assert.ok(introScript >= 0);
  assert.ok(introScript < editorScript);
  assert.ok(introScript < settingsScript);
  assertSourceMatch(settings, /QuillLetterIntros\.renderSettings\(\)/);
  assertSourceMatch(editor, /window\.QuillLetterIntros/);
});

test("compose offers the built-in broad-audience intro after the automatic greeting", () => {
  assertSourceMatch(editor, /Börja mejlet med/);
  assertSourceMatch(intros, /Brett mottagarbrev/);
  assertSourceMatch(intros, /Detta brev skickas till politiker, journalister och akademiker/);
  assertSourceMatch(editor, /efter den automatiska hälsningen “Hej \{namn\}!”/);
});

test("review and send use the separately selected intro text", () => {
  assertSourceMatch(editor, /const introText=intros\.selectedText\(\)/);
  assertSourceMatch(editor, /intros\.previewLetter\(bodyHtml,introText\)/);
  assertSourceMatch(editor, /introText:introText\|\|undefined/);
  assertSourceMatch(editor, /intros\.clearSelection\(\)/);
});

test("preset display uses DOM text nodes instead of interpolating user text into HTML", () => {
  assertSourceMatch(intros, /heading\.textContent=title/);
  assertSourceMatch(intros, /detail\.textContent=description/);
  assertSourceMatch(intros, /title\.textContent=preset\.title/);
  assertSourceMatch(intros, /appendMultilineText\(body,preset\.body\)/);
  assertSourceNoMatch(intros, /innerHTML=.*preset\.(?:title|body)/);
});

test("settings expose reusable intro presets with headings", () => {
  assertSourceMatch(settings, /\['intros','Inledningar'\]/);
  assertSourceMatch(intros, /<label>Rubrik<\/label>/);
  assertSourceMatch(intros, /<label>Text<\/label>/);
  assertSourceMatch(intros, /\/api\/letter-intro-presets/);
  assertSourceMatch(app, /'mail','intros','account','security','api'/);
});
