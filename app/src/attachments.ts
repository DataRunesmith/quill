import { randomId } from "../../shared/crypto";
import { validateAttachmentBatch } from "../../shared/input-safety";
import { convertToHtml } from "./document-parsing";
import type { Env } from "./db";

export interface AttachmentInput {
  filename: string;
  contentType: string;
  mode: "attach" | "extract";
  base64Data: string;
}

function base64ToBytes(base64: string): Uint8Array {
  try {
    const binary = atob(base64.trim());
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    throw new Error("Bilagan innehåller ogiltig base64-data");
  }
}

// Hanterar uppladdade filer för ett brev. Storlek och metadata valideras innan
// base64 avkodas så en överstor begäran inte först expanderas i Worker-minnet.
export async function processAttachments(
  env: Env,
  letterId: string,
  attachments: AttachmentInput[],
): Promise<{ extractedHtml: string }> {
  let extractedHtml = "";
  const normalized = validateAttachmentBatch(attachments);

  for (let index = 0; index < attachments.length; index++) {
    const att = attachments[index];
    const meta = normalized[index];
    if (att.mode !== "attach" && att.mode !== "extract") throw new Error("Ogiltigt bilageläge");

    const bytes = base64ToBytes(att.base64Data);
    if (bytes.byteLength !== meta.estimatedBytes)
      throw new Error(`${meta.filename} kunde inte valideras.`);

    if (att.mode === "extract") {
      const html = await convertToHtml(
        meta.filename,
        meta.contentType,
        bytes.buffer as ArrayBuffer,
      );
      extractedHtml += `\n<hr>\n${html}`;
    }

    const r2Key = `${letterId}/${randomId()}-${meta.filename}`;
    await env.ATTACHMENTS.put(r2Key, bytes, { httpMetadata: { contentType: meta.contentType } });
    await env.DB.prepare(
      `INSERT INTO letter_attachments (id, letter_id, filename, content_type, r2_key, size_bytes, mode, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        randomId(),
        letterId,
        meta.filename,
        meta.contentType,
        r2Key,
        bytes.byteLength,
        att.mode,
        Date.now(),
      )
      .run();
  }

  return { extractedHtml };
}
