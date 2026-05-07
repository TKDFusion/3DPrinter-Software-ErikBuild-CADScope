# CADScope

![Version](https://img.shields.io/badge/version-1.5.0-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![Three.js](https://img.shields.io/badge/Three.js-0.161.0-black)
![Platform](https://img.shields.io/badge/platform-browser-orange)

A browser-based 3D Viewer for CAD Assemblies, built with Three.js. Converts STEP files to Draco-compressed GLB with per-part colors and displays them in an interactive viewer with a scene hierarchy and preset camera views.

## Viewing

1. Place a GLB file (preferrably draco compressed) in `models/` (the viewer loads the path set in `index.html`)
2. Serve the project root: `python -m http.server 8000`
3. Open http://localhost:8000/index.html

### Controls

- **Left-drag** — Orbit
- **Middle/right-drag** — Pan
- **Scroll** — Zoom
- **View buttons** (top-right) — Preset angles + zoom
- **Scene hierarchy** (left sidebar) — Expand/collapse nodes, toggle visibility. The root node displays the model's `name` from `models.js`
- **Isolate button** (⊚, hover a tree row) — Hides everything except the clicked node and its ancestors/descendants; click again to restore
- **Color pickers** (left sidebar) — Change per-category part colors in real-time (when a color set file exists)

## Converting STEP to GLB

**Prerequisites:**
- Python 3 (for STEP color extraction; stdlib only)
- [Blender 5.0+](https://www.blender.org/download/) at `/Applications/Blender.app`
- [FreeCAD 1.0+](https://www.freecad.org/downloads.php) at `/Applications/FreeCAD.app`
--> you'll need to modify this to run on Linux or Windows; YMMV.

```sh
./model_converter/convert.sh models/input.step models/output.glb

# Without Draco compression
./model_converter/convert.sh --no-draco models/input.step models/output.glb
```

### Pipeline

```
STEP → extract colors (Python) → FreeCAD (geometry + hierarchy) → Blender (apply colors + Draco) → GLB
```

Per-part colors are parsed directly from the STEP text (ISO 10303-21) since FreeCAD's headless mode can't access them. Colors are passed to Blender via a JSON sidecar and applied as Principled BSDF materials. Color extraction is non-fatal — if it fails, the pipeline still produces a valid GLB without colors.

You can inspect a STEP file's materials standalone:

```sh
python3 model_converter/extract_step_colors.py input.step /tmp/colors.json
```

### Converter scripts

| File | Role |
|------|------|
| `convert.sh` | Orchestrates the three-stage pipeline |
| `extract_step_colors.py` | Parses STEP text for color-to-part mappings (Python 3, no dependencies) |
| `step_to_glb.py` | FreeCAD script: STEP import, tessellation, uncompressed GLB export |
| `blender_export.py` | Blender script: GLB import, name cleaning, color application, Draco export |
| `dump_parts.py` | Generates `.colors.json` (live config) and `.scaffold.json` (reference) sidecars from a GLB |

## Color Sets

A `.colors.json` sidecar tells the viewer how to color, hide, and rename nodes in a model. Per-model file, lives next to the GLB. Models without one simply won't show the color pickers — no errors.

The schema has three top-level sections:

- **`palette`** — a table of named categories with their color and material properties. Each entry gets a swatch in the sidebar (unless `showInPicker` is `false`).
- **`autoAssign`** — ordered glob rules that assign categories to nodes by name. First match wins.
- **`nodes`** — per-node overrides, keyed by slash-joined path from the visual root. Each entry can carry `displayName`, `category`, and `hidden`. Per-node `category` always beats an `autoAssign` match.

Example:

```json
{
  "palette": {
    "Main":       { "color": "#FF6600" },
    "Accent":     { "color": "#00AAFF" },
    "Extrusions": { "color": "#888888", "metalness": 0.8, "showInPicker": false },
    "Glass":      { "color": "#ccddee", "metalness": 0.1, "opacity": 0.15, "showInPicker": false }
  },
  "autoAssign": [
    { "category": "Extrusions", "match": "*2020_Extrusion*" },
    { "category": "Glass",      "match": "Glass_*" }
  ],
  "nodes": {
    "Z-Axis_Assembly/Z_Top_Idler_Block_CNC": {
      "displayName": "Top Idler",
      "category":    "Accent",
      "hidden":      true
    },
    "Base_Unit_Assembly/Base_Plate": {
      "displayName": "Bottom Plate"
    }
  }
}
```

`autoAssign.match` uses shell-style globs: `*` matches any sequence, `?` matches one character, anchored to the full node name. A category set on a node propagates to all of that node's descendant meshes — categorize a whole assembly with one entry.

For example, `models/Positron_v3.2.2.glb` looks for `models/Positron_v3.2.2.colors.json`.

### Node keys: paths vs. bare leaves

The canonical key format for `nodes` is the slash-joined path from the visual root. Bare leaf names (no slash) are accepted as a forgiveness fallback — they resolve via the same name-cleaning logic as the conversion pipeline (strips path prefixes, `.step` suffixes, `(mesh)`/`(group)` suffixes) and will retry with a trailing `-N` numeric suffix stripped. Bare-leaf keys log a console warning to nudge you toward paths.

### Quick Setup

Run `dump_parts.py` to generate the two sidecar files from a GLB:

```sh
python3 model_converter/dump_parts.py model.glb              # writes model.colors.json + model.scaffold.json
python3 model_converter/dump_parts.py model.glb -o out.json  # writes out.colors.json + out.scaffold.json
```

The tool writes:

- **`model.colors.json`** (live config) — a clean starter template. Skipped if the file already exists, so your edits are safe to re-run over.
- **`model.scaffold.json`** (reference) — `_groups`, `_parts`, and `_nodes` (path → current name, in tree order). Always overwritten. Copy from this file while editing the live one — paths into the `nodes` map, names into `autoAssign` glob inputs.

## Future Possibilities...

??? ask! pull request!

## Credits

The general look and feel was shamelessly copied, with love, from the VERY GOOD [A4T Configurator](https://a4t.dwtas.net/) for the [A4T from Armchair Heavy Industries](https://github.com/Armchair-Heavy-Industries/A4T).