# Versioned Compact URL Share Codec — SPEC

Date: 2026-05-07
Status: Draft v1.0
Audience: any browser-based app with a small (≤30 fields) typed configuration that users want to share via URL.

## 1. Purpose

A pattern for encoding small structured state into URL-safe strings that are:

- **Compact** — short enough to share verbally or in a 280-char tweet without truncation.
- **Versioned** — schema changes are detectable, not silently destructive.
- **Inspectable** — a human can eyeball the encoded payload without tooling.
- **Reversible without a server** — encode/decode is pure client-side JS.
- **URL-safe** — no encoding required when written into a query parameter.

The pattern is derived from the share-link codec used by the Monolith Gantry Configurator at `mnlth.csovesbanat.hu`, generalized into a reusable design.

## 2. Goals and non-goals

### Goals

- Encode 5–30 fields of typed config into ≤80 chars of URL.
- Schema-version round-trips are detected at decode time.
- Decoders never throw on malformed input — return `null`.
- Defaults handled by the consumer, not the codec; missing fields decode as missing, not as defaults.

### Non-goals

- **Encoding arbitrary JSON.** If your state has nested objects or unbounded lists, use `lz-string`, `msgpack` + base64, or a server-side share store.
- **Authentication, signing, or tamper-resistance.** The string is plaintext. If it matters that the recipient sees what the sender saw, sign separately.
- **Encoding floating-point or large numerics.** Use base-36 ints with explicit ranges. For floats, multiply-and-round first.
- **Encoding free-form text.** A username or note field doesn't belong here. Put text fields in a separate query param with normal `encodeURIComponent`.

## 3. Format

### 3.1 Top-level grammar

```
share-string := "v" version "." payload
version      := unsigned-integer            ; schema version, base-10
payload      := encoded fields per schema
```

Examples:

```
v1.psawanrnsd9j        # 14 chars: positional, mnlth-style
v1.m=p,g=v,b=9,x=9q    # 21 chars: tagged, with named fields
v3.~                   # 4 chars:  empty state, schema v3
```

The version prefix MUST be present. A bare payload without `v<n>.` is invalid.

### 3.2 Character set

Tokens MUST use only RFC 3986 unreserved characters minus the reserved syntactic ones the codec uses:

- `A–Z`, `a–z`, `0–9` — for content
- `-` `_` `~` — used as separators or sentinels (see below)
- `.` — used only as the version-payload delimiter

Reserved (do not appear inside tokens unless quoted):

| Char | Reason |
| --- | --- |
| `.` | Version-payload delimiter. Appears once at position `1+digits(version)`. |
| `,` | Default field separator in tagged form (configurable). |
| `=` | Default key-value separator in tagged form (configurable). |
| `~` | Recommended sentinel for "absent" / null. |

Avoid `+`, `&`, `?`, `#`, `/`, `%`, `=` (in URLs `=` parses as the param assignment), `:`, `;`. They survive `URLSearchParams` round-trips inconsistently across runtimes.

### 3.3 Field types

Five scalar primitives plus three composite types:

| Type | Encoding | Length | Notes |
| --- | --- | --- | --- |
| `enum`      | one char from a value→char table | 1 | See §3.3.1 |
| `bool`      | `0` or `1` | 1 | Or pack ≤5 booleans into one base-36 char |
| `int`       | base-36, no padding | variable | Use `Number.toString(36)`. Decoder is range-checked and rejects leading-zero forms. |
| `hex6`      | 6-char hex color | 6 | No `#` prefix; lowercased |
| `null`      | the sentinel `~` | 1 | Marks "absent" / "use default" inside an `opt` |

Composite types built on the primitives:

| Type | Encoding | Notes |
| --- | --- | --- |
| `list` of T   | `<count-base36>` then `count` repetitions of `-<encoded-item>`. Empty is bare `0`. | Examples: `0`, `1-x`, `4-3-7-c-19`. The `-` separator is unreserved and works inside positional, tagged, and multi-param forms. |
| `opt` of T    | `~` for null, otherwise the inner T's encoding. | Used for fields that are sometimes absent. |
| `composite` of (T₁, T₂, …) | inner parts joined by `:`. | An ordered tuple. Length is sum of part lengths plus `(N-1)` separators. Works for variable-length parts because `:` doesn't collide with int's base-36 alphabet, hex6's `[0-9a-f]`, or list's `-` separator. |

