// Small RFC 4180 CSV parser: quoted fields, escaped quotes, newlines inside
// quotes, CRLF, a UTF-8 BOM, and auto-detected delimiter (, ; or tab, as
// spreadsheet apps in different locales export).

export const detectDelimiter = (text: string): string => {
  const nl = text.indexOf('\n');
  const firstLine = nl < 0 ? text : text.slice(0, nl);
  let best = ',';
  let bestCount = -1;
  for (const d of [',', ';', '\t']) {
    // Count delimiters outside quotes.
    let n = 0;
    let q = false;
    for (const ch of firstLine) {
      if (ch === '"') q = !q;
      else if (ch === d && !q) n++;
    }
    if (n > bestCount) {
      best = d;
      bestCount = n;
    }
  }
  return best;
};

export const parseCsv = (input: string, delimiter = detectDelimiter(input)): string[][] => {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.length > 1 || row[0] !== '') rows.push(row);
  return rows;
};
