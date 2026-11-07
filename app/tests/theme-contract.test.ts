import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { assertSourceMatch, assertSourceNoMatch, compactCss } from "./compact-source.ts";

const publicAsset = (name: string) =>
  readFileSync(new URL("../public/" + name, import.meta.url), "utf8");

test("shared themes preserve Quill identity tokens", () => {
  const theme = compactCss(publicAsset("theme.css"));
  const civic = compactCss(publicAsset("civic-polish.css"));
  const script = publicAsset("theme.js");

  assert.match(theme, /:root\[data-theme="legacy"\]/);
  assert.match(theme, /:root\[data-theme="forest"\]/);
  assert.match(theme, /:root\[data-theme="blackout"\]/);
  assert.match(theme, /rgba\(36,231,232,\.11\)/);
  assert.match(theme, /rgba\(213,29,203,\.10?\)/);
  assert.match(theme, /background-size:42px 42px/);
  assert.doesNotMatch(theme, /--accent:/);
  assert.match(civic, /--accent:#ffd70d/i);
  assert.match(civic, /--accent-blue:#2d5d8d/i);
  assertSourceMatch(script, /__THEME_KEY_PREFIX__\.theme/);
  assertSourceMatch(script, /__THEME_KEY_PREFIX___theme/);
  assertSourceMatch(script, /__THEME_COOKIE_DOMAIN__/);
});

test("all primary pages expose Legacy, Forest and Blackout", () => {
  for (const name of ["index.html", "faq.html", "resurser.html"]) {
    const html = publicAsset(name);
    assertSourceMatch(html, /data-theme="legacy"/);
    assertSourceMatch(html, /href="\/theme\.css"/);
    assert.equal((html.match(/src="\/theme\.js"/g) ?? []).length, 1);
    assertSourceMatch(html, /value="legacy">Legacy/);
    assertSourceMatch(html, /value="forest">__SITE_FAMILY__/);
    assertSourceMatch(html, /value="blackout">Blackout/);
    assert.equal((html.match(/id="theme-select"/g) ?? []).length, 1);
    assert.ok(
      html.indexOf('id="theme-select"') > html.indexOf("</main>"),
      `${name}: theme control should be below main content`,
    );
  }
});
