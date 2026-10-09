/**
 * The browser port of S2's one quote predicate (S2 1 and 4.4.1, D6; S6 4.5): `normalize`, `quoteOk` and S1's
 * `contentText`, tested against the same fixture file as the Python module
 * (`contracts/fixtures/citations.json`), so the two can never disagree on a case.
 *
 * Normalization: Unicode NFKC; curly quotes and apostrophes to straight ones; every dash U+2010 to U+2015
 * and U+2212 to `-`; whitespace runs to one space; trimmed; case kept. "Whitespace" is Python's `str.isspace`
 * set, spelled out, because JavaScript's `\s` differs from it (it lacks U+001C-U+001F and U+0085 and adds
 * U+FEFF). A quote matches when its normalized form is a substring of the normalized text and has at least
 * 3 words, or equals the whole normalized text when that text is shorter. For matching only.
 */

/** Python's `\s` for `str` patterns (the characters for which `str.isspace()` is true). */
const PY_SPACE = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const SPACE_RUN = new RegExp(`[${PY_SPACE}]+`, "gu");
const EDGES = new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, "gu");

const FOLD: Readonly<Record<string, string>> = {
  "\u2018": "'",
  "\u2019": "'",
  "\u201a": "'",
  "\u201b": "'",
  "\u201c": '"',
  "\u201d": '"',
  "\u201e": '"',
  "\u201f": '"',
  "\u2010": "-",
  "\u2011": "-",
  "\u2012": "-",
  "\u2013": "-",
  "\u2014": "-",
  "\u2015": "-",
  "\u2212": "-",
};
const FOLDED = /[\u2018-\u201f\u2010-\u2015\u2212]/gu;

export function normalize(text: string): string {
  const folded = text.normalize("NFKC").replace(FOLDED, (c) => FOLD[c] ?? c);
  return folded.replace(SPACE_RUN, " ").replace(EDGES, "");
}

export function quoteOk(quote: string, text: string): boolean {
  const q = normalize(quote);
  const t = normalize(text);
  return q.length > 0 && t.includes(q) && (q.split(" ").length >= 3 || q === t);
}

/** S1's Content object (body plus optional table). */
export interface RecordContent {
  readonly body: string;
  readonly table?: { readonly columns: readonly string[]; readonly rows: readonly (readonly string[])[] } | null;
}

/** S1 6.1 `content_text`: the body, then the column line and one line per row, cells joined by " | ". */
export function contentText(content: RecordContent): string {
  const lines = [content.body];
  if (content.table) {
    lines.push(content.table.columns.join(" | "));
    for (const row of content.table.rows) lines.push(row.join(" | "));
  }
  return lines.join("\n");
}
