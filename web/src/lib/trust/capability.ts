/**
 * The capability matrix (S6 4.11 Isolation, FE-TRUST-3): which database role may do what, rendered from the same
 * fixture the database tests check (`supabase/tests/fixtures/capability_matrix.csv`), bundled at build. Every row
 * of the file is a row of the table.
 */

export interface Capability {
  readonly role: string;
  readonly objectType: string;
  readonly object: string;
  readonly privilege: string;
  readonly expect: string;
}

/** One CSV line's fields, honouring double-quoted fields with commas and doubled quotes. */
export function csvFields(line: string): string[] {
  const out: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line.charAt(i);
    if (quoted) {
      if (ch === '"' && line.charAt(i + 1) === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(field);
      field = "";
    } else field += ch;
  }
  out.push(field);
  return out;
}

/** The matrix rows of the CSV text (header skipped, blank lines ignored); a malformed line throws. */
export function parseCapabilities(csv: string): readonly Capability[] {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim() !== "");
  return lines.slice(1).map((line) => {
    const f = csvFields(line);
    if (f.length !== 5) throw new Error(`capability matrix: expected 5 fields, got ${String(f.length)}: ${line}`);
    const [role, objectType, object, privilege, expect] = f as [string, string, string, string, string];
    return { role, objectType, object, privilege, expect };
  });
}