Variable-length parts in adjacent positions (e.g., two `int` fields side by side in positional form) need a way to find the split. The decoder uses backtracking: it tries each valid split position, longest-first preferred only when the encoder produces shortest-form output, and accepts the first split where every subsequent field also decodes successfully. For pathological cases (three+ adjacent ints), use a separator or `composite` instead.

#### 3.3.1 Enum tables

Every enum field needs a one-to-one table from value to a single character:

```js
const TABLES = {
  material:   { printed: 'p', sheet_metal: 's' },
  gantryType: { flying:  'v', fixed:       'f' },
  // …
};
```

Constraints:

- Every char in the table MUST be from the unreserved set above.
- Chars MUST be unique within a table.
- Tables are immutable across schema versions for any given field. To add a value, append a new char. To remove a value, leave its char reserved (decoders for the new version reject it; old links keep decoding to the deprecated value).
- The reverse table (char → value) is mechanically derived; production decoders MUST precompute it once.

### 3.4 Versioning

The leading `v<n>.` is mandatory. Decoders MUST reject any payload whose version doesn't match what they understand:

```js
function decode(s) {
  if (!s?.startsWith(`v${SCHEMA_VERSION}.`)) return null;
  // …
}
```

Bump version on:

- A field added that was always present in old payloads.
- A field removed.
- A field's encoding strategy changed (e.g., enum → int).
- An enum-value char changed (NEVER do this; reserve the char and add a new one).
- The encoding strategy itself changed (positional ↔ tagged).

Migrators are explicit:

```js
const decoders = {
  1: decodeV1,
  2: decodeV2,
};
function decode(s) {
  const m = /^v(\d+)\./.exec(s ?? '');
  if (!m) return null;
  const version = +m[1];
  const decoder = decoders[version];
  if (!decoder) return null;     // unknown version
  const decoded = decoder(s.slice(m[0].length));
  // Optionally: migrate older versions forward to current
  return migrate(decoded, version);
}
```

### 3.5 Failure mode

Decoders MUST NOT throw on malformed input. They MUST return `null` and let the caller fall back to defaults.

This includes:

- Missing or wrong version prefix
- Unknown enum char
- Truncated payload (e.g., positional decode runs off the end)
- Out-of-range numeric
- Extra trailing data

A decoder is a parser; a parser that crashes on user input is a bug.

## 4. Two encoding strategies

The format admits two strategies, picked per schema. Mixing them within one schema is allowed but typically not worth it.

### 4.1 Positional (fixed-size schemas)

Fields are concatenated in a fixed order with no separators:

```
v1.<f1><f2><f3>…<fN>
```

Pros:
- Maximally compact (`v1.psawanrnsd9j`-style).
- Simplest to encode/decode for genuinely fixed schemas.

Cons:
- Adding a field bumps the version (old decoders break).
- Variable-length fields (base-36 ints, lists) need terminators or unambiguous range constraints.
- Hard to read by eye.

When to pick: schema is locked, all-enum or numeric, ≤16 fields. The classic configurator case.

#### 4.1.1 Variable-length fields in positional form

If you must put variable-length tokens in positional form, three options:

- **Range disambiguation**: if your last two int fields are constrained to disjoint or known ranges, the decoder can scan split positions. Mnlth does this for `xRail`/`yRail` ∈ [100, 1000] mm. Limited to two trailing numerics.
- **Length prefix**: prepend each variable token with its length as a single base-36 char.
- **Separator**: use a single delimiter char (recommended `-`) between the variable token and the next field. This is essentially tagged form with positions implied.

### 4.2 Tagged (evolving schemas)

Each field is encoded as `key=value`, fields are separated by `,`:

```
v1.m=p,g=v,b=9,x=9q,y=9q
```

Pros:
- Adding a field doesn't bump the version (new decoders read what's present, fall back on what's missing).
- Sparse states stay short — skip fields at default.
- Readable at a glance.

Cons:
- Longer than positional for fully-populated states.
- Slightly more parsing.

When to pick: schema may grow; some fields are sparse; you want forward compatibility within a major version.

Rule for compatibility: within a major version, only **add** fields. Adding a field adds zero chars to old encoded payloads. Old decoders ignore the new field; new decoders fall back to a default if the field is missing. **Removal** or **rename** still bumps the version.

