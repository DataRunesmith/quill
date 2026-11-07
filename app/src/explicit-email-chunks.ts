// Explicit recipients are passed to D1 as JSON arrays; keep each bound value well
// below the D1 bind size limit.
const MAX_EXPLICIT_EMAIL_BIND_BYTES = 1_500_000;
export function explicitEmailJsonChunks(values: string[]): string[] {
  const encoder = new TextEncoder(),
    chunks: string[] = [],
    current: string[] = [];
  let bytes = 2;
  for (const value of values) {
    const valueBytes = encoder.encode(JSON.stringify(value)).byteLength,
      additional = valueBytes + (current.length ? 1 : 0);
    if (current.length && bytes + additional > MAX_EXPLICIT_EMAIL_BIND_BYTES) {
      chunks.push(JSON.stringify(current));
      current.length = 0;
      bytes = 2;
    }
    const commaBytes = current.length ? 1 : 0;
    current.push(value);
    bytes += valueBytes + commaBytes;
  }
  if (current.length) chunks.push(JSON.stringify(current));
  return chunks;
}
