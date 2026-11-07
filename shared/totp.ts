// TOTP (RFC 6238) via Web Crypto HMAC-SHA1 — ingen extern dependency.
// Hemligheten visas som base32 för manuell inmatning i en autentiserings-app
// (Google Authenticator, Authy, etc). Ingen QR-kod genereras via tredjeparts-
// tjänst eftersom det skulle skicka hemligheten till en extern server.

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP_SECONDS = 30;
const DIGITS = 6;

export function generateTotpSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20)); // 160 bit, standard för TOTP
  return base32Encode(bytes);
}

export function totpAuthUri(
  secret: string,
  accountEmail: string,
  issuer = "__PUBLIC_HOST__",
): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(accountEmail)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&digits=${DIGITS}&period=${STEP_SECONDS}`;
}

export async function verifyTotpCode(
  secret: string,
  code: string,
  windowSteps = 1,
): Promise<boolean> {
  const key = base32Decode(secret);
  const now = Math.floor(Date.now() / 1000 / STEP_SECONDS);

  for (let offset = -windowSteps; offset <= windowSteps; offset++) {
    const expected = await computeTotp(key, now + offset);
    if (expected === code) return true;
  }
  return false;
}

async function computeTotp(key: Uint8Array, counter: number): Promise<string> {
  const counterBytes = new Uint8Array(8);
  let c = counter;
  for (let i = 7; i >= 0; i--) {
    counterBytes[i] = c & 0xff;
    c = Math.floor(c / 256);
  }

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const hmac = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, counterBytes));

  const offset = hmac[hmac.length - 1] & 0x0f;
  const binCode =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  const code = (binCode % 10 ** DIGITS).toString().padStart(DIGITS, "0");
  return code;
}

function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

function base32Decode(input: string): Uint8Array {
  const cleaned = input.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(bytes);
}
