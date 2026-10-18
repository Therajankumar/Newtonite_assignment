// Keyset ("cursor") pagination helpers. Offsets get slower and produce duplicates or gaps
// when items change between page loads; a keyset cursor encodes the sort values of the
// last row we returned and asks for rows strictly after it.

export function encodeCursor(doc, sort) {
  const values = sort.map(([field]) => {
    const v = field.split('.').reduce((o, k) => (o == null ? o : o[k]), doc);
    return v instanceof Date ? { $date: v.toISOString() } : v;
  });
  return Buffer.from(JSON.stringify(values)).toString('base64url');
}

export function decodeCursor(cursor, sort) {
  try {
    const raw = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!Array.isArray(raw) || raw.length !== sort.length) return null;
    return raw.map((v) => (v && typeof v === 'object' && '$date' in v ? new Date(v.$date) : v));
  } catch {
    return null;
  }
}

/**
 * Build a filter selecting documents that sort strictly after `values` under `sort`.
 * For sort [[a,-1],[b,-1],[_id,-1]] this produces:
 *   { $or: [ {a < va}, {a = va, b < vb}, {a = va, b = vb, _id < vid} ] }
 */
export function afterCursorFilter(values, sort, castId) {
  const clauses = [];
  for (let i = 0; i < sort.length; i++) {
    const clause = {};
    for (let j = 0; j < i; j++) clause[sort[j][0]] = cast(sort[j][0], values[j], castId);
    const [field, dir] = sort[i];
    clause[field] = { [dir === 1 ? '$gt' : '$lt']: cast(field, values[i], castId) };
    clauses.push(clause);
  }
  return { $or: clauses };
}

function cast(field, value, castId) {
  return field === '_id' ? castId(value) : value;
}
