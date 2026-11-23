// A fast single-pass reader for broken CSV, written as a drop-in for
// csv-reader 1.0.0: run(input) answers {columns, rows, errors} for an input
// {text, header}, with exactly the reference reader's answers, in less CPU
// time. The reference walks the text one character at a time and grows every
// field one character at a time; this reader instead scans for the next
// character that can change the reading (a comma, a quote, a line break) and
// lifts each clean run of field text out of the input with one slice, so the
// common field costs one scan and one substring instead of one concatenation
// per character. The broken-row policy is the reference's own:
//
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no
//     record at all;
//   - outside quotes a CR not followed by LF is dropped (stray_cr);
//   - a field that opens with a quote runs to the next quote that is not
//     doubled ("" inside it is one quote, and each CRLF or lone CR inside it
//     is read as one LF); whatever follows the closing quote, up to the next
//     comma or line break, is appended as it stands (quote_junk, raised when
//     the field ends); a quote that never closes is a literal character and
//     the text after it is read again as unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay
//     strings, never trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds
//     the records after it (every record when header is false), each padded
//     with "" (short_row, with fields: its count) or cut (long_row, with
//     extra: the cut fields) to the first record's width;
//   - each error is {code, line, row} in the order met: line the 1-based line
//     the record starts on, counting every LF, CRLF and lone CR inside
//     quotes; row the record's index in rows, null for the header.
//
// Pure: nothing is kept from one call to the next.

// How the field just read ended.
const AT_COMMA = 0; // a comma: the record goes on
const AT_BREAK = 1; // a line break: the record ends
const AT_END = 2; // the end of the text: the record ends

/**
 * csv-reader 1.0.0's answer for one case's input {text, header}, computed
 * faster: {columns, rows, errors}.
 */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;

  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on, and the index in rows it
  // takes (null while it could still be the header).
  let recordLine = 1;
  let recordRow = null;

  // The field read most recently: its value, how it ended, and how many
  // characters the last unquoted stretch kept (quote_junk needs the count).
  let fValue = '';
  let fEnded = AT_END;
  let fAdded = 0;

  function fail(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Reads unquoted text onto `initial`, up to the next comma or line break,
  // and leaves the outcome in fValue / fEnded / fAdded. A CR not followed by
  // LF is dropped where it stands (stray_cr) and the reading goes on, so a
  // field with stray CRs in it is assembled from the clean runs between them.
  function readUnquoted(initial) {
    let value = initial;
    let added = 0;
    let runStart = pos;
    let i = pos;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 44) {
        // ','
        if (i > runStart) {
          value += text.slice(runStart, i);
          added += i - runStart;
        }
        pos = i + 1;
        fValue = value;
        fAdded = added;
        fEnded = AT_COMMA;
        return;
      }
      if (c === 10) {
        // LF: the record ends.
        if (i > runStart) {
          value += text.slice(runStart, i);
          added += i - runStart;
        }
        pos = i + 1;
        line += 1;
        fValue = value;
        fAdded = added;
        fEnded = AT_BREAK;
        return;
      }
      if (c === 13) {
        // CR: a line break when LF follows, a stray otherwise.
        if (i + 1 < n && text.charCodeAt(i + 1) === 10) {
          if (i > runStart) {
            value += text.slice(runStart, i);
            added += i - runStart;
          }
          pos = i + 2;
          line += 1;
          fValue = value;
          fAdded = added;
          fEnded = AT_BREAK;
          return;
        }
        if (i > runStart) {
          value += text.slice(runStart, i);
          added += i - runStart;
        }
        fail('stray_cr');
        i += 1;
        runStart = i;
        continue;
      }
      i += 1;
    }
    if (n > runStart) {
      value += text.slice(runStart, n);
      added += n - runStart;
    }
    pos = n;
    fValue = value;
    fAdded = added;
    fEnded = AT_END;
  }

  // Reads a quoted field whose opening quote is at pos. Inside the quotes
  // only three characters change the reading: a quote (a doubled one is one
  // literal quote, a lone one closes the field), a CR (read as one LF), and
  // an LF (kept as it stands, but it still starts a new line for error
  // positions). Everything between two such characters is lifted out whole.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let value = '';
    let i = pos + 1;
    let runStart = i;
    let closed = false;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 34) {
        // '"'
        if (i + 1 < n && text.charCodeAt(i + 1) === 34) {
          value += text.slice(runStart, i) + '"';
          i += 2;
          runStart = i;
          continue;
        }
        value += text.slice(runStart, i);
        i += 1;
        closed = true;
        break;
      }
      if (c === 13) {
        // CRLF and a lone CR inside quotes are each read as one LF.
        value += text.slice(runStart, i) + '\n';
        line += 1;
        i += i + 1 < n && text.charCodeAt(i + 1) === 10 ? 2 : 1;
        runStart = i;
        continue;
      }
      if (c === 10) line += 1;
      i += 1;
    }
    if (!closed) {
      // The quote never closes: it is a literal character, the line count
      // starts over from the opening quote, and the rest of the field is
      // read again as unquoted text.
      pos = open + 1;
      line = openLine;
      fail('unterminated_quote');
      readUnquoted('"');
      return;
    }
    pos = i;
    if (pos >= n) {
      fValue = value;
      fEnded = AT_END;
      return;
    }
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      fValue = value;
      fEnded = AT_COMMA;
      return;
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      fValue = value;
      fEnded = AT_BREAK;
      return;
    }
    if (c === 13 && pos + 1 < n && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      fValue = value;
      fEnded = AT_BREAK;
      return;
    }
    // Anything else after the closing quote is junk: it is appended as it
    // stands, read as unquoted text, and reported when it kept anything.
    readUnquoted(value);
    if (fAdded > 0) fail('quote_junk');
  }

  // The records, one after another, until the text runs out.
  while (true) {
    // Lines left with no characters are no records: skip bare line breaks.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && pos + 1 < n && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    const fields = [];
    let lastQuoted = false;
    do {
      if (pos < n && text.charCodeAt(pos) === 34) {
        lastQuoted = true;
        readQuoted();
      } else {
        lastQuoted = false;
        readUnquoted('');
      }
      fields.push(fValue);
    } while (fEnded === AT_COMMA);

    // A line that held nothing but stray CRs is left with no characters:
    // no record (the stray_cr errors it raised stay raised).
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  return { columns: header ? columns ?? [] : null, rows, errors };
}
