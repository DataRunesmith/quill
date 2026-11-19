import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/personalize-letter.ts", import.meta.url), "utf8");

test("intro text is inserted with function replacers, never as a replacement pattern", () => {
  assert.match(source, /replace\(\/\\\{GREETING\\\}\/gi, \(\) => greetingWithIntro\)/);
  assert.match(source, /replace\(\/Hej\\s\+\\\[förnamn\\\]!\/gi, \(\) => greetingWithIntro\)/);
  assert.doesNotMatch(source, /replace\([^)]*, greetingWithIntro\)/);
});
