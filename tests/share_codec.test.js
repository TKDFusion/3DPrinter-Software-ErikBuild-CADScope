// ABOUTME: Unit tests for the versioned compact URL share codec.
// ABOUTME: Run with: node --test tests/share_codec.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { encode, decode } from '../assets/share_codec.js';

const SINGLE_ENUM_SCHEMA = {
  version: 1,
  encoding: 'positional',
  fields: [
    { type: 'enum', name: 'material', values: { printed: 'p', sheet_metal: 's' } },
  ],
};

const POSITIONAL_SCHEMA = {
  version: 1,
  encoding: 'positional',
  fields: [
    { type: 'enum', name: 'material', values: { printed: 'p', sheet_metal: 's' } },
    { type: 'enum', name: 'gantry',   values: { flying:  'v', fixed:       'f' } },
    { type: 'enum', name: 'drive',    values: { awd:     'a', '2wd':       '2' } },
    { type: 'bool', name: 'sensorless' },
    { type: 'int',  name: 'shafts',   min: 0,   max: 4 },
    { type: 'int',  name: 'xRail',    min: 100, max: 1000 },
    { type: 'int',  name: 'yRail',    min: 100, max: 1000 },
  ],
};

test('positional: single enum round-trips', () => {
  const state = { material: 'printed' };
  const encoded = encode(state, SINGLE_ENUM_SCHEMA);
  assert.equal(encoded, 'v1.p');
  assert.deepEqual(decode(encoded, SINGLE_ENUM_SCHEMA), state);
});

test('positional: 8-field state from SPEC §7 round-trips', () => {
  const state = {
    material: 'printed', gantry: 'flying', drive: 'awd',
    sensorless: false, shafts: 0, xRail: 350, yRail: 350,
  };
  const encoded = encode(state, POSITIONAL_SCHEMA);
  assert.deepEqual(decode(encoded, POSITIONAL_SCHEMA), state);
});

test('positional: bool encodes as 0 or 1', () => {
  const schema = {
    version: 1,
    encoding: 'positional',
    fields: [{ type: 'bool', name: 'flag' }],
  };
  assert.equal(encode({ flag: true  }, schema), 'v1.1');
  assert.equal(encode({ flag: false }, schema), 'v1.0');
  assert.deepEqual(decode('v1.1', schema), { flag: true });
  assert.deepEqual(decode('v1.0', schema), { flag: false });
});

test('positional: int uses base-36, no padding', () => {
  const schema = {
    version: 1,
    encoding: 'positional',
    fields: [{ type: 'int', name: 'n', min: 0, max: 100000 }],
  };
  assert.equal(encode({ n: 350 }, schema),    'v1.9q');
  assert.equal(encode({ n: 0   }, schema),    'v1.0');
  assert.equal(encode({ n: 35  }, schema),    'v1.z');
  assert.deepEqual(decode('v1.9q', schema), { n: 350 });
  assert.deepEqual(decode('v1.0',  schema), { n: 0   });
});

test('positional: int out of range fails encode and rejects decode', () => {
  const schema = {
    version: 1,
    encoding: 'positional',
    fields: [{ type: 'int', name: 'n', min: 100, max: 1000 }],
  };
  assert.throws(() => encode({ n: 50 }, schema), /range/);
  assert.equal(decode('v1.1', schema), null);    // 1 < 100
  assert.equal(decode('v1.zzz', schema), null);  // 46655 > 1000
});

test('positional: hex6 encodes lowercase hex without #', () => {
  const schema = {
    version: 1,
    encoding: 'positional',
    fields: [{ type: 'hex6', name: 'color' }],
  };
  assert.equal(encode({ color: '#FF6600' }, schema), 'v1.ff6600');
  assert.equal(encode({ color: 'aabbcc'  }, schema), 'v1.aabbcc');
  assert.deepEqual(decode('v1.ff6600', schema), { color: 'ff6600' });
  assert.equal(decode('v1.zzzzzz', schema), null);  // 'z' not a hex char
  assert.equal(decode('v1.ff66',   schema), null);  // truncated
});

test('positional: two trailing base-36 ints disambiguate by range (mnlth-style)', () => {
  // The decoder for adjacent ints needs a way to find the split.
  // Strategy in v1: the second int's range constrains it; the decoder scans
  // split positions and accepts the unique split where both decode in-range.
  const schema = {
    version: 1,
    encoding: 'positional',
    fields: [
      { type: 'int', name: 'x', min: 100, max: 1000 },
      { type: 'int', name: 'y', min: 100, max: 1000 },
    ],
  };
  assert.equal(encode({ x: 350, y: 350 }, schema), 'v1.9q9q');
  assert.deepEqual(decode('v1.9q9q', schema), { x: 350, y: 350 });
  assert.deepEqual(decode('v1.7n7m', schema), { x: 275, y: 274 });
});

