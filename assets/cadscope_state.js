// ABOUTME: CADScope-specific share-state schema using the share-link codec.
// ABOUTME: Maps live viewer state (colors, hidden nodes, isolated node) to/from URL strings.

import { encodeFields, decodeFields } from './share_codec.js';

// Schema: tagged form so absent fields stay absent and the URL stays short.
// Fields:
//   c — list of (paletteIdx, hex6) color overrides, only entries that differ
//       from the sidecar's palette default
//   h — list of node-walk indices for nodes whose visibility differs from the
//       sidecar's defaultConfiguration
//   i — node-walk index of the currently isolated node (null if none)
export const CADSCOPE_SCHEMA = {
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

// Per-field URL mode. Writes one query param per non-default field
// (`c=...&h=...&i=...`) so the URL stays human-readable. There is no version
// prefix in this mode — schema changes break old links by design. Add a
// separate `&v=N` param if version detection becomes important.

export function writeShareToParams(state, params) {
  // Strip any existing share-state params first so re-encoding is idempotent.
  for (const f of CADSCOPE_SCHEMA.fields) params.delete(tagOf(f));
  const fields = encodeFields(state, CADSCOPE_SCHEMA);
  for (const [tag, val] of Object.entries(fields)) params.set(tag, val);
  return params;
}

export function readShareFromParams(params) {
  const map = {};
  for (const f of CADSCOPE_SCHEMA.fields) {
    const tag = tagOf(f);
    const v = params.get(tag);
    if (v !== null) map[tag] = v;
  }
  if (Object.keys(map).length === 0) return {};
  return decodeFields(map, CADSCOPE_SCHEMA);
}

function tagOf(f) {
  return f.tag ?? f.name[0];
}

// Determine the visual root, matching viewer.js's buildTree.
function visualRoot(model) {
  return (model.children.length === 1 && model.name === 'Scene') ? model.children[0] : model;
}

// Stable depth-first walk of the model. Index 0 is the visual root's first
// child, walking children in array order recursively. Indices are stable for
// a given GLB (assuming exporters preserve child order, which they do today).
export function walkNodes(model) {
  const out = [];
  const root = visualRoot(model);
  function visit(node) {
    out.push(node);
    if (node.children) for (const c of node.children) visit(c);
  }
  for (const c of root.children) visit(c);
  return out;
}

// Walk the palette in insertion order (Map preserves it). The index of a name
// is its position in palette.entries(). Adding new palette entries at the end
// is safe; reordering breaks old share links.
export function paletteIndex(lookups, name) {
  let i = 0;
  for (const [k] of lookups.palette) {
    if (k === name) return i;
    i++;
  }
  return -1;
}

export function paletteName(lookups, idx) {
  let i = 0;
  for (const [k] of lookups.palette) {
    if (i === idx) return k;
    i++;
  }
  return null;
}

// Diff current per-category picker values against the sidecar palette defaults.
// Returns an array of [paletteIdx, hex6] pairs, paletteIdx ascending.
// `pickerValues` is a Map<categoryName, hexStringWithOrWithoutHash>.
export function collectColorOverrides(lookups, pickerValues) {
  const out = [];
  let i = 0;
  for (const [name, entry] of lookups.palette) {
    const live = pickerValues.get(name);
    if (live !== undefined) {
      const liveHex = String(live).replace(/^#/, '').toLowerCase();
      const defaultHex = String(entry.color).replace(/^#/, '').toLowerCase();
      if (liveHex !== defaultHex) out.push([i, liveHex]);
    }
    i++;
  }
  return out;
}

