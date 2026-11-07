import test from "node:test";
import assert from "node:assert/strict";

import { explicitEmailJsonChunks } from "../src/explicit-email-chunks.ts";

test("explicit recipient lookup chunks 10,000 long addresses below the D1 bind limit", () => {
  const values = Array.from(
    { length: 10_000 },
    (_, i) => `${String(i).padStart(5, "0")}${"a".repeat(235)}@e.se`,
  );
  const chunks = explicitEmailJsonChunks(values);
  const encoder = new TextEncoder();

  assert.ok(chunks.length > 1, "10,000 long addresses must use multiple D1 bindings");
  for (const chunk of chunks) {
    assert.ok(
      encoder.encode(chunk).byteLength <= 1_500_000,
      "each JSON binding must stay below the conservative cap",
    );
  }
  const reconstructed = Array.from(chunks, (chunk) => JSON.parse(chunk) as string[]).flat();
  assert.deepEqual(reconstructed, values);
});

test("an empty recipient list produces no bindings", () => {
  assert.deepEqual(explicitEmailJsonChunks([]), []);
});
