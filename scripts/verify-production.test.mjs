import assert from "node:assert/strict";
import test from "node:test";

import {
  checkProduction,
  isCloudflareEdgeBlock,
  validateProductionResponse,
} from "./verify-production.mjs";

test("production root check accepts 200", async () => {
  assert.deepEqual(await validateProductionResponse(new Response("ok", { status: 200 })), {
    status: "ok",
  });
});

test("Cloudflare HTML 403 is classified as an edge block", async () => {
  const response = new Response("<!doctype html><title>blocked</title>", {
    status: 403,
    headers: {
      server: "cloudflare",
      "cf-ray": "abc123-ARN",
      "content-type": "text/html; charset=UTF-8",
    },
  });

  assert.equal(isCloudflareEdgeBlock(response), true);
  assert.deepEqual(await validateProductionResponse(response), {
    status: "edge_blocked",
    diagnostics: "server=cloudflare, cf-ray=abc123-ARN, content-type=text/html; charset=UTF-8",
  });
});

test("Cloudflare challenge header is classified as an edge block", async () => {
  const response = new Response("challenge", {
    status: 403,
    headers: {
      "cf-mitigated": "challenge",
      "content-type": "text/html",
    },
  });
  assert.equal(isCloudflareEdgeBlock(response), true);
});

test("application-style 403 still fails closed", async () => {
  await assert.rejects(
    validateProductionResponse(
      new Response('{"error":"forbidden"}', {
        status: 403,
        headers: { "content-type": "application/json" },
      }),
    ),
    /expected 200/,
  );
});

test("server failures still fail after retries", async () => {
  let attempts = 0;
  await assert.rejects(
    checkProduction({
      fetchImpl: async () => {
        attempts += 1;
        return new Response("bad gateway", { status: 502 });
      },
      sleep: async () => {},
    }),
    /failed after 5 attempts/,
  );
  assert.equal(attempts, 5);
});

test("edge-blocked ingress does not block completed control-plane deployment", async () => {
  let attempts = 0;
  const warnings = [];
  const result = await checkProduction({
    fetchImpl: async () => {
      attempts += 1;
      return new Response("<!doctype html><title>blocked</title>", {
        status: 403,
        headers: {
          server: "cloudflare",
          "cf-ray": "abc123-ARN",
          "content-type": "text/html",
        },
      });
    },
    sleep: async () => {},
    warn: (message) => warnings.push(message),
  });

  assert.equal(attempts, 1);
  assert.equal(result.status, "edge_blocked");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Production ingress blocked by Cloudflare edge/);
});
