import assert from "node:assert/strict";
import test from "node:test";

import { d1ReplicaEligibleRequest, d1SessionBookmark, withD1Session } from "../src/d1-session.ts";

test("recipient metadata reads are replica eligible", () => {
  assert.equal(d1ReplicaEligibleRequest("GET", "/api/areas"), true);
  assert.equal(d1ReplicaEligibleRequest("GET", "/api/parties"), true);
  assert.equal(d1ReplicaEligibleRequest("GET", "/api/roles"), true);
  assert.equal(d1ReplicaEligibleRequest("GET", "/api/public-contacts/search"), true);
  assert.equal(d1ReplicaEligibleRequest("GET", "/api/politicians/search"), true);
  assert.equal(d1ReplicaEligibleRequest("POST", "/api/recipients/count"), true);
});

test("account, job and mutation routes stay on primary", () => {
  assert.equal(d1ReplicaEligibleRequest("GET", "/api/me"), false);
  assert.equal(d1ReplicaEligibleRequest("GET", "/api/send-jobs"), false);
  assert.equal(d1ReplicaEligibleRequest("POST", "/api/send"), false);
  assert.equal(d1ReplicaEligibleRequest("GET", "/api/admin/stats"), false);
});

test("bookmark sessions retain the original D1 binding", () => {
  const constraints: string[] = [];
  const primary = {
    withSession(constraint: string) {
      constraints.push(constraint);
      return { getBookmark: () => `bookmark:${constraint}` };
    },
  } as unknown as D1Database;
  const env = { DB: primary, marker: "ok" };

  const primaryEnv = withD1Session(env, "first-primary");
  const bookmark = d1SessionBookmark(primaryEnv);
  const replicaEnv = withD1Session(primaryEnv, bookmark ?? "first-unconstrained");

  assert.equal(bookmark, "bookmark:first-primary");
  assert.deepEqual(constraints, ["first-primary", "bookmark:first-primary"]);
  assert.equal(replicaEnv.marker, "ok");
});
