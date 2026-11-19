---
name: new-migration
description: Create the next D1 migration in infra/migrations.
disable-model-invocation: true
---

1. List `infra/migrations` and pick the next number, zero-padded to four digits, then `_snake_case_name.sql`.
2. Write idempotent-safe SQL that matches the style of the existing files. Never edit an applied migration.
3. Verify with `cd app && npx wrangler d1 migrations apply DB --local`.
4. Add or update tests that cover the new schema.
