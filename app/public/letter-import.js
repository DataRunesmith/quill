(function installLetterImport(global) {
  const COMMON_MOJIBAKE = /(?:Ã¥|Ã¤|Ã¶|Ã…|Ã„|Ã–|Ã©|Ã¨|Ã¼|Ã±|â€“|â€”|â€™|â€œ|â€|â€¦|Â |ï¿½)/;
  const SAFE_TAGS = new Set([
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
    "div",
    "span",
    "a",
  ]);
  const DROP_TAGS = new Set([
    "script",
    "style",
    "iframe",
    "object",
    "embed",
    "svg",
    "math",
    "form",
    "input",
    "button",
    "textarea",
    "select",
    "option",
    "link",
    "meta",
    "base",
  ]);
  const DROP_VOID_TAGS = new Set(["embed", "input", "link", "meta", "base"]);
  const VOID_TAGS = new Set(["br"]);
  const BLOCK_TAGS = new Set(["p", "div", "li", "blockquote", "h1", "h2", "h3"]);

  function normalizeCharset(value) {
    const charset = String(value || "")
      .trim()
      .toLowerCase()
      .replace(/["']/g, "");
    if (!charset) return null;
    if (charset === "utf8") return "utf-8";
    if (["latin1", "latin-1", "iso-8859-1", "iso8859-1", "cp1252", "x-cp1252"].includes(charset))
      return "windows-1252";
    return charset;
  }

  function sniffHtmlCharset(bytes) {
    const sample = new TextDecoder("windows-1252").decode(
      bytes.subarray(0, Math.min(bytes.length, 4096)),
    );
    const direct = sample.match(/<meta\b[^>]*\bcharset\s*=\s*["']?\s*([^\s"'/>;]+)/i);
    if (direct) return normalizeCharset(direct[1]);
    const content = sample.match(
      /<meta\b[^>]*\bcontent\s*=\s*["'][^"']*charset\s*=\s*([^\s"';>]+)/i,
    );
    return normalizeCharset(content?.[1]);
  }

  function validateText(text) {
    if (text.includes("\uFFFD"))
      throw new Error(
        "Texten innehåller trasiga ersättningstecken (�). Rätta texten innan du fortsätter.",
      );
    if (/[\u0000\u0001-\u0008\u000B\u000C\u000E-\u001F]/.test(text))
      throw new Error("Texten innehåller ogiltiga kontrolltecken och kan inte användas säkert.");
    if (COMMON_MOJIBAKE.test(text))
      throw new Error(
        "Texten ser felkodad ut (t.ex. Ã¥/â€“). Rätta texten eller importera dokumentet på nytt.",
      );
    return text;
  }

  function decodeTextBytes(input, { html = false } = {}) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const candidates = [];
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
      candidates.push("utf-8");
    else if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe)
      candidates.push("utf-16le");
    else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff)
      candidates.push("utf-16be");
    if (html) {
      const declared = sniffHtmlCharset(bytes);
      if (declared) candidates.push(declared);
    }
    candidates.push("utf-8", "windows-1252");
    for (const encoding of [...new Set(candidates)]) {
      let text;
      try {
        text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
      } catch {
        continue;
      }
      validateText(text);
      return { text, encoding };
    }
    throw new Error("Alla tecken i dokumentet kunde inte avkodas korrekt. Importen stoppades.");
  }

  async function readFileText(file, { html = false } = {}) {
    return decodeTextBytes(new Uint8Array(await file.arrayBuffer()), { html }).text;
  }

  function escapeHtmlText(value) {
    return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function escapeHtmlAttribute(value) {
    return escapeHtmlText(value).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function decodeHtmlEntities(value) {
    const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };
    return String(value).replace(
      /&(#(?:x[0-9a-f]+|\d+)|amp|lt|gt|quot|apos|nbsp);/gi,
      (match, entity) => {
        const key = String(entity).toLowerCase();
        if (key[0] !== "#") return named[key] ?? match;
        const hex = key[1] === "x";
        const digits = hex ? key.slice(2) : key.slice(1);
        const code = Number.parseInt(digits, hex ? 16 : 10);
        if (
          !Number.isFinite(code) ||
          code <= 0 ||
          code > 0x10ffff ||
          (code >= 0xd800 && code <= 0xdfff)
        )
          return match;
        return String.fromCodePoint(code);
      },
    );
  }

  function textToHtml(text) {
    validateText(text);
    const normalized = String(text).replace(/\r\n?/g, "\n").trim();
    if (!normalized) return "";
    return normalized
      .split(/\n{2,}/)
      .map((para) => `<p>${escapeHtmlText(para).replace(/\n/g, "<br>")}</p>`)
      .join("\n");
  }

  function safeHref(value) {
    const href = String(value || "").trim();
    return /^(?:https?:|mailto:)/i.test(href) ? href : null;
  }

  function findTagEnd(html, start) {
    let quote = null;
    for (let i = start + 1; i < html.length; i++) {
      const ch = html[i];
      if (quote) {
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }
      if (ch === ">") return i;
    }
    return -1;
  }

  function parseTagToken(token) {
    const match = token.match(/^<\s*(\/?)\s*([A-Za-z][A-Za-z0-9:-]*)(?=[\s/>])([\s\S]*?)>$/);
    if (!match) return null;
    const tag = match[2].toLowerCase();
    return {
      tag,
      closing: Boolean(match[1]),
      attributes: match[3] || "",
      selfClosing: /\/\s*>$/.test(token) || VOID_TAGS.has(tag),
    };
  }

  function attributeValue(attributes, name) {
    const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = String(attributes).match(
      new RegExp(
        `(?:^|\\s)${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>` + "`" + `]+))`,
        "i",
      ),
    );
    if (!match) return null;
    return decodeHtmlEntities(match[1] ?? match[2] ?? match[3] ?? "");
  }

  function hrefFromAttributes(attributes) {
    const href = attributeValue(attributes, "href");
    return href == null ? null : safeHref(href);
  }

  function inlineStyleFormats(attributes, ownTag) {
    const style = String(attributeValue(attributes, "style") || "").toLowerCase();
    const formats = [];
    if (
      /(?:^|;)\s*font-weight\s*:\s*(?:bold|[6-9]00)\b/.test(style) &&
      ownTag !== "strong" &&
      ownTag !== "b"
    )
      formats.push("strong");
    if (
      /(?:^|;)\s*font-style\s*:\s*(?:italic|oblique)\b/.test(style) &&
      ownTag !== "em" &&
      ownTag !== "i"
    )
      formats.push("em");
    if (/(?:^|;)\s*text-decoration(?:-line)?\s*:[^;]*\bunderline\b/.test(style) && ownTag !== "u")
      formats.push("u");
    return formats;
  }

  function transformHtml(html, mode) {
    if (typeof html !== "string") throw new Error("HTML-innehållet måste vara en textsträng.");
    let output = "";
    const openFrames = [];
    const dropTags = [];

    function appendText(value) {
      if (!value || dropTags.length) return;
      const decoded = decodeHtmlEntities(value);
      output += mode === "html" ? escapeHtmlText(decoded) : decoded;
    }

    function appendBreak() {
      if (mode === "text") output += "\n";
    }

    function closeFrame(frame) {
      if (mode === "html") {
        for (let i = frame.outputTags.length - 1; i >= 0; i--)
          output += `</${frame.outputTags[i]}>`;
      } else if (frame.block) appendBreak();
    }

    function closeSourceTag(tag) {
      const index = openFrames.map((frame) => frame.sourceTag).lastIndexOf(tag);
      if (index < 0) return;
      while (openFrames.length > index) closeFrame(openFrames.pop());
    }

    function closeDropTag(tag) {
      const index = dropTags.lastIndexOf(tag);
      if (index >= 0) dropTags.length = index;
    }

    let index = 0;
    while (index < html.length) {
      const start = html.indexOf("<", index);
      if (start < 0) {
        appendText(html.slice(index));
        break;
      }
      appendText(html.slice(index, start));

      if (html.startsWith("<!--", start)) {
        const end = html.indexOf("-->", start + 4);
        index = end < 0 ? html.length : end + 3;
        continue;
      }
      if (/^<!doctype\b/i.test(html.slice(start, start + 10))) {
        const end = findTagEnd(html, start);
        index = end < 0 ? html.length : end + 1;
        continue;
      }
      if (html.startsWith("<![CDATA[", start)) {
        const end = html.indexOf("]]>", start + 9);
        index = end < 0 ? html.length : end + 3;
        continue;
      }

      const end = findTagEnd(html, start);
      if (end < 0) {
        appendText(html.slice(start));
        break;
      }
      const rawToken = html.slice(start, end + 1);
      const token = parseTagToken(rawToken);
      index = end + 1;
      if (!token) {
        appendText(rawToken);
        continue;
      }

      const { tag, closing, attributes, selfClosing } = token;
      if (DROP_TAGS.has(tag)) {
        if (closing) {
          closeDropTag(tag);
          continue;
        }
        if (!selfClosing && !DROP_VOID_TAGS.has(tag)) dropTags.push(tag);
        continue;
      }
      if (dropTags.length) continue;
      if (closing) {
        closeSourceTag(tag);
        continue;
      }
      if (tag === "br") {
        if (mode === "html") output += "<br>";
        else appendBreak();
        continue;
      }

      const safe = SAFE_TAGS.has(tag);
      const formats = inlineStyleFormats(attributes, tag);
      const outputTags = [];
      if (mode === "html" && safe) {
        const href = tag === "a" ? hrefFromAttributes(attributes) : null;
        const attrs = href ? ` href="${escapeHtmlAttribute(href)}" rel="noopener noreferrer"` : "";
        output += `<${tag}${attrs}>`;
        outputTags.push(tag);
      }
      if (mode === "html") {
        for (let i = formats.length - 1; i >= 0; i--) {
          const format = formats[i];
          output += `<${format}>`;
          outputTags.push(format);
        }
      }

      const frame = { sourceTag: tag, outputTags, block: safe && BLOCK_TAGS.has(tag) };
      if (selfClosing) closeFrame(frame);
      else openFrames.push(frame);
    }

    while (openFrames.length) closeFrame(openFrames.pop());
    return output;
  }

  function sanitizeHtml(html, { validate = true } = {}) {
    if (html == null) return "";
    const sanitized = transformHtml(html, "html");
    if (validate) validateText(htmlToText(sanitized, { validate: false }));
    return sanitized;
  }

  function htmlToText(html, { validate = true } = {}) {
    if (html == null) return "";
    const text = transformHtml(html, "text")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (validate) validateText(text);
    return text;
  }

  function storedToEditorText(value) {
    const text = String(value || "");
    if (!text) return "";
    if (/<\/?(?:p|br|div|strong|em|b|i|u|ul|ol|li|blockquote|h[1-3]|span|a)\b/i.test(text))
      return htmlToText(text, { validate: false });
    return text.replace(/\r\n?/g, "\n");
  }

  global.QuillLetterImport = {
    decodeTextBytes,
    readFileText,
    validateText,
    textToHtml,
    sanitizeHtml,
    htmlToText,
    storedToEditorText,
    sniffHtmlCharset,
  };
})(globalThis);
