// ABOUTME: Versioned compact URL share codec — encodes typed config to short
// ABOUTME: URL-safe strings. See plans/2026-05-07_share_link_codec_SPEC.md.

export class SchemaError extends Error {}

export function encode(state, schema) {
  if (schema.encoding === 'positional') return encodePositional(state, schema);
  if (schema.encoding === 'tagged')     return encodeTagged(state, schema);
  throw new SchemaError(`Unknown encoding: ${schema.encoding}`);
}

export function decode(payload, schema) {
  try {
    if (typeof payload !== 'string') return null;
    const trimmed = payload.trim();
    const prefix = `v${schema.version}.`;
    if (!trimmed.startsWith(prefix)) return null;
    const body = trimmed.slice(prefix.length);
    if (schema.encoding === 'positional') return decodePositional(body, schema);
    if (schema.encoding === 'tagged')     return decodeTagged(body, schema);
    return null;
  } catch (e) {
    if (e instanceof SchemaError) throw e;
    return null;
  }
}

// --- Positional ---

function encodePositional(state, schema) {
  const tokens = schema.fields.map(f => encodeField(state[f.name], f));
  return `v${schema.version}.${tokens.join('')}`;
}

function decodePositional(body, schema) {
  return tryDecodePositional(body, schema.fields, 0, {});
}

// Backtracking decoder. Adjacent variable-length fields (ints) need to
// explore split positions; for fixed-length fields the only candidate is the
// greedy one so backtracking degenerates to linear walk.
function tryDecodePositional(src, fields, i, soFar) {
  if (fields.length === 0) {
    return i === src.length ? soFar : null;
  }
  const [f, ...rest] = fields;
  for (const [value, consumed] of candidates(f, src, i)) {
    const next = tryDecodePositional(src, rest, i + consumed, { ...soFar, [f.name]: value });
    if (next !== null) return next;
  }
  return null;
}

function* candidates(spec, src, i) {
  switch (spec.type) {
    case 'enum': {
      const c = src[i];
      if (c === undefined) return;
      const v = reverseTable(spec)[c];
      if (v !== undefined) yield [v, 1];
      return;
    }
    case 'bool': {
      const c = src[i];
      if (c === '0') yield [false, 1];
      else if (c === '1') yield [true, 1];
      return;
    }
    case 'int': {
      // Yield candidate (value, length) pairs longest-first so the encoded
      // form (shortest unique base-36 representation of the value) wins when
      // the field is unambiguous.
      let maxLen = 0;
      while (i + maxLen < src.length && BASE36_CHAR.test(src[i + maxLen])) maxLen++;
      for (let len = maxLen; len >= 1; len--) {
        const slice = src.slice(i, i + len);
        const n = parseInt(slice, 36);
        // parseInt is permissive — '7nx' parses as 7*36+23. Re-encode to
        // verify round-trip and reject leading-zero forms like '07'.
        if (!Number.isInteger(n) || n < spec.min || n > spec.max) continue;
        if (n.toString(36) !== slice) continue;
        yield [n, len];
      }
      return;
    }
    case 'hex6': {
      const s = src.slice(i, i + 6).toLowerCase();
      if (s.length === 6 && HEX6_CHAR.test(s)) yield [s, 6];
      return;
    }
    case 'opt': {
      if (src[i] === '~') { yield [null, 1]; return; }
      // Otherwise yield candidates from the inner spec — backtracking handles
      // the case where the inner spec's first byte happens to be '~' (it can't
      // be, since '~' isn't valid for any other primitive's first char).
      yield* candidates(spec.of, src, i);
      return;
    }
    case 'composite': {
      yield* composeParts(spec.parts, src, i, i, []);
      return;
    }
    case 'list': {
      // Format: <count-base36>(<sep><item>){count}
      // Separator '-' between items gives unambiguous splitting even when the
      // inner type is variable-length (e.g. base-36 ints).
      const lenChar = src[i];
      if (lenChar === undefined || !BASE36_CHAR.test(lenChar)) return;
      const count = parseInt(lenChar, 36);
      if (!Number.isInteger(count) || count < 0) return;
      const items = [];
      let j = i + 1;
      for (let k = 0; k < count; k++) {
        if (src[j] !== LIST_ITEM_SEP) return;
        j++;
        // Find the end of this item by scanning to next sep, or to end of
        // candidate region (a list ends when we run out of '-' separators).
        // We don't know item end without trying — so try inner candidates and
        // accept the one whose consumed length lands us at a valid next state.
        let matched = null;
        for (const [value, consumed] of candidates(spec.of, src, j)) {
          const after = j + consumed;
          // Item must end at either: a separator (more items to come) or
          // end-of-list region (last item of count).
          const last = (k === count - 1);
          if (last || src[after] === LIST_ITEM_SEP) {
            matched = [value, consumed];
            break;
          }
        }
        if (matched === null) return;
        items.push(matched[0]);
        j += matched[1];
      }
      yield [items, j - i];
      return;
    }
  }
}

const LIST_ITEM_SEP = '-';
const COMPOSITE_PART_SEP = ':';

function* composeParts(parts, src, start, j, accum) {
  if (accum.length === parts.length) {
    yield [accum, j - start];
    return;
  }
  const isLast = accum.length === parts.length - 1;
  const partSpec = parts[accum.length];
  for (const [value, consumed] of candidates(partSpec, src, j)) {
    const after = j + consumed;
    if (isLast) {
      yield* composeParts(parts, src, start, after, [...accum, value]);
    } else if (src[after] === COMPOSITE_PART_SEP) {
      yield* composeParts(parts, src, start, after + 1, [...accum, value]);
    }
  }
}

