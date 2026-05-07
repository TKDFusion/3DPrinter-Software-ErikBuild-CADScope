// ABOUTME: Core viewer application for the CADScope 3D assembly viewer.
// ABOUTME: Handles Three.js scene, model loading, color sets, scene tree, and camera controls.
import * as THREE from 'https://unpkg.com/three@0.164.1/build/three.module.js';
import { OrbitControls } from 'https://unpkg.com/three@0.164.1/examples/jsm/controls/OrbitControls.js';
import { RGBELoader } from "https://unpkg.com/three@0.164.1/examples/jsm/loaders/RGBELoader.js";
import { GLTFLoader } from 'https://unpkg.com/three@0.164.1/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'https://unpkg.com/three@0.164.1/examples/jsm/loaders/DRACOLoader.js';
import { models } from '../models/models.js';
import {
  writeShareToParams,
  readShareFromParams,
  walkNodes,
  paletteName,
  collectColorOverrides,
} from './cadscope_state.js';

const hdriLocation = "./assets/bg.hdr";
const loadingPhrases = [
  'Reticulating splines',
  'Realigning the dilithium crystals',
  'Downloading more RAM',
  'Getting more DDR5 from the back of a truck',
  'Bribing the hamsters',
  'Summoning the ancient ones',
  'Consulting the oracle',
  'Sharpening the voxels',
  'Asking Jeeves',
  'Blowing on the cartridge',
  'Synchronizing quantum entanglement buffers',
  'Resolving cascading temporal anomalies',
  'Almost done (lying)',
  'This is taking longer than expected (it isn\u2019t)',
  'Please enjoy this interstitial moment',
];
let scene, camera, renderer, controls, canvas, pmrem;

const loadingManager = new THREE.LoadingManager();

canvas = document.getElementById('viewer');
renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(canvas.clientWidth, canvas.clientHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputEncoding = THREE.sRGBEncoding;
renderer.toneMappingExposure = 0.5;

scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0c10);

const BASE_BRIGHTNESS = 1.0;
const DEFAULT_BRIGHTNESS_SCALE = 1.5;

const light = new THREE.AmbientLight(0xffffff);
scene.add(light);
const hemi = new THREE.HemisphereLight(0xffffff, 0x222222, BASE_BRIGHTNESS * DEFAULT_BRIGHTNESS_SCALE);
scene.add(hemi);
  
const dir = new THREE.DirectionalLight(0xffffff, BASE_BRIGHTNESS * DEFAULT_BRIGHTNESS_SCALE);
dir.position.set(5, 10, 7);
scene.add(dir);

const dirFill = new THREE.DirectionalLight(0xffffff, BASE_BRIGHTNESS * DEFAULT_BRIGHTNESS_SCALE);
dirFill.position.set(-5, -10, -7);
scene.add(dirFill);

// Brightness control scales all lights relative to their base intensities
const baseLightIntensities = [
  { light: hemi, base: BASE_BRIGHTNESS },
  { light: dir, base: BASE_BRIGHTNESS },
  { light: dirFill, base: BASE_BRIGHTNESS }
];

document.getElementById('brightnessSlider').addEventListener('input', (e) => {
  const scale = e.target.value / 100;
  for (const { light, base } of baseLightIntensities) {
    light.intensity = base * scale;
  }
  requestRender();
});

pmrem = new THREE.PMREMGenerator(renderer);

camera = new THREE.PerspectiveCamera(45, canvas.clientWidth / canvas.clientHeight, 0.1, 1000);
camera.position.set(0.5, 0.5, 0.5);

controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

// Render-on-demand: schedule one render per animation frame; OrbitControls
// fires 'change' synchronously inside controls.update() while damping is
// settling, so the natural feedback loop quiesces when the camera stops.
let renderQueued = false;
function requestRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    controls.update();
    renderer.render(scene, camera);
  });
}
controls.addEventListener('change', requestRender);

// Store model bounds globally for view controls
let modelCenter = new THREE.Vector3();
let modelSize = 1;

new RGBELoader(loadingManager).load(
  hdriLocation,
  (texture) => {
      const envMap = pmrem.fromEquirectangular(texture).texture;
      scene.environment = envMap;
      texture.dispose();
      requestRender();
  },
  (xhr) => {
      if (xhr.total) {
          const pct = Math.min(99, Math.round((xhr.loaded / xhr.total) * 100));
          //loaderUI.set(pct);
      }
  },
  (err) => {
      console.error("HDRI load error:", err);
      //loaderUI.fail("Env map failed");
      // Don’t block forever:
      //setTimeout(() => loaderUI.hide(), 1200);
  }
);

