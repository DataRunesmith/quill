import test from "node:test";
import assert from "node:assert/strict";
import {
  estimateBase64DecodedBytes,
  sanitizeAttachmentFilename,
  validateAttachmentBatch,
  validateContentType,
  validateMailboxAddress,
} from "../../shared/input-safety.ts";

test("mailbox validation rejects SMTP control characters", () => {
  assert.equal(validateMailboxAddress("user@example.com"), "user@example.com");
  assert.throws(() => validateMailboxAddress("user@example.com\r\nRCPT TO:<evil@example.com>"));
});

test("attachment metadata is normalized before MIME use", () => {
  assert.equal(sanitizeAttachmentFilename("../rapport.pdf"), "rapport.pdf");
  assert.equal(validateContentType("application/pdf"), "application/pdf");
  assert.throws(() => validateContentType("text/plain\r\nX-Test: yes"));
});

test("base64 size is known without decoding", () => {
  assert.equal(estimateBase64DecodedBytes("YWJj"), 3);
  assert.equal(estimateBase64DecodedBytes("YQ=="), 1);
  assert.throws(() => estimateBase64DecodedBytes("inte base64"));
});

test("attachment count is capped", () => {
  const attachment = { filename: "a.txt", contentType: "text/plain", base64Data: "YQ==" };
  assert.throws(() => validateAttachmentBatch(Array.from({ length: 6 }, () => attachment)));
});
