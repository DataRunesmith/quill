import assert from "node:assert/strict";

// Source-reading tests check design decisions (colours, focus rings, metadata,
// security-relevant call order), not formatting. These helpers compare source in
// a canonical form so the assertions survive reformatting.

// CSS: no spaces around punctuation, and leading zeros dropped (0.14 -> .14).
export function compactCss(css: string): string {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*([{}:;,>])\s*/g, "$1")
    .replace(/(^|[^\d.])0\.(\d)/g, "$1.$2");
}

// JS/TS/HTML: no whitespace, double quotes, no self-closing slash, no trailing
// commas and no parentheses around a single arrow-function parameter. Both the
// source and the pattern are put in this form, so `a === 'x'` matches /a==="x"/.
function canonical(text: string): string {
  return text
    .replace(/\s+/g, "")
    .replace(/'/g, '"')
    .replace(/\/>/g, ">")
    .replace(/,([)\]}])/g, "$1")
    .replace(/\((\w+)\)=>/g, "$1=>");
}

function canonicalPattern(pattern: RegExp): RegExp {
  const source = pattern.source
    .replace(/(?<!\\)\\r\??/g, "")
    .replace(/(?<!\\)\\n[*+?]?/g, "")
    .replace(/(?<!\\)\\s[*+?]?/g, "")
    .replace(/ /g, "")
    .replace(/'/g, '"')
    .replace(/\\\/>/g, ">")
    .replace(/,(\\[)\]}])/g, "$1")
    .replace(/\\\((\w+)\\\)=>/g, "$1=>");
  return new RegExp(source, pattern.flags);
}

export function assertSourceMatch(text: string, pattern: RegExp, message?: string): void {
  assert.match(canonical(text), canonicalPattern(pattern), message);
}

export function assertSourceIncludes(text: string, snippet: string, message?: string): void {
  assert.ok(canonical(text).includes(canonical(snippet)), message ?? `missing: ${snippet}`);
}

export function assertSourceNoMatch(text: string, pattern: RegExp, message?: string): void {
  assert.doesNotMatch(canonical(text), canonicalPattern(pattern), message);
}