### 4.3 Hybrid

The CADScope plan that motivates this spec uses a hybrid: keep `?model=ID` in plain text (for share-recipient readability and indexability) and put share state alongside it. The codec doesn't have to be the only thing in the URL.

### 4.4 Multi-param mode

A third option for browser URLs: instead of one opaque `?c=<encoded>` blob, split each schema field into its own URL query parameter:

```
?model=Positron_v3.2.2&c=1-0:ff6600&h=1-qu&i=8     # CADScope's chosen shape
```

Each value is what tagged-form would produce *for that field* — without the `v<n>.` prefix and without the `tag=` wrapper. The encoder returns a `{ tag: encodedValue }` map; the caller is responsible for folding it into a URL (or any other naming-keyed transport).

Pros:
- Cleanest URLs. Most chars stay literal; only composite's `:` gets percent-encoded by `URLSearchParams`. Field params with no composites (`h=1-qu`) survive intact.
- Easy to filter / strip individual fields client-side without re-encoding.
- Plays well with existing query-string conventions (sortable, cacheable per param).

Cons:
- **No version prefix in the URL.** Schema changes silently misinterpret old links unless the caller adds an explicit `&v=N` param. See §3.4 — pick one of: never change the schema, version each param tag (`c1=`, `c2=`), or carry a separate version param.
- Each tag becomes a top-level URL param, so the caller must namespace carefully if other components also use the query string.

Reference API:

```js
// Returns { [tag]: encodedValue } — the caller maps onto its transport.
encodeFields(state, schema): Record<string, string>;
// Inverse — takes the same shape, returns state object or null on bad input.
decodeFields(map, schema): object | null;
```

Defaults are skipped exactly as in tagged form.

## 5. Reference API

The codec exposes four pure functions plus a schema definition:

```ts
type FieldSpec =
  | { type: 'enum',      name: string, tag?: string, values: Record<string, string>, default?: unknown }
  | { type: 'bool',      name: string, tag?: string, default?: boolean }
  | { type: 'int',       name: string, tag?: string, min: number, max: number, default?: number }
  | { type: 'hex6',      name: string, tag?: string, default?: string }
  | { type: 'list',      name: string, tag?: string, of: FieldSpec }
  | { type: 'opt',       name: string, tag?: string, of: FieldSpec }
  | { type: 'composite', name: string, tag?: string, parts: FieldSpec[] };

type Schema = {
  version: number;
  encoding: 'positional' | 'tagged';
  fields: FieldSpec[];
};

// Single-string forms (versioned).
declare function encode(state: Record<string, unknown>, schema: Schema): string;
declare function decode(payload: string, schema: Schema): Record<string, unknown> | null;

// Multi-param form (no version). See §4.4. Returns/takes a tag→encoded-value map.
declare function encodeFields(state: Record<string, unknown>, schema: Schema): Record<string, string>;
declare function decodeFields(map: Record<string, string>, schema: Schema): Record<string, unknown> | null;
```

Contract:

- `encode` / `decode` round-trip cleanly for any state whose values satisfy the schema's range/enum constraints.
- `encodeFields` / `decodeFields` round-trip cleanly the same way for the per-field map shape; the caller is responsible for serialising the map into URL params, object properties, or whatever transport.
- All four functions never throw on malformed input from the wire side (decode/decodeFields return `null`). The encode side throws `SchemaError` only on internal-bug conditions (passing an unknown enum value, an out-of-range int, etc.) — those are not user-input errors.
- Defaults are skipped automatically in `tagged` and `encodeFields` modes. A field whose value equals its declared `default` (or empty list, or `null` for `opt`) is omitted from the output.

## 6. Implementation notes

The reference implementation is `assets/share_codec.js` in this repo (~310 lines, vanilla JS, no dependencies, ESM). Lift the file directly. The notes below cover the design choices that aren't obvious from reading the code.

### 6.1 Two encode functions, two decode functions

```
encode(state, schema)        → "v1.<body>"           single-string form
decode(payload, schema)      → state | null

encodeFields(state, schema)  → { tag: encodedValue }  per-field (multi-param) form
decodeFields(map, schema)    → state | null
```

