import assert from "node:assert/strict";
import test from "node:test";

import { accessRoute, robotsPolicy } from "../src/access-routing.ts";

test("all canonical admin APIs use one private namespace", () => {
  for (const [method, pathname, internal] of [
    ["GET", "/admin/api/accounts", "/api/admin/accounts"],
    ["GET", "/admin/api/stats", "/api/admin/stats"],
    ["GET", "/admin/api/export", "/api/admin/export"],
    ["POST", "/admin/api/accounts/abc/reset-password", "/api/admin/accounts/abc/reset-password"],
    ["DELETE", "/admin/api/feedback/abc", "/api/admin/feedback/abc"],
  ] as const) {
    assert.deepEqual(accessRoute(pathname, method), { type: "rewrite", pathname: internal });
  }
});

test("legacy admin APIs redirect to /admin/api", () => {
  assert.deepEqual(accessRoute("/api/admin/stats", "GET"), {
    type: "redirect",
    pathname: "/admin/api/stats",
  });
  assert.deepEqual(accessRoute("/api/admin/accounts/abc/reset-password", "POST"), {
    type: "redirect",
    pathname: "/admin/api/accounts/abc/reset-password",
  });
  assert.deepEqual(accessRoute("/api/admin/feedback/abc", "DELETE"), {
    type: "redirect",
    pathname: "/admin/api/feedback/abc",
  });
});

test("old critical paths redirect to the single admin namespace", () => {
  assert.deepEqual(accessRoute("/admin/critical", "GET"), {
    type: "redirect",
    pathname: "/admin",
  });
  assert.deepEqual(accessRoute("/admin/critical/api/accounts/abc/reset-password", "POST"), {
    type: "redirect",
    pathname: "/admin/api/accounts/abc/reset-password",
  });
});

test("normal public and signed-in APIs are not moved", () => {
  for (const pathname of [
    "/api/me",
    "/api/send",
    "/api/feedback",
    "/api/oauth/google/start",
    "/",
    "/admin",
  ]) {
    assert.deepEqual(accessRoute(pathname), { type: "pass", pathname });
  }
});

test("robots policy indexes only the public root among worker-routed app paths", () => {
  assert.equal(robotsPolicy("/"), "index, follow, max-image-preview:large");
  assert.equal(robotsPolicy("/admin"), "noindex, nofollow");
  assert.equal(robotsPolicy("/admin/api/stats"), "noindex, nofollow");
  assert.equal(robotsPolicy("/api/me"), "noindex, nofollow");
  assert.equal(robotsPolicy("/faq.html"), null);
});
