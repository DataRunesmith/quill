import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compactCss, assertSourceMatch, assertSourceNoMatch } from "./compact-source.ts";
import test from "node:test";

const script = readFileSync(
  new URL("../public/recipient-filter-groups.js", import.meta.url),
  "utf8",
);
const index = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const css = compactCss(
  readFileSync(new URL("../public/civic-polish.css", import.meta.url), "utf8"),
);

test("advanced recipient areas are rendered as collapsible audience groups", () => {
  assertSourceMatch(script, /filter-area-group/);
  assertSourceMatch(script, /details\.dataset\.areaType = type/);
  assertSourceMatch(script, /selectedTypes\.has\(type\)/);
  assertSourceMatch(script, /openAreaTypes\.has\(type\)/);
  assertSourceMatch(script, /Visar de första 200/);
});

test("selected audience types control which advanced sections are relevant", () => {
  assertSourceMatch(script, /selectedTypes\.has\('academia'\)/);
  assertSourceMatch(script, /selectedTypes\.has\('media'\)/);
  assertSourceMatch(script, /selectedTypes\.has\('kommun'\).*selectedTypes\.has\('region'\)/s);
  assertSourceMatch(script, /POLITICAL_TYPES/);
  assertSourceMatch(script, /setRelevant\(academicFilter, hasAcademia/);
  assertSourceMatch(script, /setRelevant\(mediaFilter, hasMedia/);
  assertSourceMatch(script, /setRelevant\(localFilter, hasLocal/);
});

test("area search works across grouped audiences without flattening the registry", () => {
  assertSourceMatch(script, /groupedAreaData\(needle\)/);
  assertSourceMatch(script, /renderAreaGroups\(event\.target\.value\)/);
  assertSourceMatch(script, /Kommun, region, universitet/);
});

test("grouped filter UI is loaded after the base send and metadata scripts", () => {
  const send = index.indexOf("/app-send.js");
  const meta = index.indexOf("/recipient-meta.js");
  const groups = index.indexOf("/recipient-filter-groups.js");
  assert.ok(send >= 0 && meta > send && groups > meta);
});

test("collapsible audience groups have dedicated responsive styling", () => {
  assertSourceMatch(css, /#area-list\.filter-area-groups/);
  assertSourceMatch(css, /\.filter-area-group\[open\]/);
  assertSourceMatch(css, /\.filter-area-group__meta/);
  assertSourceMatch(css, /\.advanced-filter-section\[hidden\]/);
});
