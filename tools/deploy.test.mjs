// tools/deploy.sh renders a temporary copy, applies D1 migrations and hands
// the copy to wrangler; the Deploy workflow feeds it every declared value from
// the repository secrets.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

const root = join(import.meta.dirname, "..");
const declared = [
  ...readFileSync(join(root, "cloudflare.example.env"), "utf8").matchAll(/^([A-Z][A-Z0-9_]*)=/gm),
].map((match) => match[1]);

// Runs deploy.sh with stand-ins for npm and npx, so nothing is installed or
// uploaded. The npx stand-in records where and how wrangler was called. The
// documentation build is left out; it needs the network.
function deploy(args, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), "deploy-test-"));
  const log = join(dir, "log");
  writeFileSync(join(dir, "npm"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(
    join(dir, "npx"),
    '#!/bin/sh\n{ pwd; echo "$*"; } >>"$DEPLOY_LOG"\ncp wrangler.jsonc "$DEPLOY_LOG.jsonc"\necho "${CLOUDFLARE_ACCOUNT_ID:-}" >"$DEPLOY_LOG.account"\n',
    { mode: 0o755 },
  );
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !declared.includes(name) && !name.startsWith("CLOUDFLARE_")),
  );
  const result = spawnSync("sh", [join(root, "tools/deploy.sh"), ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...clean, ...env, SKIP_DOCS: "1", PATH: `${dir}:${process.env.PATH}`, DEPLOY_LOG: log },
  });
  const called = existsSync(log);
  const lines = called ? readFileSync(log, "utf8").trimEnd().split("\n") : [];
  const config = called ? readFileSync(`${log}.jsonc`, "utf8") : "";
  const account = called ? readFileSync(`${log}.account`, "utf8").trim() : "";
  rmSync(dir, { recursive: true, force: true });
  return {
    status: result.status,
    stderr: result.stderr,
    called,
    cwd: lines[0],
    commands: lines.filter((_, index) => index % 2 === 1),
    config,
    account,
  };
}

// A values file of your own: the example values followed by extra lines.
function valuesFile(t, ...extra) {
  const dir = mkdtempSync(join(tmpdir(), "deploy-values-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "values.env");
  const example = readFileSync(join(root, "cloudflare.example.env"), "utf8");
  writeFileSync(file, [example, ...extra, ""].join("\n"));
  return file;
}

test("applies migrations and deploys a filled-in temporary copy, then removes it", () => {
  const run = deploy(["cloudflare.example.env"]);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.commands, ["wrangler d1 migrations apply DB --remote", "wrangler deploy"]);
  assert.match(run.config, /"pattern": "letters\.example\.com"/);
  assert.doesNotMatch(run.config, /__[A-Z][A-Z0-9_]*__/);
  assert.match(run.cwd, /\/app$/, "wrangler must run in the app directory of the copy");
  assert.ok(!run.cwd.startsWith(root), "the copy must live outside the repo");
  assert.ok(!existsSync(run.cwd), "the copy must be removed afterwards");
});

test("a dry run passes the flag on and leaves the database alone", () => {
  const run = deploy(["cloudflare.example.env", "--dry-run"]);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.commands, ["wrangler deploy --dry-run"]);
});

test("takes the values from the environment and treats unset names as empty", () => {
  const run = deploy(["--dry-run"], {
    PUBLIC_HOST: "letters.example.net",
    D1_DATABASE_NAME: "letters",
    D1_DATABASE_ID: "11111111-1111-1111-1111-111111111111",
  });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.commands, ["wrangler deploy --dry-run"]);
  assert.match(run.config, /"pattern": "letters\.example\.net"/);
  assert.match(run.config, /"database_id": "11111111-1111-1111-1111-111111111111"/);
  assert.doesNotMatch(run.config, /__[A-Z][A-Z0-9_]*__/);
});

test("refuses to deploy without any values", () => {
  const run = deploy([]);
  assert.equal(run.status, 1);
  assert.equal(run.called, false);
  assert.match(run.stderr, /No values found/);
});

test("refuses a values file that does not exist", () => {
  const run = deploy(["missing.env"]);
  assert.equal(run.status, 1);
  assert.equal(run.called, false);
  assert.match(run.stderr, /No such values file/);
});

test("hands the Cloudflare account in a values file, or in a file it names, to wrangler", (t) => {
  const file = valuesFile(t, `CLOUDFLARE_ACCOUNT_ID=${"1".repeat(32)}`);
  assert.equal(deploy([file, "--dry-run"]).account, "1".repeat(32));
  const preset = deploy([file, "--dry-run"], { CLOUDFLARE_ACCOUNT_ID: "2".repeat(32) });
  assert.equal(preset.account, "2".repeat(32));
  const named = valuesFile(t, "CLOUDFLARE_ACCOUNT_ID=@account.txt");
  writeFileSync(join(dirname(named), "account.txt"), `${"3".repeat(32)}\r\n`);
  assert.equal(deploy([named, "--dry-run"]).account, "3".repeat(32));
});

test("the Deploy workflow passes every declared value and the Cloudflare token", () => {
  const workflow = readFileSync(join(root, ".github/workflows/deploy.yml"), "utf8");
  for (const name of [...declared, "CLOUDFLARE_API_TOKEN"])
    assert.ok(
      workflow.includes(`      ${name}: \${{ secrets.${name} }}\n`),
      `${name} is missing from the deploy job's env`,
    );
  assert.match(workflow, /run: sh tools\/deploy\.sh\n/);
  // Only the deploy step sees the values, not the install and test steps.
  assert.doesNotMatch(workflow, /^    env:/m);
});