test('decode rejects missing or wrong version prefix', () => {
  assert.equal(decode('p',          SINGLE_ENUM_SCHEMA), null);   // no v
  assert.equal(decode('v2.p',       SINGLE_ENUM_SCHEMA), null);   // wrong version
  assert.equal(decode('',           SINGLE_ENUM_SCHEMA), null);   // empty
  assert.equal(decode(null,         SINGLE_ENUM_SCHEMA), null);
  assert.equal(decode(undefined,    SINGLE_ENUM_SCHEMA), null);
});

test('decode rejects unknown enum char', () => {
  assert.equal(decode('v1.x', SINGLE_ENUM_SCHEMA), null);
});

test('decode rejects trailing junk', () => {
  assert.equal(decode('v1.pX', SINGLE_ENUM_SCHEMA), null);
});

// --- list ---

const INT_LIST_SCHEMA = {
  version: 1,
  encoding: 'positional',
  fields: [
    { type: 'list', name: 'idx', of: { type: 'int', min: 0, max: 65535 } },
  ],
};

test('list: empty list encodes as bare count 0', () => {
  assert.equal(encode({ idx: [] }, INT_LIST_SCHEMA), 'v1.0');
  assert.deepEqual(decode('v1.0', INT_LIST_SCHEMA), { idx: [] });
});

test('list: int list round-trips with - between items', () => {
  const state = { idx: [3, 7, 12, 45] };
  assert.equal(encode(state, INT_LIST_SCHEMA), 'v1.4-3-7-c-19');
  assert.deepEqual(decode('v1.4-3-7-c-19', INT_LIST_SCHEMA), state);
});

test('list: enum list round-trips', () => {
  const schema = {
    version: 1,
    encoding: 'positional',
    fields: [
      { type: 'list', name: 'tags',
        of: { type: 'enum', values: { a: 'a', b: 'b', c: 'c' } } },
    ],
  };
  const state = { tags: ['a', 'b', 'c', 'a'] };
  assert.equal(encode(state, schema), 'v1.4-a-b-c-a');
  assert.deepEqual(decode('v1.4-a-b-c-a', schema), state);
});

// --- opt ---

const OPT_SCHEMA = {
  version: 1,
  encoding: 'positional',
  fields: [
    { type: 'opt', name: 'isolated', of: { type: 'int', min: 0, max: 1000 } },
  ],
};

test('opt: null encodes as ~', () => {
  assert.equal(encode({ isolated: null }, OPT_SCHEMA), 'v1.~');
  assert.deepEqual(decode('v1.~', OPT_SCHEMA), { isolated: null });
});

test('opt: present value encodes inner', () => {
  assert.equal(encode({ isolated: 42 }, OPT_SCHEMA), 'v1.16');
  assert.deepEqual(decode('v1.16', OPT_SCHEMA), { isolated: 42 });
});

test('opt: undefined treated as null', () => {
  assert.equal(encode({}, OPT_SCHEMA), 'v1.~');
});

// --- tagged ---

const TAGGED_SCHEMA = {
  version: 1,
  encoding: 'tagged',
  fields: [
    { type: 'enum', name: 'material', tag: 'm', default: 'printed',
      values: { printed: 'p', sheet_metal: 's' } },
    { type: 'enum', name: 'gantry',   tag: 'g', default: 'fixed',
      values: { flying: 'v', fixed: 'f' } },
    { type: 'int',  name: 'xRail',    tag: 'x', default: 350, min: 100, max: 1000 },
    { type: 'list', name: 'hidden',   tag: 'h',
      of: { type: 'int', min: 0, max: 65535 } },
    { type: 'opt',  name: 'isolated', tag: 'i',
      of: { type: 'int', min: 0, max: 65535 } },
  ],
};

test('tagged: empty state encodes as bare version', () => {
  assert.equal(encode({}, TAGGED_SCHEMA), 'v1.');
  assert.deepEqual(decode('v1.', TAGGED_SCHEMA), {});
});

test('tagged: only non-default fields appear in encoding', () => {
  const state = { material: 'sheet_metal', gantry: 'fixed', xRail: 350 };
  // gantry and xRail are at default → omitted
  assert.equal(encode(state, TAGGED_SCHEMA), 'v1.m=s');
  assert.deepEqual(decode('v1.m=s', TAGGED_SCHEMA), { material: 'sheet_metal' });
});

