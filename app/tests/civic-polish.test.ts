import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compactCss } from "./compact-source.ts";
import { test } from "node:test";

const css = compactCss(
  readFileSync(new URL("../public/civic-polish.css", import.meta.url), "utf8"),
);

function ruleSelectors(source: string): string[] {
  return [...source.matchAll(/(?:^|[{}])\s*([^@{}][^{}]*?)\{/g)]
    .flatMap((match) => match[1].split(","))
    .map((selector) => selector.replace(/\/\*[\s\S]*?\*\//g, "").trim())
    .filter(Boolean);
}

test("uses the Tre Kronor inspired navy and yellow palette tokens", () => {
  assert.match(css, /--bg-soft:#15244d;/i);
  assert.match(css, /--surface-3:#2d5d8d;/i);
  assert.match(css, /--accent:#ffd70d;/i);
  assert.match(css, /--accent-glow:rgba\(255,215,13,\.22\);/i);
});

test("active primary actions use navy text and a restrained yellow glow", () => {
  const match = css.match(/\.button--primary:not\(:disabled\)\{([^}]*)\}/s);
  assert.ok(match, "active primary button rule must exist");
  assert.match(match[1], /color:var\(--bg-soft\);/);
  assert.match(match[1], /box-shadow:[^;]*var\(--accent-glow\)/);
});

test("disabled primary actions use the same dark neutral surface as other disabled actions", () => {
  const match = css.match(
    /\.button--primary:disabled,\s*\.button--primary:disabled:hover\{([^}]*)\}/s,
  );
  assert.ok(match, "disabled primary button rule must exist");
  assert.match(match[1], /opacity:1;/);
  assert.match(match[1], /background:var\(--bg\);/);
  assert.match(match[1], /box-shadow:none;/);
  assert.doesNotMatch(match[1], /background:[^;]*var\(--accent\)/);
});

test("plain links use the current Swedish yellow without overriding button anchors", () => {
  assert.match(css, /a:not\(\.button\)\{\s*color:var\(--accent\);\s*\}/s);
  assert.match(css, /a:not\(\.button\):hover\{\s*color:var\(--accent-strong\);\s*\}/s);
  const unsafeAnchors = ruleSelectors(css).filter(
    (selector) => /^a(?:$|:|\[)/.test(selector) && !selector.startsWith("a:not(.button)"),
  );
  assert.deepEqual(unsafeAnchors, [], "generic anchor states must not override button anchors");
});

test("Safari autofill keeps inputs on the navy theme", () => {
  const match = css.match(/\.input:-webkit-autofill,\s*\.input:-webkit-autofill:hover\{([^}]*)\}/s);
  assert.ok(match, "Safari autofill rule must exist");
  assert.match(match[1], /-webkit-text-fill-color:var\(--text\);/);
  assert.match(match[1], /-webkit-box-shadow:0 0 0 1000px var\(--bg-soft\) inset;/);
});

test("focused Safari autofill inputs keep a visible yellow focus ring", () => {
  const match = css.match(/\.input:-webkit-autofill:focus\{([^}]*)\}/s);
  assert.ok(match, "focused Safari autofill rule must exist");
  assert.match(match[1], /border-color:var\(--accent\);/);
  assert.match(match[1], /-webkit-box-shadow:[^;]*inset,[^;]*rgba\(255,215,13,\.14\)/);
});

test("focused standard autofill inputs keep a visible yellow focus ring", () => {
  const match = css.match(/\.input:autofill:focus\{([^}]*)\}/s);
  assert.ok(match, "focused standard autofill rule must exist");
  assert.match(match[1], /border-color:var\(--accent\);/);
  assert.match(match[1], /box-shadow:[^;]*inset,[^;]*rgba\(255,215,13,\.14\)/);
});

test("document import action stays legible while disabled and becomes a yellow action when enabled", () => {
  assert.match(
    css,
    /\.compose-use-file:not\(:disabled\)\{[^}]*color:var\(--accent\);[^}]*border-color:var\(--accent\);/s,
  );
  assert.match(css, /\.compose-use-file:disabled\{[^}]*opacity:1;[^}]*background:var\(--bg\);/s);
});

test("open details use the yellow accent and subtle glow", () => {
  assert.match(
    css,
    /\.details\[open\]>summary,\s*\.private-import-details>summary\{[^}]*color:var\(--accent\);[^}]*text-shadow:/s,
  );
});
