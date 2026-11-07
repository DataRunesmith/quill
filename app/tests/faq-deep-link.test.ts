import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { assertSourceMatch, assertSourceNoMatch } from "./compact-source.ts";

const html = readFileSync(new URL("../public/faq.html", import.meta.url), "utf8");
const script = readFileSync(new URL("../public/faq.js", import.meta.url), "utf8");

test("FAQ integrity deep link has a target and loads the hash handler", () => {
  assertSourceMatch(html, /<details class="details" id="integritet">/);
  assertSourceMatch(html, /<script src="\/faq\.js" defer><\/script>/);
});

test("FAQ uses the shared civic polish and navy browser theme", () => {
  assertSourceMatch(html, /<meta name="theme-color" content="#08122f">/i);
  assertSourceMatch(html, /<link rel="stylesheet" href="\/civic-polish\.css">/);
});

test("FAQ hash handler opens targeted details on load and hash changes", () => {
  assertSourceMatch(script, /target instanceof HTMLDetailsElement/);
  assertSourceMatch(script, /target\.open = true/);
  assertSourceMatch(script, /openHashTarget\(\);/);
  assertSourceMatch(script, /addEventListener\("hashchange", openHashTarget\)/);
});