const BASE36_CHAR = /[0-9a-z]/i;
const HEX6_CHAR   = /^[0-9a-f]{6}$/;

// --- Field encode ---

function encodeField(value, spec) {
  switch (spec.type) {
    case 'enum': {
      const c = spec.values[value];
      if (c === undefined) throw new SchemaError(`Unknown enum value for ${spec.name}: ${value}`);
      return c;
    }
    case 'bool': return value ? '1' : '0';
    case 'int': {
      const n = Number(value);
      if (!Number.isInteger(n) || n < spec.min || n > spec.max) {
        throw new SchemaError(`Int out of range for ${spec.name}: ${value}`);
      }
      return n.toString(36);
    }
    case 'hex6': {
      const s = String(value).replace(/^#/, '').toLowerCase();
      if (!HEX6_CHAR.test(s)) throw new SchemaError(`Bad hex6 for ${spec.name}: ${value}`);
      return s;
    }
    case 'opt': {
      if (value === null || value === undefined) return '~';
      return encodeField(value, spec.of);
    }
    case 'list': {
      const arr = Array.isArray(value) ? value : [];
      if (arr.length > 35) {
        throw new SchemaError(`List too long for ${spec.name}: ${arr.length} (max 35 in v1)`);
      }
      return arr.length.toString(36)
        + arr.map(v => `${LIST_ITEM_SEP}${encodeField(v, spec.of)}`).join('');
    }
    case 'composite': {
      const arr = Array.isArray(value) ? value : [];
      if (arr.length !== spec.parts.length) {
        throw new SchemaError(`Composite ${spec.name} expects ${spec.parts.length} parts, got ${arr.length}`);
      }
      return spec.parts.map((p, i) => encodeField(arr[i], p)).join(COMPOSITE_PART_SEP);
    }
  }
  throw new SchemaError(`Unknown field type: ${spec.type}`);
}

// --- Multi-param (per-field) mode ---
//
// Returns a plain object { tag: encodedValue } so the caller can fold each
// field into a separate URL query parameter. Defaults are skipped exactly the
// same way as the tagged form.

export function encodeFields(state, schema) {
  const out = {};
  for (const f of schema.fields) {
    const v = state[f.name];
    if (isAtDefault(v, f)) continue;
    out[tagOf(f)] = encodeField(v, f);
  }
  return out;
}

// Inverse: takes a { tag: encodedValue } map and produces a state object.
// Unknown tag, malformed value, or non-object input → null.

export function decodeFields(map, schema) {
  try {
    if (map == null || typeof map !== 'object' || Array.isArray(map)) return null;
    const fieldsByTag = Object.fromEntries(schema.fields.map(f => [tagOf(f), f]));
    const out = {};
    for (const [tag, valStr] of Object.entries(map)) {
      const f = fieldsByTag[tag];
      if (!f) return null;
      if (typeof valStr !== 'string') return null;
      let found = false; let matched;
      for (const [value, consumed] of candidates(f, valStr, 0)) {
        if (consumed === valStr.length) { matched = value; found = true; break; }
      }
      if (!found) return null;
      out[f.name] = matched;
    }
    return out;
  } catch (e) {
    if (e instanceof SchemaError) throw e;
    return null;
  }
}

// --- Tagged ---

const TAG_FIELD_SEP = ',';
const TAG_KV_SEP = '=';

function encodeTagged(state, schema) {
  const parts = [];
  for (const f of schema.fields) {
    const v = state[f.name];
    if (isAtDefault(v, f)) continue;
    parts.push(`${tagOf(f)}${TAG_KV_SEP}${encodeField(v, f)}`);
  }
  return `v${schema.version}.${parts.join(TAG_FIELD_SEP)}`;
}

function decodeTagged(body, schema) {
  if (body === '') return {};
  const fieldsByTag = Object.fromEntries(schema.fields.map(f => [tagOf(f), f]));
  const out = {};
  for (const piece of body.split(TAG_FIELD_SEP)) {
    const eq = piece.indexOf(TAG_KV_SEP);
    if (eq < 1) return null;
    const tag = piece.slice(0, eq);
    const valStr = piece.slice(eq + 1);
    const f = fieldsByTag[tag];
    if (!f) return null;
    // Reuse the positional candidate machinery for the value.
    let found = false;
    let matched;
    for (const [value, consumed] of candidates(f, valStr, 0)) {
      if (consumed === valStr.length) { matched = value; found = true; break; }
    }
    if (!found) return null;
    out[f.name] = matched;
  }
  return out;
}

function tagOf(f) {
  return f.tag ?? f.name[0];
}

function isAtDefault(value, spec) {
  if (value === undefined) return true;
  switch (spec.type) {
    case 'opt':  return value === null;
    case 'list': return Array.isArray(value) && value.length === 0;
    default:     return spec.default !== undefined && value === spec.default;
  }
}

// --- Internal ---

const reverseTableCache = new WeakMap();

function reverseTable(spec) {
  let r = reverseTableCache.get(spec);
  if (!r) {
    r = Object.fromEntries(Object.entries(spec.values).map(([v, c]) => [c, v]));
    reverseTableCache.set(spec, r);
  }
  return r;
}
