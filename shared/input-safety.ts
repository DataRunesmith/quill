export const MAX_ATTACHMENT_COUNT = 5;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 20 * 1024 * 1024;

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const MIME_TYPE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/;
const LOCAL_PART = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/;
const DOMAIN_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

export function assertNoControlCharacters(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed || CONTROL_CHARS.test(trimmed)) throw new Error(`Ogiltigt ${label}`);
  return trimmed;
}

export function validateMailboxAddress(value: string, label = "e-postadress"): string {
  const address = assertNoControlCharacters(value, label);
  if (
    address.length > 320 ||
    address.indexOf("@") <= 0 ||
    address.indexOf("@") !== address.lastIndexOf("@")
  ) {
    throw new Error(`Ogiltig ${label}`);
  }
  const [local, domain] = address.split("@");
  if (!local || local.length > 64 || !LOCAL_PART.test(local) || !domain || domain.length > 253) {
    throw new Error(`Ogiltig ${label}`);
  }
  const labels = domain.split(".");
  if (labels.length < 2 || labels.some((part) => !DOMAIN_LABEL.test(part)))
    throw new Error(`Ogiltig ${label}`);
  return `${local}@${domain.toLowerCase()}`;
}

export function sanitizeAttachmentFilename(value: string): string {
  const raw = assertNoControlCharacters(value, "filnamn");
  const basename = raw.split(/[\\/]/).pop() ?? "";
  const cleaned = basename
    .replace(/["'<>:|?*\\/]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) throw new Error("Ogiltigt filnamn");
  return cleaned.slice(0, 180);
}

export function validateContentType(value: string): string {
  const contentType = assertNoControlCharacters(value, "innehållstyp").toLowerCase();
  if (contentType.length > 127 || !MIME_TYPE.test(contentType))
    throw new Error("Ogiltig innehållstyp");
  return contentType;
}

export function estimateBase64DecodedBytes(value: string): number {
  const base64 = value.trim();
  if (!base64 || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
    throw new Error("Ogiltig base64-data");
  }
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return (base64.length / 4) * 3 - padding;
}

export function validateAttachmentBatch(
  attachments: Array<{ filename: string; contentType: string; base64Data: string }>,
): Array<{ filename: string; contentType: string; estimatedBytes: number }> {
  if (attachments.length > MAX_ATTACHMENT_COUNT) {
    throw new Error(`Högst ${MAX_ATTACHMENT_COUNT} bilagor per utskick är tillåtet.`);
  }
  let total = 0;
  return attachments.map((attachment) => {
    const filename = sanitizeAttachmentFilename(attachment.filename);
    const contentType = validateContentType(attachment.contentType);
    const estimatedBytes = estimateBase64DecodedBytes(attachment.base64Data);
    if (estimatedBytes > MAX_ATTACHMENT_BYTES)
      throw new Error(`${filename} är större än 10 MB — för stort.`);
    total += estimatedBytes;
    if (total > MAX_TOTAL_ATTACHMENT_BYTES)
      throw new Error("Bilagorna får tillsammans vara högst 20 MB.");
    return { filename, contentType, estimatedBytes };
  });
}
