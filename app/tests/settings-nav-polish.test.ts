import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compactCss } from "./compact-source.ts";
import { test } from "node:test";

const css = compactCss(
  readFileSync(new URL("../public/civic-polish.css", import.meta.url), "utf8"),
);

test("active settings tab keeps the standard accent yellow on sticky hover", () => {
  const match = css.match(
    /\.settings-nav \.button--primary:not\(:disabled\),\s*\.settings-nav \.button--primary:not\(:disabled\):hover\{([^}]*)\}/s,
  );
  assert.ok(match, "settings navigation needs a scoped active-state rule");
  assert.match(match[1], /border-color:var\(--accent\);/);
  assert.match(match[1], /background:var\(--accent\);/);
  assert.match(match[1], /box-shadow:none;/);
  assert.doesNotMatch(match[1], /accent-strong/);
});
