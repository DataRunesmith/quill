import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compactCss } from "./compact-source.ts";
import { test } from "node:test";

const css = compactCss(
  readFileSync(new URL("../public/civic-polish.css", import.meta.url), "utf8"),
);

test("mobile microcopy keeps readable font floors", () => {
  assert.match(css, /--font-mobile-meta:\.8rem;/);
  assert.match(css, /--font-mobile-secondary:\.875rem;/);
  assert.match(css, /--font-mobile-emphasis:\.9rem;/);
  assert.match(
    css,
    /\.service-band__inner span:last-child,\s*\.hero-proof__item small\s*\{[^}]*font-size:var\(--font-mobile-secondary\);/s,
  );
  assert.match(css, /\.hero-proof__item strong\s*\{[^}]*font-size:var\(--font-mobile-emphasis\);/s);
  assert.match(
    css,
    /\.card__eyebrow,\s*\.level-card__copy small,\s*\.table th\s*\{[^}]*font-size:var\(--font-mobile-meta\);/s,
  );
});
