import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const checker = new URL("./check-addresses.mjs", import.meta.url);

for (const [text, expected] of [
  [["user", "v1.2"].join("@"), 1],
  [["user", "v1.2.3"].join("@"), 1],
  [["user", "v1.2.com"].join("@"), 1],
  ["uses: actions/checkout@v7.0.1", 0],
  ["uses: owner/repo/subaction@v1.2", 0],
  ["`owner/repo@v1.2.3`", 0],
  ["package@1.2.3", 0],
  ["scope@file.mjs", 0],
  ["user@example.com", 0],
  [["owner/repo", "v1.2.com"].join("@"), 1],
]) {
  test(`address check: ${text}`, () => {
    const cwd = mkdtempSync(join(tmpdir(), "quill-addresses-"));
    try {
      execFileSync("git", ["init", "--quiet"], { cwd });
      writeFileSync(join(cwd, "fixture.txt"), text);
      execFileSync("git", ["add", "fixture.txt"], { cwd });
      const result = spawnSync(process.execPath, [checker.pathname], { cwd, encoding: "utf8" });
      assert.equal(result.status, expected, result.stderr);
      if (expected === 1) assert.ok(result.stderr.includes("fixture.txt:1:"));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}