`encode` dispatches on `schema.encoding` to either `encodePositional` or `encodeTagged`. `encodeFields` is independent of `encoding` — it always emits per-field, defaults skipped.

### 6.2 Backtracking decoder

Variable-length fields (`int`, `list`, `composite`) make deterministic single-pass decoding impossible in positional form. The decoder is a small backtracking parser: each field's `candidates(spec, src, i)` is a generator yielding `(value, consumed)` pairs in the order the encoder is most likely to have produced. The driver tries each candidate, recursively decodes the remaining fields, and accepts the first complete decode.

Two design rules keep backtracking bounded:

- `int`'s `candidates` yield lengths longest-first. Combined with the encoder always producing the **shortest** unambiguous base-36 representation (which is range-checked + leading-zero-rejected at decode time), the encoder's output is found at the first valid candidate in nearly all cases. Backtracking only fires for genuinely ambiguous adjacencies (e.g. two ints in [100, 1000] mm with no separator).
- `list`'s `candidates` use the `-` separator to find item boundaries unambiguously, so list parsing is linear regardless of inner type.

### 6.3 Composite is positional internally

Inside `composite`, parts are joined by `:`. The decoder enumerates inner candidates the same way, requiring `:` between parts and end-of-region after the last part. Composites can nest inside lists and opts; the separator hierarchy (`,` for tags, `-` for list items, `:` for composite parts) keeps levels distinct.

### 6.4 Defaults

A field is "at default" and omitted from `tagged` / `encodeFields` output when:
- it is `undefined` or missing from the state, OR
- it is an `opt` field with value `null`, OR
- it is a `list` field with empty array, OR
- it has a declared `default` and the value strictly equals that default.

Decoders never apply defaults — a missing field stays missing in the decoded state. The caller is responsible for layering defaults on top.

### 6.5 Errors

`encodeField` throws `SchemaError` on schema violations from the encode side (unknown enum value, out-of-range int, malformed hex6, list count > 35, composite arity mismatch). These are programmer errors, not user-input errors.

`decode` / `decodeFields` never throw on user input. Any malformed payload, bad type, missing version prefix, or out-of-range value collapses to `null`. Internal `SchemaError` thrown during decode (e.g., from a malformed schema) re-propagates — callers should fix their schema, not catch.

### 6.6 Whitespace tolerance

`decode` trims its input. URLs pasted from email clients or chat apps that wrap mid-line still decode cleanly. `decodeFields` does not trim — values come from `URLSearchParams.get()` which has already done URL-decoding.

### 6.7 Reverse-table caching

Enum value→char tables are inverted to char→value tables on first use and cached in a module-level `WeakMap` keyed by the spec object. Schemas are typically defined once at module load, so the cost is negligible and avoids mutating the schema with hidden fields.

## 7. Worked example A — small enum-heavy config (positional)

A printer-config tool's preset, ~5 enums and 2 numerics:

```js
const SCHEMA = {
  version: 1,
  encoding: 'positional',
  fields: [
    { type: 'enum', name: 'material',   values: { printed: 'p', sheet_metal: 's' } },
    { type: 'enum', name: 'gantry',     values: { flying: 'v', fixed: 'f' } },
    { type: 'enum', name: 'drive',      values: { awd: 'a', '2wd': '2' } },
    { type: 'enum', name: 'beltWidth',  values: { '6mm': '6', '9mm': '9' } },
    { type: 'enum', name: 'sensorless', values: { all: 'a', x_axis: 'x', y_axis: 'y', none: 'n' } },
    { type: 'int',  name: 'shortShafts', min: 0, max: 4 },
    { type: 'int',  name: 'xRail',       min: 100, max: 1000 },
    { type: 'int',  name: 'yRail',       min: 100, max: 1000 },
  ]
};

const state = {
  material: 'printed', gantry: 'flying', drive: 'awd', beltWidth: '9mm',
  sensorless: 'none', shortShafts: 0, xRail: 350, yRail: 350
};

encode(state, SCHEMA);
// => "v1.pva9n09q9q"
```

Decoded:

```
"pva9n09q9q"
 │││││││ │└── yRail   = parseInt('9q', 36) = 350
 ││││││ │└─── xRail   = parseInt('9q', 36) = 350
 │││││ │└──── shortShafts = parseInt('0', 36) = 0
 ││││└── sensorless = 'n' → none
 │││└─── beltWidth  = '9' → 9mm
 ││└──── drive      = 'a' → awd
 │└───── gantry     = 'v' → flying
 └────── material   = 'p' → printed
```

