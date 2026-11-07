import test from "node:test";
import assert from "node:assert/strict";
import { isIrrelevantRecipientRole } from "../src/recipient-roles.ts";

test("irrelevant municipal and regional roles are rejected", () => {
  const blockedRoles = [
    "Revisor",
    "Kommunrevisor",
    "Nämndeman",
    "Nämndemän",
    "Vigselförrättare",
    "Partnerskapsförrättare",
    "God man",
    "Gode män i förmynderskapsärenden",
  ];

  for (const areaType of ["kommun", "region"]) {
    for (const role of blockedRoles) {
      assert.equal(isIrrelevantRecipientRole(areaType, role), true, `${areaType}: ${role}`);
    }
  }
});

test("legitimate municipal and regional roles are kept", () => {
  for (const role of ["Ledamot", "Ordförande", "Kommunalråd", "Regionråd"]) {
    assert.equal(isIrrelevantRecipientRole("kommun", role), false, role);
    assert.equal(isIrrelevantRecipientRole("region", role), false, role);
  }
});

test("role filtering does not affect EU, media, academia, or missing roles", () => {
  assert.equal(isIrrelevantRecipientRole("eu", "Revisor"), false);
  assert.equal(isIrrelevantRecipientRole("media", "Nämndeman"), false);
  assert.equal(isIrrelevantRecipientRole("academia", "Professor"), false);
  assert.equal(isIrrelevantRecipientRole("kommun", null), false);
  assert.equal(isIrrelevantRecipientRole("region", "   "), false);
});
