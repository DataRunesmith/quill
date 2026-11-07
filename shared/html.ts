// Escapar text som ska in i en HTML-kropp (mejl eller DOM på serversidan).
// Escapar alla tre tecknen &, <, > — att bara escapa "<" lämnar entiteter
// och vinkelparenteser orörda (ofullständig sanering som CodeQL flaggar).
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Plockar ut ren text ur en (av oss själv genererad) HTML-sträng, för mejlens
// text/plain-del. Gör en enda linjär genomgång i stället för regex +
// loop-tills-stabil; den senare kombinationen kan ge polynomial ReDoS på
// angriparkontrollerad text (CodeQL js/polynomial-redos).
//
// Semantik: ett komplett <...>-segment tas bort. Om strängen slutar med ett
// oavslutat '<' bevaras den återstående texten, precis som regexen gjorde.
export function htmlToText(html: string): string {
  const out: string[] = [];
  let tagStart = -1;

  for (let i = 0; i < html.length; i++) {
    const ch = html[i];
    if (tagStart < 0) {
      if (ch === "<") tagStart = i;
      else out.push(ch);
    } else if (ch === ">") {
      tagStart = -1;
    }
  }

  if (tagStart >= 0) out.push(html.slice(tagStart));
  return out.join("");
}