Encoded length: 13 chars including `v1.`. Adding a field requires bumping version to 2. The two trailing ints are disambiguated by the decoder's greedy-base36 plus range check.

## 8. Worked example B — 3D viewer view-state

A CAD viewer that shares: per-category color overrides, hidden-node set, currently isolated node. Sparse — most users override 0–4 categories and hide 0–10 nodes:

```js
const SCHEMA = {
  version: 1,
  encoding: 'tagged',
  fields: [
    {
      type: 'list', name: 'colorOverrides', tag: 'c',
      of: {
        type: 'composite',
        parts: [
          { type: 'int',  min: 0, max: 35 },
          { type: 'hex6' },
        ],
      },
    },
    {
      type: 'list', name: 'hiddenNodes', tag: 'h',
      of: { type: 'int', min: 0, max: 65535 },
    },
    {
      type: 'opt', name: 'isolatedNode', tag: 'i',
      of: { type: 'int', min: 0, max: 65535 },
    },
  ],
};
```

Tagged-form encoding (single `?c=` URL param, versioned):

```
v1.                                                    # everything at default
v1.c=2-0:ff6600-3:00aaff                               # 2 color overrides
v1.c=1-2:ff6600,h=4-3-7-c-19                           # 1 color override + 4 hidden nodes
v1.c=1-2:ff6600,h=4-3-7-c-19,i=8                       # ... + node #8 isolated
```

Multi-param encoding (one URL param per non-default field, no version prefix — see §4.4):

```
?model=Foo                                             # everything at default
?model=Foo&c=2-0:ff6600-3:00aaff                       # 2 color overrides
?model=Foo&c=1-2:ff6600&h=4-3-7-c-19                   # 1 color override + 4 hidden nodes
?model=Foo&c=1-2:ff6600&h=4-3-7-c-19&i=8               # ... + node #8 isolated
?model=Foo&h=1-qu                                      # just one hidden node (#966)
```

Within a list, items are separated by `-`. The list count comes first, then `-<item>` for each. Composite parts are joined by `:`. All separators (`,`, `-`, `:`, `=`, `~`) are URL-safe; only `:` triggers percent-encoding (`%3A`) when written through `URLSearchParams.set()`.

Empty state encodes to `v1.` (3 chars). Typical state encodes to 30–60 chars. URL stays well under any browser's practical limit even for pathological cases.

Indices are positions in a deterministic walk of the loaded model's tree (same walk the app uses to build its UI). Indices are stable across sessions for the same (model, sidecar). If indices need to be stable across re-exports, use path strings instead — costs ~30 chars per node but never breaks.

## 9. Pitfalls and guidance

### 9.1 Adjacent variable-length fields rely on the encoder's shortest-form invariant

The decoder finds a valid split of `9q9q` into `[350, 350]` (rather than e.g. `[3, 1265]`) by trying length candidates longest-first AND requiring the candidate to round-trip through `Number.toString(36) === slice` (no leading-zero forms accepted). Combined with the encoder always producing the shortest base-36 representation of each int, this puts the encoder's actual output as the decoder's first valid candidate.

This works for two adjacent ints, three, even more — but the worst-case backtracking grows. For schemas with three or more adjacent variable-length ints, prefer one of:
- Add a `-` separator (use `composite` if they belong together, or split into separate tagged fields).
- Use tagged or multi-param encoding so each field has its own delimiter.
- Make some of them `int-fixed`-style by zero-padding to a known width — but the codec doesn't currently expose that as a primitive (deliberately; it's almost always wrong).

### 9.2 Versioning enum char tables is a one-way street

Once you've published `'p' → 'printed'`, you can never reuse `'p'` for anything else. Treat the enum-char table as forever-additive. To remove a value, leave its char reserved.

### 9.3 Don't put text fields in the codec

A username, a note, a free-form description — none of those belong here. Use a separate URL parameter with normal `encodeURIComponent`. The codec is for *typed* config.

### 9.4 Strip whitespace before decoding

URLs pasted from emails, Slack, or wrapped chat windows can pick up `\n` or stray spaces. The decoder MUST tolerate this:

