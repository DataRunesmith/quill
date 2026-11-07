import assert from "node:assert/strict";
import test from "node:test";

import { cachedAggregate } from "../src/aggregate-cache.ts";

test("contact aggregates are loaded once and then served from the edge cache", async () => {
  const store = new Map<string, string>();
  (globalThis as { caches?: unknown }).caches = {
    default: {
      async match(request: Request) {
        const hit = store.get(request.url);
        return hit === undefined ? undefined : new Response(hit);
      },
      async put(request: Request, response: Response) {
        store.set(request.url, await response.text());
      },
    },
  };
  try {
    let loads = 0;
    const load = async () => {
      loads += 1;
      return [{ area_name: "Testkommun", count: 3 }];
    };
    const first = await cachedAggregate("areas", load);
    const second = await cachedAggregate("areas", load);
    assert.equal(loads, 1);
    assert.deepEqual(await second.json(), await first.json());
    assert.equal(second.headers.get("Content-Type"), "application/json");
    await cachedAggregate("roles", load);
    assert.equal(loads, 2, "each aggregate has its own cache entry");
  } finally {
    delete (globalThis as { caches?: unknown }).caches;
  }
});

test("without an edge cache the aggregate is loaded on every call", async () => {
  let loads = 0;
  await cachedAggregate("areas", async () => (loads += 1));
  await cachedAggregate("areas", async () => (loads += 1));
  assert.equal(loads, 2);
});