// Draco loader for compressed geometry
const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');
dracoLoader.setDecoderConfig({ type: 'js' });

const gltfLoader = new GLTFLoader();
gltfLoader.setDRACOLoader(dracoLoader);

let currentModel = null;
let currentEntry = null;
let loadGeneration = 0;
// Per-category state: category name -> array of meshes / color picker input
const categoryMeshes = new Map();
const categoryPickers = new Map();
let currentColorSet = null;
let currentLookups = null;

// Selection state for tree-to-3D highlighting
let selectedObj = null;
let selectedTreeItem = null;
const savedEmissives = new Map();
const HIGHLIGHT_COLOR = new THREE.Color(0x3388ff);

// Isolation state
let isolatedObj = null;
let isolatedTreeItem = null;

function highlightObject(obj) {
  obj.traverse((child) => {
    if (!child.isMesh) return;
    if (!child.material._cadScopeCloned) {
      child.material = child.material.clone();
      child.material._cadScopeCloned = true;
    }
    savedEmissives.set(child, child.material.emissive.clone());
    child.material.emissive.copy(HIGHLIGHT_COLOR);
  });
  requestRender();
}

function unhighlightObject() {
  savedEmissives.forEach((original, mesh) => {
    mesh.material.emissive.copy(original);
  });
  savedEmissives.clear();
  if (selectedTreeItem) selectedTreeItem.classList.remove('selected');
  selectedObj = null;
  selectedTreeItem = null;
  requestRender();
}

// Populate model select from manifest
const modelSelect = document.getElementById('modelSelect');
const githubLink = document.querySelector('.header-links a');
models.forEach((entry, i) => {
  const opt = document.createElement('option');
  opt.value = entry.id;
  opt.textContent = entry.name;
  modelSelect.appendChild(opt);
});

function findModel(id) {
  return models.find(m => m.id === id) || models[0];
}

function updateGithubLink(entry) {
  if (entry.github) {
    githubLink.href = entry.github;
    githubLink.textContent = entry.github_text || 'GitHub';
    githubLink.style.display = '';
  } else {
    githubLink.style.display = 'none';
  }
}

// URL query string support. ?model=ID stays plain-text for readability;
// share state goes into one URL param per non-default field
// (?c=<colors>&h=<hidden>&i=<isolate>) via the share-link codec.
function updateURL() {
  const params = new URLSearchParams();
  params.set('model', currentEntry ? currentEntry.id : models[0].id);
  if (currentLookups) {
    const pickerValues = new Map();
    for (const [name, picker] of categoryPickers) pickerValues.set(name, picker.value);
    const colorOverrides = collectColorOverrides(currentLookups, pickerValues);
    const isolatedNode = isolatedObj ? indexOfNode(isolatedObj) : null;
    // Skip hidden-state diffing while isolated — isolate clobbers visibility
    // on every off-chain node, which would explode the encoded URL.
    const hiddenNodes = isolatedObj ? [] : collectHiddenIndices();
    const shareState = {};
    if (colorOverrides.length) shareState.colorOverrides = colorOverrides;
    if (hiddenNodes.length)    shareState.hiddenNodes    = hiddenNodes;
    if (isolatedNode != null && isolatedNode >= 0) shareState.isolatedNode = isolatedNode;
    writeShareToParams(shareState, params);
  }
  history.replaceState(null, '', '?' + params.toString());
}

// Diff live node visibility against the sidecar's defaultConfiguration.
function collectHiddenIndices() {
  if (!currentModel || !currentLookups) return [];
  const out = [];
  const nodes = walkNodes(currentModel);
  // Build a path-of-node helper using the same extendPath logic as buildTree.
  const root = visualRoot(currentModel);
  const cache = new WeakMap();
  function pathOf(obj) {
    if (cache.has(obj)) return cache.get(obj);
    let p = '';
    if (obj.parent && obj.parent !== root) p = pathOf(obj.parent);
    p = extendPath(p, obj.name);
    cache.set(obj, p);
    return p;
  }
  nodes.forEach((node, idx) => {
    const entry = lookupNode(currentLookups, pathOf(node));
    const sidecarHidden = entry?.hidden === true;
    const liveHidden = node.visible === false;
    if (liveHidden !== sidecarHidden) out.push(idx);
  });
  return out;
}

function indexOfNode(obj) {
  if (!currentModel) return -1;
  return walkNodes(currentModel).indexOf(obj);
}