```js
export function decode(s, schema) {
  return decodeImpl(String(s ?? '').trim(), schema);
}
```

### 9.5 Composite fields

`composite` is a first-class type for ordered tuples (pairs, triples, …). Use it for things like `(paletteIdx, hex6)` color overrides or `(x, y)` coordinate pairs where the parts naturally travel together:

```js
{
  type: 'list', name: 'colorOverrides',
  of: {
    type: 'composite',
    parts: [
      { type: 'int',  min: 0, max: 255 },
      { type: 'hex6' },
    ],
  },
}
```

Parts are encoded in declaration order, joined by `:`. Inside a list, items are separated by `-`, so `[[0, 'ff6600'], [3, '00aaff']]` encodes as `2-0:ff6600-3:00aaff`. The separator hierarchy (`,` tag → `-` list → `:` composite) lets composites nest inside lists and opts cleanly. Don't reach for composite for unrelated fields you happen to be encoding together — those are just two regular fields, and tagged form is more legible.

### 9.6 Schema versioning vs. content versioning

The `v<n>.` covers the *schema* — what fields exist, how they're encoded. It doesn't cover the *content* — for example, if your schema references "node index #7", a model re-export that reorders nodes will break old links even though the schema is unchanged.

Two mitigations:

- **Stable references**: encode by name/path instead of index. Longer.
- **Content fingerprint**: include a short content hash of the underlying asset (model file, dataset, spreadsheet) as one of your schema fields. Decoders that see a mismatch warn or refuse.

Pick based on what changes more often.

### 9.7 Forward-compat in tagged form: ignore vs. reject unknown tags

The reference implementation above *rejects* unknown tags (returns `null`). That's the strict interpretation. The lenient interpretation — ignore unknown tags — lets you add fields *within a major version* without bumping it, at the cost of silently dropping data when an old decoder reads a new payload.

Pick strict by default. If forward-compat-without-version-bump matters more than detecting payload corruption, switch to lenient and document it.

### 9.8 Don't trust `URLSearchParams` round-trips for these strings

Some chars survive `URLSearchParams.set()` + `URLSearchParams.get()` differently than they survive raw `?key=value` in the URL bar. The character set in §3.2 is chosen so that no encoding step is needed, but if you have to put the codec output through `URLSearchParams`, test the round-trip explicitly.

### 9.9 Test the codec with a fuzzer

Fifty lines of round-trip tests catches 95% of bugs:

```js
import { encode, decode } from './share_codec.js';
import { SCHEMA } from './my_schema.js';

const samples = generateRandomStates(SCHEMA, 1000);
for (const s of samples) {
  const enc = encode(s, SCHEMA);
  const dec = decode(enc, SCHEMA);
  assert.deepEqual(dec, s);
}

// And: malformed inputs never throw
for (const bad of generateMalformedStrings()) {
  assert.equal(decode(bad, SCHEMA), null);
}
```

## 10. FAQ / comparisons with alternatives

### Why not lz-string?

`lz-string` is a great library for compressing arbitrary JSON into URL-safe strings. Use it when:

- Your state is large (>500 chars JSON).
- The state is irregularly shaped (deep nesting, varying field sets).
- You don't care about human-readability of the encoded payload.

This codec wins for small, fixed-shape state because it's typically *shorter* than lz-string for ≤30 fields, it's versioned by design, and the encoded form is inspectable.

### Why not Base64-encoded JSON?

Base64-encoded JSON for a 5-enum / 2-int config runs ~80–120 chars vs. ~13–25 for this codec. The base64 form also isn't versioned unless you wrap it, isn't inspectable, and adds `=` padding that's hostile to URLs.

### Why not query-string-of-fields (`?material=printed&gantry=flying&...`)?

That's perfectly fine for ≤5 fields with short string values. Past that, URLs get hard to read and copy. This codec earns its complexity once you have 5+ fields or any kind of list/sparse state.

### Why not msgpack?

`msgpack` is binary; you'd still need to base64 it for a URL, ending up close to JSON+base64 in length. For small typed state, `msgpack` is the wrong granularity.

### Why not server-side share IDs?

`https://app.example/?share=h3y7g2k9` with a server lookup is the most flexible — any state, any size, mutable, revocable. Use it if you have a server, want analytics on share-link usage, or expect the state to need server-side processing anyway. This codec is for the no-backend, fully-static case.

