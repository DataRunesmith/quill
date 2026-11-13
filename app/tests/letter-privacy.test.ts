import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";
import type { Env } from "../src/db.ts";
import { decryptLetterData, encryptLetterData } from "../src/letter-privacy.ts";

if (!globalThis.crypto) Object.defineProperty(globalThis, "crypto", { value: webcrypto });

const env = { MAIL_CRED_KEY: Buffer.alloc(32, 7).toString("base64") } as unknown as Env;

for (const plaintext of ["enc:v1:attacker-controlled", "redacted:v1", "<p>Vanligt brev</p>"]) {
  test(`encrypts reserved marker safely: ${plaintext.slice(0, 24)}`, async () => {
    const stored = await encryptLetterData(env, plaintext);
    assert.notEqual(stored, plaintext);
    assert.ok(stored.startsWith("enc:v1:"));
    assert.equal(await decryptLetterData(env, stored), plaintext);
  });
}

test("legacy plaintext that starts with the encryption prefix is still readable", async () => {
  const { decryptLetterData, isEncryptedLetterData } = await import("../src/letter-privacy.ts");
  const legacy = "enc:v1: <p>Hej, detta är ett äldre brev</p>";
  assert.equal(isEncryptedLetterData(legacy), false);
  assert.equal(await decryptLetterData({} as never, legacy), legacy);
});
