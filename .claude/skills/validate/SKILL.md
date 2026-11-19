---
name: validate
description: Run the full quality gate (app validate, script tests, contact tooling tests) before a push.
disable-model-invocation: true
---

Run from the repository root and report only failures:

1. `cd app && npm run validate`
2. `node --test tools/*.test.mjs scripts/*.test.mjs`
3. `cd kontakter && python -m pytest tests`

Do not push if any step fails.
