// Kanonisk normalisering av skrapade befattningstexter.
// Endast roller som är användbara när man väljer politiska mottagare får en
// egen kategori. Övriga uppdrag slås ihop till "Övrigt" och exponeras inte i
// mottagar-UI:t.

export interface CanonicalRole {
  key: string;
  label: string;
}

const VICE_ONLY = /^\d+\s*[:.]?\s*[ae]?\s*vice$/;

const CATEGORIES: { match: (s: string) => boolean; label: string }[] = [
  { match: (s) => s.includes("ordf") || VICE_ONLY.test(s), label: "Ordförande" },
  { match: (s) => s.includes("gruppledare"), label: "Gruppledare" },
  {
    match: (s) => s.includes("ledamot") || s.includes("ledamöter") || s === "led",
    label: "Ledamot",
  },
  { match: (s) => s.includes("ersätt") || s.includes("supple") || s === "ers", label: "Ersättare" },
];

export function canonicalRole(raw: string): CanonicalRole {
  const s = raw.trim().toLowerCase();
  for (const c of CATEGORIES) {
    if (c.match(s)) return { key: c.label.toLowerCase(), label: c.label };
  }
  return { key: "övrigt", label: "Övrigt" };
}