function nodeAtIndex(idx) {
  if (!currentModel || idx == null || idx < 0) return null;
  return walkNodes(currentModel)[idx] || null;
}

const urlParams = new URLSearchParams(window.location.search);
const urlModel = urlParams.get('model');
if (urlModel && models.some(m => m.id === urlModel)) {
  modelSelect.value = urlModel;
}
// Decode share state once at startup; `applySharedState` consumes it after
// the model has loaded and the tree is built. readShareFromParams returns
// {} when there are no codec params; null when present-but-malformed.
let pendingShareState = readShareFromParams(urlParams);
if (pendingShareState === null) {
  console.warn('Share-link payload is malformed. Ignoring.');
  pendingShareState = {};
}
// Tracked separately because `{}` is truthy — used by the legacy color-param
// fallback path to know whether codec params were actually provided.
const codecParamsPresent = Object.keys(pendingShareState).length > 0;
// Legacy back-compat (one release): old per-category color params like
// ?Main=ff6600 still apply if no `?c=` is present.
let urlColorsConsumed = false;

// Populate URL immediately with current model selection
updateURL();

document.getElementById('copyLinkBtn').addEventListener('click', () => {
  navigator.clipboard.writeText(window.location.href).then(() => {
    const btn = document.getElementById('copyLinkBtn');
    const original = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = original; }, 1500);
  });
});

document.getElementById('resetColorsBtn').addEventListener('click', () => {
  if (!currentLookups || !currentModel) return;
  for (const [name, entry] of currentLookups.palette) {
    const picker = categoryPickers.get(name);
    if (picker) picker.value = entry.color;
    const c = new THREE.Color(entry.color);
    (categoryMeshes.get(name) || []).forEach((mesh) => {
      mesh.material.color.copy(c);
      mesh.material.metalness = entry.metalness;
      mesh.material.opacity = entry.opacity;
      mesh.material.transparent = entry.opacity < 1.0;
    });
  }
  updateURL();
  requestRender();
});

function cleanNodeName(name) {
  if (!name) return '';
  // Strip path prefixes (keep text after last /)
  let cleaned = name.includes('/') ? name.substring(name.lastIndexOf('/') + 1) : name;
  // Remove .step suffix (case-insensitive, preserving -N numeric suffixes)
  cleaned = cleaned.replace(/\.step/i, '');
  // Remove (mesh) and (group) suffixes
  cleaned = cleaned.replace(/\s*\(mesh\)\s*/i, '').replace(/\s*\(group\)\s*/i, '');
  // Three.js sanitizeNodeName: spaces → underscores, strip [ ] . : /
  cleaned = cleaned.replace(/ /g, '_').replace(/[\[\].:\/]/g, '');
  return cleaned.trim();
}

function stripNumericSuffix(name) {
  return name.replace(/-\d+$/, '');
}

// Translate a shell-style glob (* and ?) to an anchored regex.
function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const pattern = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp('^' + pattern + '$');
}

// Append a child's cleaned name to a parent path. Empty/nameless components
// are skipped so JS paths match the scaffold emitted by dump_parts.py.
function extendPath(parentPath, childName) {
  const cleaned = cleanNodeName(childName);
  if (!cleaned) return parentPath;
  return parentPath ? `${parentPath}/${cleaned}` : cleaned;
}

// Resolve a sidecar into ready-to-query lookup tables.
// palette: name -> { color, metalness, opacity, showInPicker }
// autoAssign: ordered [{ category, regex }] — first match wins
// nodesByPath: full slash-joined path -> entry
// nodesByLeaf: bare-leaf key -> entry (legacy/forgiveness path)
function buildSidecarLookups(colorSet) {
  const palette = new Map();
  const autoAssign = [];
  const nodesByPath = new Map();
  const nodesByLeaf = new Map();

  if (colorSet?.palette) {
    for (const [name, raw] of Object.entries(colorSet.palette)) {
      palette.set(name, {
        color: raw.color,
        metalness: raw.metalness ?? 0.0,
        opacity: raw.opacity ?? 1.0,
        showInPicker: raw.showInPicker !== false,
      });
    }
  }

  if (Array.isArray(colorSet?.autoAssign)) {
    for (const rule of colorSet.autoAssign) {
      if (!rule || !rule.category || !rule.match) continue;
      if (!palette.has(rule.category)) {
        console.warn(`Sidecar autoAssign rule references category "${rule.category}" which is not defined in palette.`);
      }
      autoAssign.push({ category: rule.category, regex: globToRegExp(rule.match) });
    }
  }

  let warnedAboutLeafKeys = false;
  if (colorSet?.nodes) {
    for (const [key, entry] of Object.entries(colorSet.nodes)) {
      if (entry?.category && !palette.has(entry.category)) {
        console.warn(`Sidecar node "${key}" references category "${entry.category}" which is not defined in palette.`);
      }
      if (key.includes('/')) {
        nodesByPath.set(key, entry);
      } else {
        nodesByLeaf.set(key, entry);
        if (!warnedAboutLeafKeys) {
          console.warn(`Sidecar uses bare-leaf node keys (e.g. "${key}"). Path-based keys are preferred for unambiguous matching.`);
          warnedAboutLeafKeys = true;
        }
      }
    }
  }

  return { palette, autoAssign, nodesByPath, nodesByLeaf };
}

