import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const config = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));

test("root, API, and canonical admin requests run through the Worker", () => {
  assert.deepEqual(config.assets?.run_worker_first, ["/", "/api/*", "/admin", "/admin/*"]);
});
