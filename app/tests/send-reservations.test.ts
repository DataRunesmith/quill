import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

const source = readFileSync(new URL("../src/send.ts", import.meta.url), "utf8");
const migration = readFileSync(
  new URL("../../infra/migrations/0007_send_reservations.sql", import.meta.url),
  "utf8",
);
const insert = source.match(/INSERT OR IGNORE INTO send_reservations[\s\S]*?\) < \?9\)`/)?.[0];

test("reservation insert claims the last slot only once", () => {
  assert.ok(insert, "reservation statement present in send.ts");
  const db = new DatabaseSync(":memory:");
  db.exec(migration);
  db.exec(
    "CREATE TABLE send_log(account_id, sent_at, status, send_job_id); CREATE TABLE send_jobs(id, mail_credential_id)",
  );
  const stmt = db.prepare(insert);
  const now = Date.now();
  const claim = (email: string, accountCap: number, credentialCap: number | null) =>
    Number(
      stmt.run("job", email, "acc", "cred", now, now + 60_000, 0, accountCap, credentialCap)
        .changes,
    );
  assert.equal(claim("a@x.example", 2, null), 1);
  assert.equal(claim("b@x.example", 2, null), 1);
  assert.equal(claim("c@x.example", 2, null), 0, "account cap reached by reservations");
  assert.equal(claim("a@x.example", 2, null), 0, "same recipient stays a single reservation");
  assert.equal(claim("d@x.example", 10, 2), 0, "credential cap counts reservations too");
});
