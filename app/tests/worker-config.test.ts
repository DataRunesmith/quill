import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const wrangler = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));

test("production config keeps all runtime bindings", () => {
  assert.equal(wrangler.name, "quill");
  assert.equal(wrangler.observability?.enabled, true);
  assert.ok(wrangler.d1_databases?.some((binding) => binding.binding === "DB"));
  assert.ok(wrangler.kv_namespaces?.some((binding) => binding.binding === "SESSIONS"));
  assert.ok(wrangler.queues?.producers?.some((binding) => binding.binding === "SEND_QUEUE"));
  assert.ok(wrangler.queues?.consumers?.some((binding) => binding.queue === "quill-send-jobs"));
  assert.ok(wrangler.durable_objects?.bindings?.some((binding) => binding.name === "RATE_LIMITER"));
  assert.ok(wrangler.r2_buckets?.some((binding) => binding.binding === "ATTACHMENTS"));
  assert.ok(wrangler.routes?.some((route) => route.pattern === "__PUBLIC_HOST__"));
  assert.ok(wrangler.triggers?.crons?.length > 0);
});

test("only the production custom domain is exposed", () => {
  assert.equal(wrangler.workers_dev, false);
  assert.equal(wrangler.preview_urls, false);
  assert.equal(wrangler.previews, undefined);
});
