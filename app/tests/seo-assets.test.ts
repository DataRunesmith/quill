import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { assertSourceMatch, assertSourceNoMatch } from "./compact-source.ts";

const publicDir = new URL("../public/", import.meta.url);

async function readPublic(name: string) {
  return readFile(new URL(name, publicDir), "utf8");
}

test("public index and FAQ expose canonical index metadata", async () => {
  const [index, faq] = await Promise.all([readPublic("index.html"), readPublic("faq.html")]);

  assertSourceMatch(index, /<meta name="robots" content="index,follow,max-image-preview:large">/);
  assertSourceMatch(index, /<link rel="canonical" href="https:\/\/__PUBLIC_HOST__\/">/);
  assertSourceMatch(faq, /<meta name="robots" content="index,follow,max-image-preview:large">/);
  assertSourceMatch(faq, /<link rel="canonical" href="https:\/\/__PUBLIC_HOST__\/faq\.html">/);
});

test("crawler assets advertise only public content", async () => {
  const [robots, sitemap] = await Promise.all([
    readPublic("robots.txt"),
    readPublic("sitemap.xml"),
  ]);

  assertSourceMatch(robots, /User-agent: \*/);
  assertSourceMatch(robots, /Allow: \//);
  assertSourceMatch(robots, /Sitemap: https:\/\/__PUBLIC_HOST__\/sitemap\.xml/);
  assertSourceMatch(sitemap, /https:\/\/__PUBLIC_HOST__\/<\/loc>/);
  assertSourceMatch(sitemap, /https:\/\/__PUBLIC_HOST__\/faq\.html<\/loc>/);
  assertSourceNoMatch(sitemap, /\/admin|\/api\//);
});
