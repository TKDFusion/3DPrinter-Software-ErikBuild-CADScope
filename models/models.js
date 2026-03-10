// ABOUTME: Model manifest defining available assemblies for the viewer.
// ABOUTME: Single source of truth for model paths, display names, colors, and project links.

/**
 * ADDING A NEW MODEL:
 * 1. Convert your STEP file to GLB using model_converter/convert.sh
 * 2. Optionally create a .colors.json sidecar (use model_converter/dump_parts.py)
 * 3. Place files in models/
 * 4. Add an entry below — order in the array determines order in the dropdown
 *
 * FIELDS:
 *   id          - Unique identifier, used in URL query strings
 *   name        - Display name shown in the Assembly dropdown and scene tree root
 *   model       - Path to the .glb file (relative to web root)
 *   colors      - Path to the .colors.json file, or null if none
 *   github      - URL to the project's GitHub repo, or null
 *   github_text - Link text for the GitHub link, or null
 */
export const models = [
  {
    id: "Positron_v3.2.2",
    name: "Positron v3.2.2",
    model: "models/Positron_v3.2.2.glb",
    colors: "models/Positron_v3.2.2.colors.json",
    github: "https://github.com/Positron3D/Positron",
    github_text: "Positron V3.2.2 by Positron3D on GitHub"
  }
];
