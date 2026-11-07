import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { assertSourceIncludes, assertSourceMatch, assertSourceNoMatch } from "./compact-source.ts";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const headers = readFileSync(new URL("../public/_headers", import.meta.url), "utf8");
const manifest = JSON.parse(
  readFileSync(new URL("../public/site.webmanifest", import.meta.url), "utf8"),
) as {
  name: string;
  id: string;
  start_url: string;
  scope: string;
  display: string;
  icons: Array<{ src: string; sizes: string; type: string; purpose: string }>;
};

test("publishes broad link-preview metadata with an absolute cache-busted image URL", () => {
  const imageUrl = "https://__PUBLIC_HOST__/civic-hero.png?preview=20260905";

  assertSourceMatch(html, /<link rel="canonical" href="https:\/\/__PUBLIC_HOST__\/">/);
  assertSourceIncludes(html, `<link rel="image_src" href="${imageUrl}">`);
  assertSourceIncludes(html, `<meta itemprop="image" content="${imageUrl}">`);
  assertSourceIncludes(html, `<meta property="og:image" content="${imageUrl}">`);
  assertSourceIncludes(html, `<meta property="og:image:url" content="${imageUrl}">`);
  assertSourceIncludes(html, `<meta property="og:image:secure_url" content="${imageUrl}">`);
  assertSourceMatch(html, /<meta property="og:image:type" content="image\/png">/);
  assertSourceMatch(html, /<meta name="twitter:card" content="summary_large_image">/);
  assertSourceIncludes(html, `<meta name="twitter:image" content="${imageUrl}">`);
  assertSourceMatch(
    html,
    /<meta name="twitter:image:alt" content="Quill – nå politiker direkt">/,
  );
  assertSourceMatch(html, /max-image-preview:large/);
});

test("allows public preview images and favicons to load cross-origin", () => {
  assertSourceMatch(
    headers,
    /\/civic-hero\.png\r?\n\s*! Cross-Origin-Resource-Policy\r?\n\s*Access-Control-Allow-Origin: \*/,
  );
  assertSourceMatch(
    headers,
    /\/favicon\*\r?\n\s*! Cross-Origin-Resource-Policy\r?\n\s*Access-Control-Allow-Origin: \*/,
  );
});

test("publishes a manifest backed by the existing app icons", () => {
  assert.equal(manifest.name, "Quill");
  assert.equal(manifest.id, "/");
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.scope, "/");
  assert.equal(manifest.display, "standalone");
  assert.deepEqual(manifest.icons, [
    { src: "/favicon-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
    { src: "/favicon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
  ]);
  assertSourceMatch(html, /<link rel="manifest" href="\/site\.webmanifest">/);
});
