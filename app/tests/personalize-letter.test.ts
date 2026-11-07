import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assertSourceMatch, assertSourceNoMatch } from "./compact-source.ts";

const source = readFileSync(new URL("../src/personalize-letter.ts", import.meta.url), "utf8");
const queueSource = readFileSync(new URL("../src/send-queue.ts", import.meta.url), "utf8");

test("personalization accepts a separate intro and places it after the greeting", () => {
  assertSourceMatch(
    source,
    /personalizeLetter\(bodyHtml: string, recipientName: string, recipientEmail: string, introText = ""\)/,
  );
  assertSourceMatch(source, /greetingWithIntro/);
  assertSourceMatch(source, /introBlock/);
  assertSourceMatch(source, /safeGreeting/);
  assertSourceMatch(source, /bodyHtml/);
});

test("GREETING and legacy greeting placeholders receive the intro at the greeting position", () => {
  assertSourceMatch(source, /GREETING/);
  assertSourceMatch(source, /förnamn/);
  assertSourceMatch(source, /greetingWithIntro/);
});

test("queue consumer passes the send-job intro snapshot into personalization", () => {
  assertSourceMatch(queueSource, /sj\.intro_text/);
  assertSourceMatch(queueSource, /decryptLetterData\(env,job\.intro_text\)/);
  assertSourceMatch(
    queueSource,
    /personalizeLetter\(cachedLetterBody,m\.recipientName,m\.recipientEmail,introText\)/,
  );
});
