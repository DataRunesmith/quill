import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { assertSourceMatch, assertSourceNoMatch } from "./compact-source.ts";

const read = (name: string) => readFileSync(new URL("../public/" + name, import.meta.url), "utf8");

test("all primary public pages expose PWA install metadata", () => {
  for (const name of ["index.html", "faq.html", "resurser.html"]) {
    const html = read(name);
    assertSourceMatch(html, /<link rel="manifest" href="\/site\.webmanifest">/);
    assertSourceMatch(html, /<link rel="apple-touch-icon"[^>]+favicon-192\.png/);
    assertSourceMatch(html, /<script src="\/pwa\.js" defer><\/script>/);
    assertSourceNoMatch(
      html,
      />\\n\s*</,
      `${name} must not contain escaped newlines between HTML tags`,
    );
  }
});

test("service worker is secure-context registered and network-only", () => {
  const pwa = read("pwa.js");
  const worker = read("service-worker.js");

  assertSourceMatch(pwa, /window\.isSecureContext/);
  assertSourceMatch(pwa, /serviceWorker\.register\("\/service-worker\.js"/);
  assertSourceMatch(worker, /self\.addEventListener\("fetch"/);
  assertSourceNoMatch(worker, /caches\./);
  assertSourceNoMatch(worker, /respondWith\(/);
  assertSourceNoMatch(worker, /\/api\//);
});