// Look up the sidecar entry for a node by its path. Tries exact-path first,
// then falls back to fuzzy-matched bare-leaf keys (cleaned, then -N stripped).
function lookupNode(lookups, path) {
  if (!lookups) return null;
  const direct = lookups.nodesByPath.get(path);
  if (direct) return direct;
  if (lookups.nodesByLeaf.size === 0) return null;
  const leaf = path.includes('/') ? path.substring(path.lastIndexOf('/') + 1) : path;
  const cleaned = cleanNodeName(leaf);
  return lookups.nodesByLeaf.get(cleaned)
      || lookups.nodesByLeaf.get(stripNumericSuffix(cleaned))
      || null;
}

// Identify the visual root (skip the glTF "Scene" wrapper if present), matching buildTree.
function visualRoot(model) {
  return (model.children.length === 1 && model.name === 'Scene') ? model.children[0] : model;
}

function applyDefaultConfiguration(lookups, model) {
  if (!lookups || (lookups.nodesByPath.size === 0 && lookups.nodesByLeaf.size === 0)) return;
  const root = visualRoot(model);
  function walk(node, path) {
    const entry = lookupNode(lookups, path);
    if (entry?.hidden) node.visible = false;
    if (node.children) {
      for (const child of node.children) {
        walk(child, extendPath(path, child.name));
      }
    }
  }
  for (const child of root.children) {
    walk(child, extendPath('', child.name));
  }
}

function applyColorSet(lookups, model) {
  categoryMeshes.clear();

  // Pre-resolve palette into Three.js Color objects keyed by category name.
  const resolved = new Map();
  for (const [name, entry] of lookups.palette) {
    resolved.set(name, {
      color: new THREE.Color(entry.color),
      metalness: entry.metalness,
      opacity: entry.opacity,
    });
    categoryMeshes.set(name, []);
  }

  // Resolve a node's own category (explicit > autoAssign first match > none).
  function resolveCategory(node, path) {
    const entry = lookupNode(lookups, path);
    if (entry?.category) return entry.category;
    const name = node.name || '';
    for (const rule of lookups.autoAssign) {
      if (rule.regex.test(name)) return rule.category;
    }
    return null;
  }

  // Top-down walk: each node inherits its nearest ancestor's category if it doesn't define its own.
  const warnedMissing = new Set();
  function walk(node, path, inheritedCategory) {
    const myCategory = resolveCategory(node, path) || inheritedCategory;
    if (node.isMesh && myCategory) {
      if (resolved.has(myCategory)) {
        const cat = resolved.get(myCategory);
        node.material = node.material.clone();
        node.material.color.copy(cat.color);
        node.material.roughness = 0.5;
        node.material.metalness = cat.metalness;
        node.material.opacity = cat.opacity;
        node.material.transparent = cat.opacity < 1.0;
        node.material.side = THREE.DoubleSide;
        categoryMeshes.get(myCategory).push(node);
      } else if (!warnedMissing.has(myCategory)) {
        warnedMissing.add(myCategory);
        console.warn(`Sidecar references category "${myCategory}" which is not defined in palette.`);
      }
    }
    if (node.children) {
      for (const child of node.children) {
        walk(child, extendPath(path, child.name), myCategory);
      }
    }
  }

  const root = visualRoot(model);
  for (const child of root.children) {
    walk(child, extendPath('', child.name), null);
  }
}

function fetchColorSet(entry) {
  if (!entry.colors) return Promise.resolve(null);
  return fetch(entry.colors)
    .then((res) => res.ok ? res.json() : null)
    .catch(() => null);
}