test('tagged: multiple non-default fields', () => {
  const state = { material: 'sheet_metal', gantry: 'flying', xRail: 400 };
  const encoded = encode(state, TAGGED_SCHEMA);
  // Order follows the schema: m,g,x
  assert.equal(encoded, 'v1.m=s,g=v,x=b4');
  assert.deepEqual(decode(encoded, TAGGED_SCHEMA), state);
});

test('tagged: list field round-trips with - between items', () => {
  const state = { hidden: [3, 7, 12, 45] };
  assert.equal(encode(state, TAGGED_SCHEMA), 'v1.h=4-3-7-c-19');
  assert.deepEqual(decode('v1.h=4-3-7-c-19', TAGGED_SCHEMA), state);
});

test('tagged: opt field — present and null', () => {
  assert.equal(encode({ isolated: 42 }, TAGGED_SCHEMA), 'v1.i=16');
  assert.deepEqual(decode('v1.i=16', TAGGED_SCHEMA), { isolated: 42 });
  // null/absent is the default for opt → omitted
  assert.equal(encode({ isolated: null }, TAGGED_SCHEMA), 'v1.');
});

test('tagged: unknown tag in payload returns null', () => {
  assert.equal(decode('v1.q=zzz', TAGGED_SCHEMA), null);
});

test('tagged: malformed pair (missing =) returns null', () => {
  assert.equal(decode('v1.mp', TAGGED_SCHEMA), null);
});

test('tagged: bad value for known tag returns null', () => {
  assert.equal(decode('v1.m=z', TAGGED_SCHEMA), null);   // unknown enum
  assert.equal(decode('v1.x=1', TAGGED_SCHEMA), null);   // < min 100
});

test('decode tolerates surrounding whitespace', () => {
  assert.deepEqual(decode('  v1.p  ', SINGLE_ENUM_SCHEMA), { material: 'printed' });
});

// --- fuzz / round-trip ---

test('round-trip: 200 random tagged states', () => {
  const rand = mulberry32(0xC0DE5EED);
  const pickEnum = (table) => {
    const keys = Object.keys(table);
    return keys[Math.floor(rand() * keys.length)];
  };
  const randInt = (min, max) => min + Math.floor(rand() * (max - min + 1));

  for (let i = 0; i < 200; i++) {
    const state = {
      material:   pickEnum(TAGGED_SCHEMA.fields[0].values),
      gantry:     pickEnum(TAGGED_SCHEMA.fields[1].values),
      xRail:      randInt(100, 1000),
      hidden:     Array.from({ length: randInt(0, 8) }, () => randInt(0, 65535)),
      isolated:   rand() < 0.5 ? null : randInt(0, 65535),
    };
    const encoded = encode(state, TAGGED_SCHEMA);
    const decoded = decode(encoded, TAGGED_SCHEMA);
    // Re-build expected output applying the same default-skipping rules:
    // tagged decode returns ONLY non-default fields, so missing keys mean default.
    const expected = {};
    for (const f of TAGGED_SCHEMA.fields) {
      const v = state[f.name];
      const isDefault = (f.type === 'opt' && v === null)
                     || (f.type === 'list' && Array.isArray(v) && v.length === 0)
                     || (f.default !== undefined && v === f.default);
      if (!isDefault) expected[f.name] = v;
    }
    assert.deepEqual(decoded, expected, `state ${i}: ${encoded}`);
  }
});

// Tiny seeded PRNG so the test is deterministic.
function mulberry32(seed) {
  let t = seed >>> 0;
  return function () {
    t = (t + 0x6D2B79F5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

test('round-trip: malformed inputs never throw', () => {
  const bads = [
    '', 'v', 'v1', 'v1.', 'v1.m=', 'v1.=p', 'v1.,', 'v1.,m=p',
    'v1.m', 'v1.m=p,', 'v1.m=p,,g=v', 'v2.anything',
    'v1.h=z-3', 'v1.h=2-3',  // list count says 2 but only 1 item
    null, undefined, 42, {}, [], 'v1.💥',
  ];
  for (const bad of bads) {
    assert.doesNotThrow(() => decode(bad, TAGGED_SCHEMA), `input: ${JSON.stringify(bad)}`);
  }
});

test('decode never throws on malformed input', () => {
  for (const bad of ['v1.', 'v1', '~~~', 'v1. ', 'v1.💥', 'v1.p\nv1.p']) {
    assert.doesNotThrow(() => decode(bad, SINGLE_ENUM_SCHEMA));
  }
});
