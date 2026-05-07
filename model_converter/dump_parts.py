#!/usr/bin/env python3
# ABOUTME: Generates sidecar templates from a GLB file for the CADScope viewer.
# ABOUTME: Writes a clean live-config .colors.json and a reference .scaffold.json.
"""
Dump part names and node paths from a GLB file into sidecar templates.

Writes two files next to the GLB:

  <model>.colors.json    — live config: palette + autoAssign + nodes.
                           Created with an empty starter template. Never
                           overwritten if it already exists.

  <model>.scaffold.json  — reference lists you copy from while editing the
                           live config. Always overwritten.

The scaffold contains:
  _groups  — sorted unique parent/assembly names (useful for autoAssign globs)
  _parts   — sorted unique mesh names (useful for autoAssign globs)
  _nodes   — every named node, ordered by tree position, mapping its
             slash-joined path (from the visual root, root excluded) to its
             current leaf name. Use a path as a key in the live config's
             "nodes" section to attach displayName / category / hidden to
             that node.

Usage:
    python dump_parts.py model.glb                  # writes model.colors.json + model.scaffold.json
    python dump_parts.py model.glb -o custom.json   # writes custom.colors.json + custom.scaffold.json
"""

import json
import re
import struct
import sys
import os


def clean_node_name(name):
    """Mirror the clean logic in blender_export.py / viewer.js.

    Also applies Three.js PropertyBinding.sanitizeNodeName() which strips
    characters reserved for animation paths: [ ] . : /
    """
    if not name:
        return name
    clean = name.split("/")[-1]
    clean = re.sub(r"\.step(-\d+)$", r"\1", clean, flags=re.IGNORECASE)
    clean = re.sub(r"\.step$", "", clean, flags=re.IGNORECASE)
    clean = re.sub(r"\s*\(mesh\)\s*", "", clean, flags=re.IGNORECASE)
    clean = re.sub(r"\s*\(group\)\s*", "", clean, flags=re.IGNORECASE)
    # Three.js sanitizeNodeName: spaces → underscores, strip [ ] . : /
    clean = clean.replace(" ", "_")
    clean = re.sub(r'[\[\].:\/]', '', clean)
    return clean.strip()


def strip_numeric_suffix(name):
    """Strip trailing -N suffix, matching viewer.js stripNumericSuffix."""
    return re.sub(r"-\d+$", "", name)


def read_glb_json(path):
    """Read and parse the JSON chunk from a GLB file."""
    with open(path, "rb") as f:
        magic = f.read(4)
        if magic != b"glTF":
            raise ValueError(f"Not a GLB file: {path}")
        version, total_length = struct.unpack("<II", f.read(8))
        chunk_length, chunk_type = struct.unpack("<II", f.read(8))
        if chunk_type != 0x4E4F534A:  # "JSON" in little-endian
            raise ValueError("First GLB chunk is not JSON")
        return json.loads(f.read(chunk_length))


def extract_names(glb_json):
    """Extract sorted unique group and part names from glTF nodes."""
    nodes = glb_json.get("nodes", [])

    # Build parent map
    parent_of = {}
    for i, n in enumerate(nodes):
        for child_idx in n.get("children", []):
            parent_of[child_idx] = i

    mesh_seen = set()
    mesh_names = []
    group_seen = set()
    group_names = []

    for i, n in enumerate(nodes):
        if "mesh" not in n:
            continue

        cleaned = clean_node_name(n.get("name", ""))
        if cleaned:
            key = strip_numeric_suffix(cleaned)
            if key not in mesh_seen:
                mesh_seen.add(key)
                mesh_names.append(key)

        if i in parent_of:
            parent_name = clean_node_name(nodes[parent_of[i]].get("name", ""))
            if parent_name:
                pkey = strip_numeric_suffix(parent_name)
                if pkey not in group_seen:
                    group_seen.add(pkey)
                    group_names.append(pkey)

    mesh_names.sort(key=str.casefold)
    group_names.sort(key=str.casefold)
    return group_names, mesh_names