function buildColorPickerUI(lookups) {
  const colorControls = document.getElementById('colorControls');
  colorControls.innerHTML = '';
  categoryPickers.clear();
  const heading = document.createElement('h3');
  heading.textContent = 'Colors';
  colorControls.appendChild(heading);
  for (const [name, entry] of lookups.palette) {
    if (!entry.showInPicker) continue;

    const row = document.createElement('div');
    row.className = 'color-row';

    const label = document.createElement('label');
    label.textContent = name;

    const picker = document.createElement('input');
    picker.type = 'color';
    picker.value = entry.color;

    // Legacy back-compat: apply old-style ?Category=hex params on first load,
    // but only when no codec params were supplied. The codec path runs as
    // applySharedColors after this function returns and would override anyway.
    if (!urlColorsConsumed && !codecParamsPresent && name !== 'model') {
      const urlVal = urlParams.get(name);
      if (urlVal) {
        const override = '#' + urlVal;
        picker.value = override;
        const c = new THREE.Color(override);
        (categoryMeshes.get(name) || []).forEach((mesh) => { mesh.material.color.copy(c); });
      }
    }

    picker.addEventListener('input', () => {
      const c = new THREE.Color(picker.value);
      const meshes = categoryMeshes.get(name) || [];
      meshes.forEach((mesh) => { mesh.material.color.copy(c); });
      updateURL();
      requestRender();
    });

    row.appendChild(label);
    row.appendChild(picker);
    colorControls.appendChild(row);
    categoryPickers.set(name, picker);
  }

  urlColorsConsumed = true;
  colorControls.style.display = '';
}

function disposeObject(obj) {
  obj.traverse((child) => {
    if (child.isMesh) {
      child.geometry?.dispose();
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      for (const mat of materials) {
        if (!mat) continue;
        for (const value of Object.values(mat)) {
          if (value && value.isTexture) value.dispose();
        }
        mat.dispose();
      }
    }
  });
}

function loadModel(id) {
  const entry = findModel(id);
  currentEntry = entry;

  // Remove and dispose previous model
  if (currentModel) {
    scene.remove(currentModel);
    disposeObject(currentModel);
    currentModel = null;
  }

  // Track load generation so stale callbacks are ignored
  const thisGeneration = ++loadGeneration;

  // Update header GitHub link for this model's project
  updateGithubLink(entry);

  // Hide color controls while loading
  document.getElementById('colorControls').style.display = 'none';

  // Show loading indicator
  const overlay = document.getElementById('loadingOverlay');
  const loadingText = document.getElementById('loadingText');
  const processingLine = document.getElementById('processingLine');
  const processingText = document.getElementById('processingText');
  overlay.classList.remove('hidden');
  processingLine.classList.add('hidden');
  loadingText.textContent = 'Retrieving 3D model...';

  gltfLoader.load(entry.model, (gltf) => {
    // A newer load was started — discard this result
    if (thisGeneration !== loadGeneration) return;

    currentModel = gltf.scene;
    scene.add(currentModel);

    const box = new THREE.Box3().setFromObject(currentModel);
    modelSize = box.getSize(new THREE.Vector3()).length();
    modelCenter = box.getCenter(new THREE.Vector3());

    // Scale clipping planes to model size
    camera.near = modelSize * 0.001;
    camera.far = modelSize * 100;

    controls.target.copy(modelCenter);
    const direction = new THREE.Vector3();
    direction.subVectors(camera.position, controls.target).normalize();
    camera.position.set(
        modelCenter.x + modelSize,
        modelCenter.y + modelSize,
        modelCenter.z + modelSize
    );
    camera.lookAt(modelCenter);
    camera.up.set(0, 1, 0);
    camera.updateProjectionMatrix();   

    fetchColorSet(entry).then((colorSet) => {
      if (thisGeneration !== loadGeneration) return;
      const colorControls = document.getElementById('colorControls');
      if (colorSet) {
        currentColorSet = colorSet;
        currentLookups = buildSidecarLookups(colorSet);
        applyDefaultConfiguration(currentLookups, currentModel);
        applyColorSet(currentLookups, currentModel);
        buildTree(currentModel, entry.name, pendingShareState);
        buildColorPickerUI(currentLookups);
        applySharedColors(pendingShareState);
      } else {
        currentColorSet = null;
        currentLookups = null;
        buildTree(currentModel, entry.name, pendingShareState);
        colorControls.style.display = 'none';
      }
      pendingShareState = null;
      updateURL();
      overlay.classList.add('hidden');
      requestRender();
    });
  }, (progress) => {
    if (progress.total) {
      const pct = Math.min(100, progress.loaded / progress.total * 100).toFixed(0);
      loadingText.textContent = `Retrieving 3D model... ${pct}%`;
      if (pct >= 100 && processingLine.classList.contains('hidden')) {
        processingText.textContent = loadingPhrases[Math.floor(Math.random() * loadingPhrases.length)] + '...';
        processingLine.classList.remove('hidden');
      }
    }
  }, (error) => {
    console.error('Error loading model:', error);
    loadingText.textContent = 'Failed to load model.';
  });
}