## 11. Reference checklist for adopting this codec in a project

1. Identify the state to encode. List every field: name, type, range/enum.
2. Pick an encoding form:
   - **Positional** — fixed schema, ≤16 fields, all-enum-or-int, want the shortest possible string.
   - **Tagged** — evolving schema with sparse states; one URL param holds everything.
   - **Multi-param** — browser URLs with multiple typed fields; each becomes its own query param. Cleanest URLs but no built-in version detection.
3. Write the `SCHEMA` literal. Add explicit `tag` strings if any two field names share their first character.
4. Define enum char tables. Verify uniqueness within each table; pick chars that aren't easily confused (avoid `0` vs `o`, `1` vs `l` if the audience will retype).
5. Drop in `share_codec.js`.
6. Write a round-trip test (§9.9).
7. Hook the encoder into your URL-write path (typically `history.replaceState`). For multi-param, use `encodeFields` and fold the resulting map into your `URLSearchParams`.
8. Hook the decoder into your URL-read path (typically once at startup; return `null` on mismatch and warn).
9. Pick a content-fingerprint strategy if your indices reference an external asset that can change (§9.6).
10. Document the schema version in your project's README or CHANGELOG so external integrators can pin against a known version. Multi-param mode lacks a built-in version prefix; if version detection matters, add a separate `&v=N` URL param yourself.

## Appendix A: minimum viable codec in 50 lines

For the impatient reader who wants something to copy-paste right now. Single positional schema, no lists, no opts, no error recovery. Useful as a starting point, not as production code:

```js
export function makeCodec({ version, fields, tables }) {
  const reverseTables = Object.fromEntries(
    Object.entries(tables).map(([k, t]) => [k, Object.fromEntries(Object.entries(t).map(([v, c]) => [c, v]))])
  );
  return {
    encode(state) {
      const parts = fields.map(f => {
        const v = state[f];
        if (tables[f]) return tables[f][v] ?? '~';
        return Number.isInteger(v) ? v.toString(36) : '~';
      });
      return `v${version}.${parts.join('')}`;
    },
    decode(s) {
      try {
        if (!s?.startsWith(`v${version}.`)) return null;
        let i = `v${version}.`.length;
        const out = {};
        for (const f of fields) {
          if (tables[f]) {
            const v = reverseTables[f][s[i]];
            if (v === undefined) return null;
            out[f] = v; i++;
          } else {
            // greedy base-36
            let j = i;
            while (j < s.length && /[0-9a-z]/i.test(s[j])) j++;
            if (j === i) return null;
            out[f] = parseInt(s.slice(i, j), 36);
            i = j;
          }
        }
        return i === s.length ? out : null;
      } catch { return null; }
    }
  };
}
```

Outgrows itself fast — once you need lists, optionals, defaults, or tagged form, lift the full reference from §6.

## Appendix B: comparison sizes for the same state

For the 8-field state in §7 (`material=printed, gantry=flying, drive=awd, beltWidth=9mm, sensorless=none, shortShafts=0, xRail=350, yRail=350`), payload length only (no leading `?`):

| Encoding | Length | Sample |
| --- | --- | --- |
| This codec, positional   |  13 | `v1.pva9n09q9q` |
| This codec, multi-param  |  34 | `m=p&g=v&d=a&b=9&s=n&sh=0&x=9q&y=9q` |
| This codec, tagged       |  37 | `v1.m=p,g=v,d=a,b=9,s=n,sh=0,x=9q,y=9q` |
| Field=value query string | 104 | `material=printed&gantry=flying&drive=awd&beltWidth=9mm&sensorless=none&shortShafts=0&xRail=350&yRail=350` |
| JSON + base64            | 178 | `s=eyJtYXRlcmlhbCI6InByaW50ZWQiLCJnYW50cnkiOiJmbHlpbmciLCJk…` |
| JSON + URL-encoded       | 220 | `s=%7B%22material%22%3A%22printed%22%2C%22gantry%22%3A%22flying%22…` |

For larger states the gap narrows; for sparse state most-at-default this codec wins decisively because tagged and multi-param skip defaults entirely (an empty state is `v1.` for tagged, or zero query params for multi-param).

---

End of SPEC.