def build_node_paths(glb_json):
    """Walk the default scene's node tree and return ordered (path, name) pairs.

    Mirrors the viewer's path logic: paths are slash-joined cleaned node names
    relative to the visual root, with the root itself excluded. When the scene
    has a single root node, that node IS the visual root (its children are
    depth 1, path = their own name). When it has multiple roots, the visual
    root is the synthetic Three.js Scene group, so each glTF root is depth 1.

    Nameless nodes are skipped from the output but are descended through, so
    their named descendants still appear at the right depth.
    """
    nodes = glb_json.get("nodes", [])
    scenes = glb_json.get("scenes", [])
    if not scenes:
        return []
    scene_idx = glb_json.get("scene", 0)
    if scene_idx >= len(scenes):
        scene_idx = 0
    root_indices = scenes[scene_idx].get("nodes", [])

    pairs = []

    def dfs(node_idx, ancestors):
        node = nodes[node_idx]
        name = clean_node_name(node.get("name", ""))
        if name:
            components = ancestors + [name]
            pairs.append(("/".join(components), name))
            child_ancestors = components
        else:
            child_ancestors = ancestors
        for child_idx in node.get("children", []):
            dfs(child_idx, child_ancestors)

    if len(root_indices) == 1:
        for child_idx in nodes[root_indices[0]].get("children", []):
            dfs(child_idx, [])
    else:
        for root_idx in root_indices:
            dfs(root_idx, [])

    return pairs


def starter_live_config():
    """A clean template for a fresh .colors.json — no part assignments."""
    return {
        "palette": {
            "Main":               {"color": "#FF6600"},
            "Accent":             {"color": "#00AAFF"},
            "Extrusions":         {"color": "#888888", "metalness": 0.8, "showInPicker": False},
            "Opaque Panels":      {"color": "#333333", "showInPicker": False},
            "Transparent Panels": {"color": "#555555", "showInPicker": False},
            "Glass":              {"color": "#ccddee", "metalness": 0.1, "opacity": 0.15, "showInPicker": False},
        },
        "autoAssign": [],
        "nodes": {},
    }


def main():
    if len(sys.argv) < 2 or sys.argv[1] in ("-h", "--help"):
        print(__doc__.strip())
        sys.exit(0)

    glb_path = sys.argv[1]
    if not os.path.isfile(glb_path):
        print(f"Error: file not found: {glb_path}", file=sys.stderr)
        sys.exit(1)

    # Output base: -o flag overrides the default sibling-of-GLB base.
    live_path = None
    if "-o" in sys.argv:
        idx = sys.argv.index("-o")
        if idx + 1 < len(sys.argv):
            live_path = sys.argv[idx + 1]
    if not live_path:
        live_path = re.sub(r"\.glb$", ".colors.json", glb_path, flags=re.IGNORECASE)

    # Derive scaffold path: strip a trailing .colors.json or .json and add .scaffold.json
    scaffold_path = re.sub(r"\.colors\.json$", ".scaffold.json", live_path, flags=re.IGNORECASE)
    if scaffold_path == live_path:
        scaffold_path = re.sub(r"\.json$", ".scaffold.json", live_path, flags=re.IGNORECASE)
    if scaffold_path == live_path:
        scaffold_path = live_path + ".scaffold.json"

    glb_json = read_glb_json(glb_path)
    group_names, mesh_names = extract_names(glb_json)
    node_pairs = build_node_paths(glb_json)

    # Live config — only write if absent, so existing user config is never clobbered.
    if os.path.exists(live_path):
        print(f"Live config already exists, leaving alone: {live_path}")
    else:
        with open(live_path, "w") as f:
            json.dump(starter_live_config(), f, indent=2)
            f.write("\n")
        print(f"Wrote starter live config: {live_path}")

    # Scaffold — always overwrite.
    scaffold = {
        "_groups": group_names,
        "_parts": mesh_names,
        "_nodes": {path: name for path, name in node_pairs},
    }
    with open(scaffold_path, "w") as f:
        json.dump(scaffold, f, indent=2)
        f.write("\n")

    print(f"Wrote scaffold ({len(group_names)} groups, {len(mesh_names)} parts, {len(node_pairs)} nodes): {scaffold_path}")
    print('Copy paths from _nodes into the live "nodes" map; copy names from _groups/_parts as autoAssign glob inputs.')


if __name__ == "__main__":
    main()