window.loadModel = loadModel;

// Model selector
modelSelect.addEventListener('change', () => loadModel(modelSelect.value));

// Load the initially selected model
loadModel(modelSelect.value);

// Applies pending share-state color overrides after the picker UI is built.
function applySharedColors(state) {
  if (!state?.colorOverrides || !currentLookups) return;
  for (const [paletteIdx, hex6] of state.colorOverrides) {
    const name = paletteName(currentLookups, paletteIdx);
    if (!name) continue;
    const fullHex = '#' + hex6;
    const picker = categoryPickers.get(name);
    if (picker) picker.value = fullHex;
    const c = new THREE.Color(fullHex);
    (categoryMeshes.get(name) || []).forEach((mesh) => mesh.material.color.copy(c));
  }
}

function buildTree(sceneRoot, rootLabel, pendingState) {
  unhighlightObject();
  isolatedObj = null;
  isolatedTreeItem = null;
  const treeContainer = document.getElementById('tree');
  treeContainer.innerHTML = '';

  // Skip the glTF "Scene" wrapper — start from its first child
  const root = (sceneRoot.children.length === 1 && sceneRoot.name === 'Scene')
    ? sceneRoot.children[0]
    : sceneRoot;

  // Map Three.js objects to their tree item DOM elements for syncing
  const objToTreeItem = new Map();

  // Slash-joined cleaned-name path from the visual root (root excluded), with
  // empty/nameless components skipped to match dump_parts.py's scaffold paths.
  // Cached per object.
  const lookups = currentLookups;
  const pathCache = new WeakMap();
  function pathOf(obj) {
    if (pathCache.has(obj)) return pathCache.get(obj);
    let path = '';
    if (obj.parent && obj.parent !== root) {
      path = pathOf(obj.parent);
    }
    path = extendPath(path, obj.name);
    pathCache.set(obj, path);
    return path;
  }

  function syncTreeItemVisibility(treeItem, visible) {
    const cb = treeItem._checkbox;
    if (cb) {
      cb.checked = visible;
      if (visible) {
        treeItem.classList.remove('hidden');
      } else {
        treeItem.classList.add('hidden');
      }
    }
  }

  function isAncestorOf(ancestor, obj) {
    let current = obj.parent;
    while (current) {
      if (current === ancestor) return true;
      current = current.parent;
    }
    return false;
  }

  function isolateNode(obj, treeItem) {
    if (isolatedObj === obj) {
      // Un-isolate: restore everything to visible
      unisolateAll();
      return;
    }

    // Clear previous isolation marker
    if (isolatedTreeItem) isolatedTreeItem.classList.remove('isolated');

    isolatedObj = obj;
    isolatedTreeItem = treeItem;
    treeItem.classList.add('isolated');

    // Walk the entire scene tree and set visibility
    function setVisibility(node) {
      const item = objToTreeItem.get(node);
      if (node === obj || isAncestorOf(obj, node)) {
        // Descendant of isolated node or the node itself — show
        node.visible = true;
        if (item) syncTreeItemVisibility(item, true);
      } else if (isAncestorOf(node, obj)) {
        // Ancestor of isolated node — show (so descendants render)
        node.visible = true;
        if (item) syncTreeItemVisibility(item, true);
      } else {
        // Everything else — hide
        node.visible = false;
        if (item) syncTreeItemVisibility(item, false);
      }
      if (node.children) {
        node.children.forEach(child => setVisibility(child));
      }
    }

    setVisibility(root);
    updateURL();
    requestRender();
  }

  function unisolateAll() {
    if (isolatedTreeItem) isolatedTreeItem.classList.remove('isolated');
    isolatedObj = null;
    isolatedTreeItem = null;

    // Restore all nodes to visible
    function restoreVisibility(node) {
      node.visible = true;
      const item = objToTreeItem.get(node);
      if (item) syncTreeItemVisibility(item, true);
      if (node.children) {
        node.children.forEach(child => restoreVisibility(child));
      }
    }

    restoreVisibility(root);
    updateURL();
    requestRender();
  }

  function createTreeItem(obj, parentElement, depth = 0) {
    const itemDiv = document.createElement('div');
    itemDiv.className = 'tree-item';
    objToTreeItem.set(obj, itemDiv);

    const contentDiv = document.createElement('div');
    contentDiv.className = 'tree-item-content';

    // Toggle arrow for items with children
    const toggleSpan = document.createElement('span');
    toggleSpan.className = 'tree-toggle';
    if (obj.children && obj.children.length > 0) {
      toggleSpan.textContent = depth === 0 ? '▼' : '▶';
    }
    contentDiv.appendChild(toggleSpan);

    // Visibility checkbox
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'tree-checkbox';
    checkbox.checked = obj.visible;
    checkbox.addEventListener('change', (e) => {
      obj.visible = e.target.checked;
      if (e.target.checked) {
        itemDiv.classList.remove('hidden');
      } else {
        itemDiv.classList.add('hidden');
      }
      updateURL();
      requestRender();
    });
    contentDiv.appendChild(checkbox);
    itemDiv._checkbox = checkbox;

    // Object name — click to highlight in 3D view
    const label = document.createElement('span');
    label.className = 'tree-label';
    const entry = lookups ? lookupNode(lookups, pathOf(obj)) : null;
    if (entry?.displayName) {
      label.textContent = entry.displayName;
    } else if (depth === 0 && rootLabel) {
      label.textContent = rootLabel;
    } else {
      label.textContent = obj.name || obj.type || 'Object';
    }
    label.addEventListener('click', (e) => {
      e.stopPropagation();
      if (selectedObj === obj) {
        unhighlightObject();
      } else {
        unhighlightObject();
        selectedObj = obj;
        selectedTreeItem = itemDiv;
        itemDiv.classList.add('selected');
        highlightObject(obj);
      }
    });
    contentDiv.appendChild(label);

    // Isolate button — appears on hover, isolates this node
    const isolateBtn = document.createElement('span');
    isolateBtn.className = 'tree-isolate-btn';
    isolateBtn.textContent = '⊚';
    isolateBtn.title = 'Isolate this node';
    isolateBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      isolateNode(obj, itemDiv);
    });
    contentDiv.appendChild(isolateBtn);

    itemDiv.appendChild(contentDiv);

    // Children container
    if (obj.children && obj.children.length > 0) {
      const childrenDiv = document.createElement('div');
      childrenDiv.className = 'tree-children' + (depth === 0 ? ' expanded' : '');

      // Add toggle functionality
      toggleSpan.addEventListener('click', () => {
        childrenDiv.classList.toggle('expanded');
        toggleSpan.textContent = childrenDiv.classList.contains('expanded') ? '▼' : '▶';
      });

      // Recursively add children
      obj.children.forEach(child => {
        createTreeItem(child, childrenDiv, depth + 1);
      });

      itemDiv.appendChild(childrenDiv);
    }

    parentElement.appendChild(itemDiv);
  }

  createTreeItem(root, treeContainer);

  // Apply pending share state — hidden visibility flips and isolated node.
  // Color overrides are applied separately after buildColorPickerUI runs.
  if (pendingState) {
    const allNodes = walkNodes(sceneRoot);
    if (Array.isArray(pendingState.hiddenNodes)) {
      for (const idx of pendingState.hiddenNodes) {
        const node = allNodes[idx];
        if (!node) continue;
        // Flip visibility from sidecar default. The collect side emits indices
        // where live differs from sidecar — flipping here recreates the saved
        // state on top of the sidecar's already-applied default.
        node.visible = !node.visible;
        const item = objToTreeItem.get(node);
        if (item) syncTreeItemVisibility(item, node.visible);
      }
    }
    if (pendingState.isolatedNode != null) {
      const node = allNodes[pendingState.isolatedNode];
      const item = node ? objToTreeItem.get(node) : null;
      if (node && item) isolateNode(node, item);
    }
  }
}

