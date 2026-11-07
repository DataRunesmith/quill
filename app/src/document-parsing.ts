// Konverterar uppladdade dokument till HTML-brevtext ("extract"-läge).
// .doc (gamla binära Word-formatet) stöds INTE — inget rimligt lättviktigt
// bibliotek finns för det; sådana filer kan bara bifogas, inte konverteras.

import { escapeHtml } from "../../shared/html";

const SAFE_SIMPLE_TAGS = new Set([
  "p",
  "br",
  "strong",
  "em",
  "b",
  "i",
  "u",
  "ul",
  "ol",
  "li",
  "blockquote",
  "h1",
  "h2",
  "h3",
]);

function safeHref(value: string): string | null {
  const href = value.trim();
  try {
    const url = new URL(href, "https://__PUBLIC_HOST__/");
    if (url.protocol === "https:" || url.protocol === "http:" || url.protocol === "mailto:")
      return href;
  } catch {}
  return null;
}

// Textescaping och attributescaping är olika kontexter. shared/escapeHtml
// skyddar textnoder (&, <, >), men ett dubbelciterat attribut måste dessutom
// koda citattecken så opålitlig input aldrig kan bryta sig ur href="...".
function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Mammoth genererar HTML, men dokumentinnehåll är fortfarande opålitlig input.
// Normalisera till en liten allowlist och kasta alla attribut utom säkra href.
function sanitizeConvertedHtml(html: string): string {
  return html
    .split(/(<[^>]*>)/g)
    .map((token) => {
      if (!token.startsWith("<")) return token.replace(/</g, "&lt;");

      const close = token.match(/^<\s*\/\s*([a-z0-9]+)\s*>$/i);
      if (close) {
        const tag = close[1].toLowerCase();
        return SAFE_SIMPLE_TAGS.has(tag) || tag === "a" ? `</${tag}>` : "";
      }

      const open = token.match(/^<\s*([a-z0-9]+)([^>]*)>$/i);
      if (!open) return "";
      const tag = open[1].toLowerCase();
      if (SAFE_SIMPLE_TAGS.has(tag)) return tag === "br" ? "<br>" : `<${tag}>`;
      if (tag !== "a") return "";

      const attrs = open[2];
      const hrefMatch = attrs.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
      const href = safeHref(hrefMatch?.[1] ?? hrefMatch?.[2] ?? "");
      return href ? `<a href="${escapeHtmlAttribute(href)}" rel="noopener noreferrer">` : "<a>";
    })
    .join("");
}

export async function convertToHtml(
  filename: string,
  contentType: string,
  bytes: ArrayBuffer,
): Promise<string> {
  const ext = filename.toLowerCase().split(".").pop();

  if (ext === "txt" || contentType === "text/plain") {
    const text = new TextDecoder().decode(bytes);
    return text
      .split(/\r?\n\r?\n/)
      .map((para) => `<p>${escapeHtml(para).replace(/\r?\n/g, "<br>")}</p>`)
      .join("\n");
  }

  if (
    ext === "docx" ||
    contentType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    const mammoth = await import("mammoth");
    const result = await mammoth.convertToHtml({ arrayBuffer: bytes });
    return sanitizeConvertedHtml(result.value);
  }

  if (ext === "pdf" || contentType === "application/pdf") {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const { text } = await extractText(pdf, { mergePages: true });
    return text
      .split(/\n{2,}/)
      .map((para) => `<p>${escapeHtml(para).replace(/\n/g, "<br>")}</p>`)
      .join("\n");
  }

  if (ext === "doc") {
    throw new Error(
      "Gamla .doc-formatet (innan Word 2007) kan inte konverteras till brevtext automatiskt — spara om filen som .docx, eller bifoga den som bilaga istället.",
    );
  }

  throw new Error(`Filtypen .${ext} kan inte konverteras till brevtext.`);
}
