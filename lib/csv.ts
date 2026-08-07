// A small, dependency-free reader for supplier stock files.
//
// Suppliers export these from whatever their warehouse system happens to be, so
// the reader has to cope with the usual mess without being told: a byte-order
// mark on the front, Windows line endings, quoted fields containing the
// delimiter, doubled quotes inside a quoted field, and a delimiter that might
// be a comma, a semicolon or a tab depending on which side of the Channel the
// system was configured on.
//
// Nothing here throws on a malformed row. A stock file is not a contract we can
// enforce, and refusing the whole file because row 40,000 has a stray quote
// would mean the shop silently stops updating. Rows we cannot read are counted
// and reported instead.

const DELIMITERS = [',', ';', '\t', '|'] as const

/** Strips a UTF-8 byte-order mark, which otherwise hides inside the first header name. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/**
 * Guesses the delimiter from the header line: whichever candidate splits it into
 * the most fields wins, comma breaking any tie. A single-column file has no
 * delimiter to find, so it falls through to a comma and reads as one column,
 * which is the honest answer.
 */
export function detectDelimiter(headerLine: string): string {
  let best = ','
  let bestCount = 0
  for (const candidate of DELIMITERS) {
    const count = splitLine(headerLine, candidate).length
    if (count > bestCount) {
      best = candidate
      bestCount = count
    }
  }
  return best
}

/**
 * Splits one already-complete line into fields, honouring quotes. Callers that
 * may face embedded newlines inside quoted fields should use parseCsv instead.
 */
export function splitLine(line: string, delimiter: string): string[] {
  const out: string[] = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === delimiter) {
      out.push(field)
      field = ''
    } else {
      field += ch
    }
  }
  out.push(field)
  return out
}

/**
 * Walks a CSV body a row at a time, coping with newlines inside quoted fields.
 * Blank lines are skipped: a trailing newline is the norm, not a row.
 *
 * A generator rather than an array, because the supplier file this was written
 * for is fifty thousand rows and six megabytes. The import only ever needs one
 * row at a time, and holding all of them at once buys nothing but memory.
 */
export function* iterateCsvRows(text: string, delimiter?: string): Generator<string[]> {
  const body = stripBom(text)
  const delim = delimiter ?? detectDelimiter(firstLine(body))
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let touched = false

  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (inQuotes) {
      if (ch === '"') {
        if (body[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
      continue
    }
    if (ch === '"') {
      inQuotes = true
      touched = true
    } else if (ch === delim) {
      row.push(field)
      field = ''
      touched = true
    } else if (ch === '\r' || ch === '\n') {
      // On CRLF the \r is swallowed and the \n ends the row; a lone \r ends it.
      if (ch === '\r' && body[i + 1] === '\n') continue
      if (touched || row.length > 0) {
        row.push(field)
        // A line that is entirely empty is padding, not a record.
        if (!(row.length === 1 && row[0] === '')) yield row
      }
      row = []
      field = ''
      touched = false
    } else {
      field += ch
      touched = true
    }
  }
  if (touched || row.length > 0) {
    row.push(field)
    if (!(row.length === 1 && row[0] === '')) yield row
  }
}

/**
 * Full parse of a CSV body into rows. Convenience wrapper over iterateCsvRows
 * for the small files the Test button probes; the import itself iterates.
 */
export function parseCsv(text: string, delimiter?: string): string[][] {
  return [...iterateCsvRows(text, delimiter)]
}

/** The text up to the first line break, for delimiter detection on a big file. */
export function firstLine(text: string): string {
  const nl = text.indexOf('\n')
  const line = nl === -1 ? text : text.slice(0, nl)
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

/**
 * Finds a named column in a header row. Matched case-insensitively and with
 * spaces, underscores and hyphens ignored, so "Free Stock", "free_stock" and
 * "FreeStock" are all the same column. Returns -1 when it is not there.
 */
export function findColumn(header: string[], name: string): number {
  const want = normaliseHeader(name)
  if (!want) return -1
  for (let i = 0; i < header.length; i++) {
    if (normaliseHeader(header[i] ?? '') === want) return i
  }
  return -1
}

export function normaliseHeader(value: string): string {
  return value.replace(/[\s_-]+/g, '').trim().toLowerCase()
}

/**
 * Reads a stock cell as a whole number of units.
 *
 * Suppliers write these several ways: "360", "360.00", "1,250", "(5)" for a
 * negative, or an empty cell for none. Anything that is not a number at all
 * returns null so the caller can count it rather than guess - writing a guessed
 * stock count is how a shop ends up refusing orders it could have taken.
 *
 * Negative free stock (more allocated than held) is floored at zero, because
 * the shop's stock count is "how many can be sold", and minus four cannot be.
 */
export function parseStockValue(raw: string): number | null {
  let text = raw.trim()
  if (!text) return null
  let negative = false
  if (text.startsWith('(') && text.endsWith(')')) {
    negative = true
    text = text.slice(1, -1).trim()
  }
  if (text.startsWith('-')) {
    negative = true
    text = text.slice(1).trim()
  }
  if (text.startsWith('+')) text = text.slice(1).trim()
  // Thousands separators, and a stray currency-style space.
  text = text.replace(/[,\s]/g, '')
  if (!/^\d+(\.\d+)?$/.test(text)) return null
  const value = Number(text)
  if (!Number.isFinite(value)) return null
  const whole = Math.floor(value)
  if (negative) return 0
  return whole
}

/** Normalises a SKU for matching: trimmed and upper-cased, nothing else. */
export function normaliseSku(value: string): string {
  return value.trim().toUpperCase()
}