// Scene tree search — filters and highlights matching nodes
const treeSearch = document.getElementById('treeSearch');
const treeSearchClear = document.getElementById('treeSearchClear');
const searchWrapper = treeSearch.parentElement;
let searchDebounce = null;

function onSearchInput() {
  searchWrapper.classList.toggle('has-value', treeSearch.value.length > 0);
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => filterTree(treeSearch.value), 150);
}
treeSearch.addEventListener('input', onSearchInput);

treeSearchClear.addEventListener('click', () => {
  treeSearch.value = '';
  searchWrapper.classList.remove('has-value');
  filterTree('');
  treeSearch.focus();
});

function filterTree(query) {
  const tree = document.getElementById('tree');
  const allItems = tree.querySelectorAll('.tree-item');
  const q = query.trim().toLowerCase();

  if (!q) {
    // Clear search state and collapse all except top-level node
    allItems.forEach(item => {
      item.classList.remove('search-match', 'search-hidden');
    });
    tree.querySelectorAll('.tree-children').forEach(div => {
      const isTopLevel = div.parentElement.parentElement === tree;
      const toggle = div.parentElement.querySelector(':scope > .tree-item-content > .tree-toggle');
      if (isTopLevel) {
        div.classList.add('expanded');
        if (toggle) toggle.textContent = '▼';
      } else {
        div.classList.remove('expanded');
        if (toggle) toggle.textContent = '▶';
      }
    });
    return;
  }

  // Bottom-up: process deepest nodes first so we can propagate upward.
  // querySelectorAll returns document order (top-down), so reverse it.
  const items = Array.from(allItems).reverse();

  items.forEach(item => {
    const label = item.querySelector(':scope > .tree-item-content > .tree-label');
    const nameMatches = label && label.textContent.toLowerCase().includes(q);
    const childItems = item.querySelectorAll(':scope > .tree-children > .tree-item:not(.search-hidden)');
    const hasVisibleChild = childItems.length > 0;

    if (nameMatches || hasVisibleChild) {
      item.classList.remove('search-hidden');
      item.classList.toggle('search-match', nameMatches);

      // Auto-expand to reveal matches in children
      if (hasVisibleChild) {
        const childrenDiv = item.querySelector(':scope > .tree-children');
        const toggle = item.querySelector(':scope > .tree-item-content > .tree-toggle');
        if (childrenDiv && !childrenDiv.classList.contains('expanded')) {
          childrenDiv.classList.add('expanded');
          if (toggle) toggle.textContent = '▼';
        }
      }
    } else {
      item.classList.add('search-hidden');
      item.classList.remove('search-match');
    }
  });
}

// View control function
window.setView = function(view) {
  const distance = modelSize * 1.5;
  controls.target.copy(modelCenter);

  switch(view) {
    case 'top':
      camera.position.set(modelCenter.x, modelCenter.y + distance, modelCenter.z);
      camera.up.set(0, 0, -1);
      break;
    case 'bottom':
      camera.position.set(modelCenter.x, modelCenter.y - distance, modelCenter.z);
      camera.up.set(0, 0, 1);
      break;
    case 'front':
      camera.position.set(modelCenter.x, modelCenter.y, modelCenter.z + distance);
      camera.up.set(0, 1, 0);
      break;
    case 'back':
      camera.position.set(modelCenter.x, modelCenter.y, modelCenter.z - distance);
      camera.up.set(0, 1, 0);
      break;
    case 'right':
      camera.position.set(modelCenter.x + distance, modelCenter.y, modelCenter.z);
      camera.up.set(0, 1, 0);
      break;
    case 'left':
      camera.position.set(modelCenter.x - distance, modelCenter.y, modelCenter.z);
      camera.up.set(0, 1, 0);
      break;
    case 'home':
      camera.position.set(
        modelCenter.x + modelSize,
        modelCenter.y + modelSize,
        modelCenter.z + modelSize
      );
      camera.up.set(0, 1, 0);
      break;
  }

  camera.lookAt(modelCenter);
  camera.updateProjectionMatrix();
  requestRender();
};

// Zoom function
window.zoom = function(factor) {
  // Calculate direction from target to camera
  const direction = new THREE.Vector3();
  direction.subVectors(camera.position, controls.target);

  // Scale the direction by the factor
  const newDistance = direction.length() * (1 + factor);

  // Prevent zooming too close or too far
  const minDistance = modelSize * 0.1;
  const maxDistance = modelSize * 10;

  if (newDistance >= minDistance && newDistance <= maxDistance) {
    direction.normalize().multiplyScalar(newDistance);
    camera.position.copy(controls.target).add(direction);
    camera.updateProjectionMatrix();
    requestRender();
  }
};

// Reset zoom to default distance
window.resetZoom = function() {
  const direction = new THREE.Vector3();
  direction.subVectors(camera.position, controls.target).normalize();
  camera.position.copy(controls.target).add(direction.multiplyScalar(modelSize * 1.5));
  camera.updateProjectionMatrix();
  requestRender();
};


// Initial render — every interactive control invalidates via requestRender()
// from here on, so this is the only unconditional draw.
requestRender();

window.addEventListener('resize', () => {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  requestRender();
});
