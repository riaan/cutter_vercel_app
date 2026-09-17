import { ShapeEditor, flatten, mapPts } from './editor.js';
import { CutterViewer } from './viewer.js';
import { importSVG } from './svgimport.js';
import { importSTL } from './stlimport.js';
import { PRESETS, PRESET_SIZE_MM } from './presets.js';
import { packProject, unpackProject, PROJECT_EXT } from './project.js';
import { buildAll, toBinarySTL, offsetPolygon, cleanPolygon, bounds, bridgeShapes, signedArea, simplify,
         unionPolygons, subtractPolygons, loadManifold, manifoldReady, DEFAULT_PARAMS } from './geometry.js';

const $ = (id) => document.getElementById(id);

// Custom tooltips (see the explanation-tooltips section below); declared up here because
// controls whose explanation depends on the active wall are relabelled during start-up.
let tipTarget = null, tipTimer = 0;

// ---------- state ----------
// The drawing is a plate of shapes; the editor owns them. `params` is always the wall settings
// of the shape being edited — it is re-pointed whenever you switch shapes, so every control
// below keeps reading and writing the one object the active shape is built from.
let params = { ...DEFAULT_PARAMS };
let result = null;          // last successful build of the whole plate
let regenTimer = null;

// ---------- editor & viewer ----------
const editor = new ShapeEditor($('drawCanvas'), {
  onChange: onShapeChange,
  rings: ringsFor,
  onSelect: updatePointBar,
  onMenu: openPointMenu,
  onView: syncZoomUI,
  // The guard has no way of saying that it can be lowered, so the toast does it here. A refusal
  // that has nothing to do with the guard — a locked shape — is passed on as it stands.
  onBlock: (msg, overlap = true) => toast(overlap
    ? `${msg} “Allow overlap”, under the shapes list, lets them join instead.`
    : msg),
});
const viewer = new CutterViewer($('viewer'));
params = editor.params;

// Which shape the settings panel was last showing. Switching shapes — from the list, from undo,
// or from opening a file — has to bring its own settings along with it.
let shownLayer = null;

function onShapeChange(shape, { selectionOnly = false } = {}) {
  params = editor.params;
  if (editor.layer.id !== shownLayer) { shownLayer = editor.layer.id; syncShapeContext(); }
  syncSizeInputs(shape.outer);
  const hasOuter = shape.outer.length >= 3;
  const innerBtn = document.querySelector('.seg[data-active=inner]');
  innerBtn.disabled = !hasOuter;
  if (!hasOuter && editor.active === 'inner') setActive('outer');
  updateHint(shape);
  updateShapeBar();
  $('undoBtn').disabled = !editor.canUndo;
  $('redoBtn').disabled = !editor.canRedo;
  $('secInnerWrap').hidden = shape.inner.length < 3;
  syncResetMarks();
  syncWallActions();
  autoBridgeWidth(shape);
  renderShapeList();
  const any = editor.hasAnyShape;
  setSaveEnabled(any);
  $('resultBtn').disabled = !any;
  if (!selectionOnly) scheduleRegen();   // stepping to another shape does not change any solid
}

// Everything that belongs to the shape you are on rather than to the plate: its wall settings,
// its mirror switches and the label that says whose settings the panel is showing.
function syncShapeContext() {
  params = editor.params;
  syncParamInputs();
  syncSymButtons();
  drawProfile();
  refreshSummaries();
}

function syncSymButtons() {
  $('symXBtn').setAttribute('aria-pressed', String(editor.sym.x));
  $('symYBtn').setAttribute('aria-pressed', String(editor.sym.y));
}

// Connection thickness defaults to 10% of the shape's width, rounded to 0.5 mm.
function autoBridgeWidth(shape) {
  if (!editor.layer.bridgeAuto || shape.outer.length < 3) return;
  const w = bounds(shape.outer).width;
  const v = Math.max(0.5, Math.round(w * 0.1 * 2) / 2);
  if (v !== params.bridgeWidth) {
    params.bridgeWidth = v;
    $('pBridgeWidth').value = v;
    editor.requestRender();
  }
}

// The same for a shape the panel is not showing — what resetting several shapes at once needs.
function autoBridgeWidthFor(layer) {
  if (layer === editor.layer) { autoBridgeWidth(editor.getShape()); return; }
  const outer = editor.layerList()[editor.layers.indexOf(layer)]?.outer;
  if (!layer.bridgeAuto || !outer || outer.length < 3) return;
  layer.params.bridgeWidth = Math.max(0.5, Math.round(bounds(outer).width * 0.1 * 2) / 2);
}
$('bridgeAutoBtn').addEventListener('click', () => {
  const on = !editor.layer.bridgeAuto;
  editor.layer.bridgeAuto = on;
  $('bridgeAutoBtn').setAttribute('aria-pressed', String(on));
  if (on) { autoBridgeWidth(editor.getShape()); scheduleRegen(); }
  syncResetMarks();
});

// Offsets for the 2D preview (walls + connections). Every shape has its own walls, so there is
// one entry per shape, kept until that shape or its settings change.
const ringsCache = new Map();
function ringsFor(shape, p, id, rev) {
  const sig = `${rev}|${JSON.stringify(p)}`;
  const hit = ringsCache.get(id);
  if (hit && hit.sig === sig) return hit.rings;
  let rings = null;
  try {
    const bw = p.bladeWidth, baseW = Math.max(bw, p.baseWidth);
    const rw = p.ridge ? Math.min(baseW, Math.max(bw, p.ridgeWidth)) : null;
    const o = shape.outer, i = shape.inner.length >= 3 ? shape.inner : null;
    rings = {
      base: offsetPolygon(o, baseW), ridge: rw ? offsetPolygon(o, rw) : null, blade: offsetPolygon(o, bw),
      innerBase: i ? offsetPolygon(i, -baseW) : null, innerRidge: i && rw ? offsetPolygon(i, -rw) : null,
      innerBlade: i ? offsetPolygon(i, -bw) : null,
      bridges: i ? bridgeShapes(o, i, p) : null,
    };
  } catch { rings = null; }
  ringsCache.set(id, { sig, rings });
  return rings;
}

function syncSizeInputs(points) {
  if (points.length < 3) { $('widthInput').value = ''; $('heightInput').value = ''; return; }
  const b = bounds(points);
  for (const [id, v] of [['widthInput', b.width], ['heightInput', b.height]]) {
    const el = $(id);
    if (document.activeElement !== el) el.value = v.toFixed(1);
  }
}

function updateHint(shape) {
  const hint = $('drawHint'), text = $('drawHintText');
  // A locked shape the panel is still showing comes first: nothing else the hint could suggest
  // can be done to it. This only happens when there is no other shape to step to — every shape
  // on the plate is locked — and then the canvas answering nothing needs a reason.
  if (editor.locked) {
    hint.classList.add('corner');
    text.innerHTML = '<strong>This shape is locked.</strong> Open the padlock in the shapes list to work on it again, or add another shape.';
    hint.hidden = false;
    return;
  }
  // An outline still being placed comes next: nothing else the hint could say matters while
  // the one thing to do is finish it.
  const draft = editor.tool === 'points' ? editor.draft : null;
  if (draft && draft.count >= 1) {
    hint.classList.add('corner');
    text.innerHTML = draft.closable
      ? '<strong>Click the first point to close the shape.</strong> Until then these corners are only a line — there is nothing to cut yet.'
      : '<strong>Keep placing corners.</strong> Three of them make a shape; click the first point again to close it.';
    hint.hidden = false;
  } else if (editor.active === 'inner' && shape.inner.length < 3 && shape.outer.length >= 3) {
    text.innerHTML = '<strong>Draw the inner wall</strong> inside the shape — the area between the two walls is what gets cut out. Sketch it, place corners, or import an SVG that already has a hole.';
    hint.classList.add('corner'); hint.hidden = false;
  } else if (shape.outer.length < 1 && editor.hasAnyShape) {
    // An empty shape next to shapes that are already drawn: say where it may go.
    hint.classList.add('corner');
    text.innerHTML = `<strong>Draw shape ${editor.index + 1}.</strong> Keep it clear of the shapes already on the plate — two cutters that touch come off the printer as one.`;
    hint.hidden = false;
  } else if (shape.outer.length < 1) {
    hint.classList.remove('corner');
    text.innerHTML = '<strong>Draw the shape to cut.</strong> Drag to sketch — the outline closes and smooths itself. Or place corners one by one with <em>Points</em>, pick a starter shape, or import an SVG — or an STL of a cutter you made before.';
    hint.hidden = false;
  } else hint.hidden = true;
}

// ---------- 3D regeneration ----------
function scheduleRegen() {
  clearTimeout(regenTimer);
  regenTimer = setTimeout(regenerate, 120);
}

// The 3D preview and the STL are always the whole plate: every shape, each with its own
// settings, in the place it sits on the canvas. Nothing is greyed out or left out here — this
// is what comes off the printer.
function regenerate() {
  const err = $('errorBox');
  if (!manifoldReady()) return; // the engine calls regenerate() again once loaded
  const parts = editor.buildParts();
  if (!parts.length) {
    result = null; viewer.clearMesh(); err.hidden = true;
    $('viewerHint').hidden = false; setDownloadEnabled(false);
    $('statFootprint').textContent = '—'; $('statHeight').textContent = '—'; $('statTris').textContent = '—';
    setReady('No shape yet');
    return;
  }
  try {
    const built = parts.map(part => {
      const outer = cleanPolygon(part.shape.outer, 0.002);
      if (!outer) throw new Error(`${part.label}: the outline crosses itself too much to make a cutter. Try Undo or Clear.`);
      const inner = part.shape.inner.length >= 3 ? cleanPolygon(part.shape.inner, 0.002) : null;
      return { label: part.label, shape: { outer, inner }, params: part.params };
    });
    result = buildAll(built);
    viewer.setMesh(result.positions, result.bounds);
    err.hidden = true; $('viewerHint').hidden = true;
    setDownloadEnabled(true);
    const f = result.footprint, cm3 = result.volumeMm3 / 1000;
    $('statFootprint').textContent = `${f.width.toFixed(1)} × ${f.height.toFixed(1)} mm`;
    $('statHeight').textContent = `${f.height3d.toFixed(1)} mm`;
    $('statTris').textContent = `${(cm3 * 1.24).toFixed(1)} g`;
    // Shapes that run into each other are built as one solid, so the plate can hold fewer objects
    // than it holds shapes — which is the thing to say, because it is what comes off the printer.
    const objs = result.objects, joined = objs < built.length;
    $('stats').title = `${cm3.toFixed(1)} cm³ · ${result.triangles.toLocaleString()} triangles`
      + (built.length > 1 ? ` · ${built.length} shapes` : '')
      + (joined ? `, joined into ${objs} object${objs === 1 ? '' : 's'}` : '');
    setReady(built.length > 1
      ? `${built.length} shapes${joined ? `, ${objs} object${objs === 1 ? '' : 's'}` : ''} · ready`
      : 'Watertight · ready');
    checkAgainstSaved();
  } catch (e) {
    result = null; viewer.clearMesh(); setDownloadEnabled(false);
    err.textContent = e.message || 'Could not build the cutter.'; err.hidden = false;
    $('viewerHint').hidden = true;
    setReady('Check the wall settings');
  }
}

function setDownloadEnabled(on) { $('downloadBtn').disabled = !on; $('downloadBtnMobile').disabled = !on; }

// ---------- download ----------
function download() {
  if (!result) return;
  const name = ($('fileName').value || 'cutter').trim().replace(/[^\w\-]+/g, '-');
  const buf = toBinarySTL(result.positions, name);
  const blob = new Blob([buf], { type: 'model/stl' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `${name}.stl`; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  const n = result.parts.length, objs = result.objects;
  const what = objs < n ? `${n} shapes joined into ${objs === 1 ? 'one object' : `${objs} objects`}, `
    : n > 1 ? `${n} shapes, ` : '';
  toast(`Saved ${name}.stl — ${what}print it base down, no supports.`);
}
$('downloadBtn').addEventListener('click', download);
$('downloadBtnMobile').addEventListener('click', download);

// A fresh name on every page load, e.g. cutter-k7x2q
$('fileName').value = `cutter-${Math.random().toString(36).slice(2, 7)}`;

// ---------- project files (.cutter) ----------
// Saving writes the drawing and every setting, so opening the file later rebuilds the very
// same cutter. The STL and the two pictures ride along for convenience; only the settings
// are read back.
function fileBaseName() { return ($('fileName').value || 'cutter').trim().replace(/[^\w\-]+/g, '-') || 'cutter'; }

function currentState() {
  return {
    ...editor.getState(),   // every shape, with its own contours, mirror and wall settings
    name: fileBaseName(),
    stats: result ? { width: result.footprint.width, height: result.footprint.height, height3d: result.footprint.height3d } : null,
  };
}

function setSaveEnabled(on) { $('saveProjectBtn').disabled = !on; $('saveProjectBtn2').disabled = !on; }

function saveProject() {
  const name = fileBaseName();
  const files = {};
  if (result) {
    try { files.stl = toBinarySTL(result.positions, name); } catch { /* the STL is a bonus, not the project */ }
    files.png3d = viewer.snapshot(1000, 750) || undefined;
  }
  try { files.png2d = pngBytes(editor.renderPreview(1000, 1000)); } catch { /* same */ }
  const bytes = packProject(currentState(), files);
  saveBlob(new Blob([bytes], { type: 'application/zip' }), name + PROJECT_EXT);
  toast(`Saved ${name}${PROJECT_EXT} — open it later to carry on with the same shape and settings.`);
}

// A canvas as raw PNG bytes (toDataURL is synchronous, which keeps saving one clean step).
function pngBytes(canvas) {
  const url = canvas.toDataURL('image/png');
  const bin = atob(url.slice(url.indexOf(',') + 1));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function openProject(file) {
  let state;
  await showLoader(`Opening ${file.name}…`);
  try {
    state = await unpackProject(await file.arrayBuffer());
  } catch (e) {
    toast(e.message || 'Could not open that project file.');
    return;
  } finally {
    hideLoader();
  }
  const n = state.layers.length;
  const mode = await askImportMode(file, n, 'Open this project?',
    `${file.name} holds ${countShapes(n)}. ${n > 1 ? 'They can' : 'It can'} join what is on the canvas, or take its place — every shape and its settings replaced, which cannot be undone.`);
  if (!mode) return;
  if (mode === 'add') {
    const added = await withLoader('Adding the shapes…', () => addState(state.layers), { build: true });
    toast(`Added ${countShapes(added)} from ${file.name}.`);
  } else {
    await withLoader(`Opening ${file.name}…`, () => applyState(state), { build: true });
    toast(`Opened ${file.name} — ${n > 1 ? `${n} shapes` : 'shape'} and settings restored.`);
  }
  setTimeout(warnIfClashing, 1200);
}

// Adding a file's shapes to the plate instead of opening it: only the shapes come across, each
// with the wall settings the file gave it. Everything that belongs to the plate rather than to a
// shape — the file name, the grid, the tool you are holding — is yours and stays as it is.
// Mirror is the one setting a shape does not get to bring: it turns the whole plate over, so the
// arrivals take the one the plate is already using.
function addState(list) {
  const mirror = editor.params.mirror;
  const n = editor.addLayers(list.map(it => (it.params ? { ...it, params: { ...it.params, mirror } } : it)));
  if (!n) { toast('There were no shapes in that file to add.'); return 0; }
  // Nothing was moved to suit the plate beyond putting the group beside it, so — as with any
  // file — whether the shapes may sit where they now are is read off the drawing.
  adoptOverlapFromDrawing();
  setActive('outer');
  setTool('move');
  renderShapeList();
  editor.requestRender();
  return n;
}

const countShapes = (n) => `${n} shape${n === 1 ? '' : 's'}`;

// The shapes go in first, settings and all; everything after that only follows them.
function applyState(state) {
  shownLayer = null;         // force the settings panel to pick up the shape it lands on
  ringsCache.clear();
  editor.setState(state);
  // A file states where its shapes go and nothing is moved, so the only thing left to settle is
  // whether they are allowed to be there. A file that states the setting is taken at its word;
  // one that cannot — an STL, a project written before the setting existed — is read off the
  // drawing it brought.
  if (typeof state.allowOverlap === 'boolean') { overlapAdopted = false; setOverlapAllowed(state.allowOverlap); }
  else adoptOverlapFromDrawing();
  syncShapeContext();

  $('fileName').value = state.name || 'cutter';
  $('gridSize').value = String(editor.grid.size);
  $('snapBtn').setAttribute('aria-pressed', String(editor.grid.snap));
  setSmoothing(editor.smoothing);
  $('lockBtn').setAttribute('aria-pressed', String(editor.lockAspect));

  setTool(editor.tool);
  setActive(editor.active);
  onParamsChanged();
  renderShapeList();
  editor.requestRender();

  // A saved size that no longer builds the same would mean the geometry changed under the
  // file; say so quietly rather than pretending everything matched.
  if (state.stats) {
    pendingCheck = state.stats;
  }
}

let pendingCheck = null;
function checkAgainstSaved() {
  if (!pendingCheck || !result) return;
  const saved = pendingCheck; pendingCheck = null;
  const off = Math.max(Math.abs(saved.width - result.footprint.width), Math.abs(saved.height - result.footprint.height));
  if (off > 0.05) toast(saved.warning || 'Opened, but this cutter comes out slightly different from when it was saved.');
}

// ---------- opening an STL ----------
// For cutters made before there were project files. A cutter is a stack of prisms, so a cut
// through it hands the outline straight back, and the walls, the steps and the connections are
// measured off the same sections (js/stlimport.js). What an STL cannot hold is how the drawing
// was made: curves come back as the outline they were flattened to, and symmetry is gone.
async function openSTL(file) {
  let res;
  await showLoader(`Reading ${file.name}…`);
  try {
    res = importSTL(await file.arrayBuffer());
  } catch (e) {
    toast(e.message || 'Could not read that STL.');
    return;
  } finally {
    hideLoader();
  }
  const n = res.parts.length;
  const mode = await askImportMode(file, n, 'Open this STL?',
    `${file.name} holds ${countShapes(n)}, with the wall settings read out of the model. ${n > 1 ? 'They can' : 'It can'} join what is on the canvas, or take its place — every shape and its settings replaced, which cannot be undone.`);
  if (!mode) return;
  const notes = res.notes.length ? ' ' + res.notes.join(' ') : '';
  if (mode === 'add') {
    // Each cutter in the file keeps the settings measured off it; its connection thickness was
    // measured too, so it is a typed-in value and not one to work out again.
    const added = await withLoader('Adding the shapes…',
      () => addState(res.parts.map(part => ({ shape: part.shape, params: part.params, bridgeAuto: false }))),
      { build: true });
    toast(`Added ${countShapes(added)} from ${file.name}.` + notes);
    setTimeout(warnIfClashing, 1200);
    return;
  }
  await withLoader(`Rebuilding from ${file.name}…`, () => applyState({
    ...editor.getState(), // the grid, the smoothing and the aspect lock are yours, not the file's
    allowOverlap: null,   // an STL holds no such setting — whether its cutters run into each other does
    // One cutter in the file, one shape on the canvas — each with the settings measured off it.
    layers: res.parts.map(part => ({
      shape: part.shape,
      sym: { x: false, y: false },   // an STL holds whole outlines, never a half to mirror
      symOrigin: { x: 0, y: 0 },
      params: part.params,
      bridgeAuto: false,
    })),
    index: 0,
    active: 'outer',
    tool: 'move',
    name: file.name.replace(/\.stl$/i, '').replace(/[^\w\-]+/g, '-') || 'cutter',
    // the same check a project gets: rebuild it and say so if the result is not that model
    stats: { ...res.footprint, warning: 'Opened, but the cutter this builds comes out slightly different from the STL. Check the wall settings.' },
  }), { build: true });
  toast(describeSTL(file.name, res));
  setTimeout(warnIfClashing, 1200);
}

function describeSTL(name, res) {
  const first = res.parts[0], p = first.params;
  const bits = [`${res.size.width.toFixed(1)} × ${res.size.height.toFixed(1)} mm`];
  if (res.parts.length > 1) bits.unshift(`${res.parts.length} shapes`);
  bits.push(`${p.height} mm tall`);
  if (!first.outlineOnly) {
    bits.push(`${p.bladeWidth} mm blade`);
    if (p.baseHeight > 0) bits.push(`${p.baseWidth} mm base`);
    if (p.ridge) bits.push('support step');
    if (first.shape.inner.length >= 3) bits.push(`${p.bridgeCount} connection${p.bridgeCount === 1 ? '' : 's'}`);
  }
  return `Rebuilt from ${name} — ${bits.join(', ')}.` + (res.notes.length ? ' ' + res.notes.join(' ') : '');
}

$('saveProjectBtn').addEventListener('click', saveProject);
$('saveProjectBtn2').addEventListener('click', saveProject);
const pickProject = () => $('projectInput').click();
$('openProjectBtn').addEventListener('click', pickProject);
$('openProjectBtn2').addEventListener('click', pickProject);
$('projectInput').addEventListener('change', (e) => {
  const file = e.target.files?.[0]; e.target.value = '';
  beginImport(file);
});
setSaveEnabled(false);

// ---------- tools ----------
const TOOL_TIPS = {
  draw: 'Drag to sketch the outline in one go.',
  points: 'Tap to place corners one after the other, then click the first one again to close the shape. Hold and pull as you place one and it comes out curved. After that, tap a line to insert a corner. Hold Alt and pull a corner to redraw its curve from scratch. Select one to delete it or give it a curve; right-click (or hold) for the menu.',
  move: 'Drag the shape to move it — hold Shift to keep it on one line. Use the handles to resize, with Alt to resize around the middle, and the top knob to rotate. Arrow keys nudge it by 1 mm. Two fingers pinch and twist. Click another shape to pick that one up instead; click the empty canvas to put it down.',
};
// The tool explanation stays behind its (i), which sits in the toolbar beside the three tools:
// it is there to be asked for, never to announce itself, so picking a tool only loads the text
// and it is hover (or, on touch, a tap) that brings it out. The text itself floats under the
// icon: placed here rather than in CSS, so opening it never pushes the toolbar about and it
// stays inside the window however narrow it gets.
const TOOL_TIP_HOLD = 5000;   // a tap has no pointerleave to close it, so it times out
let toolTipTimer = 0;
function placeToolTip() {
  const icon = $('toolTipIcon'), text = $('toolTipText');
  const r = icon.getBoundingClientRect(), gap = 6;
  const w = text.offsetWidth, h = text.offsetHeight;   // ignores the slide transform
  const left = Math.min(Math.max(8, r.left), window.innerWidth - w - 8);
  const below = r.bottom + gap;
  const top = below + h > window.innerHeight - 8 ? Math.max(8, r.top - gap - h) : below;
  text.style.left = `${Math.round(left)}px`;
  text.style.top = `${Math.round(top)}px`;
}
function setToolTipOpen(open) {
  if (open) placeToolTip();
  $('toolTip').classList.toggle('collapsed', !open);
  $('toolTipIcon').setAttribute('aria-expanded', String(open));
}
// Switching tools only loads the sentence; whether it is on screen is the pointer's business.
function setToolTipText(text) {
  $('toolTipText').textContent = text;
  if (!$('toolTip').classList.contains('collapsed')) placeToolTip();   // hovering: it just changed width
}
function showToolTip(text) {
  setToolTipText(text);
  setToolTipOpen(true);
  clearTimeout(toolTipTimer);
  toolTipTimer = setTimeout(() => setToolTipOpen(false), TOOL_TIP_HOLD);
}
// It is fixed to the window, so anything that moves the icon has to move the text after it.
const followToolTip = () => { if (!$('toolTip').classList.contains('collapsed')) placeToolTip(); };
window.addEventListener('resize', followToolTip);
window.addEventListener('scroll', followToolTip, true);
$('toolTipIcon').addEventListener('pointerenter', (e) => {
  if (e.pointerType === 'touch') return;          // touch toggles on tap instead
  clearTimeout(toolTipTimer); setToolTipOpen(true);
});
$('toolTipIcon').addEventListener('pointerleave', (e) => {
  if (e.pointerType === 'touch') return;
  clearTimeout(toolTipTimer); setToolTipOpen(false);
});
// Tap (or keyboard) holds it open for the usual few seconds.
$('toolTipIcon').addEventListener('click', () => {
  if ($('toolTip').classList.contains('collapsed')) showToolTip($('toolTipText').textContent);
  else { clearTimeout(toolTipTimer); setToolTipOpen(false); }
});

document.querySelectorAll('.seg[data-tool]').forEach(btn => btn.addEventListener('click', () => setTool(btn.dataset.tool)));
function setTool(tool) {
  editor.setTool(tool);
  document.querySelectorAll('.seg[data-tool]').forEach(b => {
    const on = b.dataset.tool === tool; b.classList.toggle('active', on); b.setAttribute('aria-selected', on);
  });
  setToolTipText(TOOL_TIPS[tool] + (editor.symOn ? ' Only the bright side is editable — the mirror side follows.' : ''));
  updatePointBar(null); updateShapeBar(); updateHint(editor.getShape());
  syncRoundBar(); syncSmoothSection(); closeMenu();
  // Select all and the lock row are the Move tool's; the rows themselves have not changed, so
  // this is the foot's own business and not a redraw of the list.
  syncSelectRow();
  syncWallActions();
}
setTool('draw');

document.querySelectorAll('.seg[data-active]').forEach(btn => btn.addEventListener('click', () => setActive(btn.dataset.active)));
function setActive(which) {
  if (which === 'inner' && !editor.hasOuter) which = 'outer';
  editor.setActive(which);
  document.querySelectorAll('.seg[data-active]').forEach(b => {
    const on = b.dataset.active === which; b.classList.toggle('active', on); b.setAttribute('aria-selected', on);
  });
  syncWallActions();
  updateShapeBar();
  updateHint(editor.getShape());
  syncRoundBar();
}

// Centre, align and flip act on the shapes you have selected — one of them, or several held
// together — and Clear on the wall you are editing. They stay out of the way entirely until
// there is something for them to act on, and a locked shape is out of reach of all of them.
function syncWallActions() {
  const inner = editor.active === 'inner';
  const shape = editor.getShape();
  const hasWall = (inner ? shape.inner : shape.outer).length >= 3;
  // An unfinished outline is not a wall, but it is something: Clear has to be able to get rid
  // of it, and Flip works on the line as it stands.
  const something = hasWall || !!editor.draft;
  const group = editor.selectionCount > 1;
  for (const id of ['centerBtn', 'flipXBtn', 'flipYBtn', 'clearBtn', 'shapeActionsDivider']) $(id).hidden = !(something || group);
  // While the tool is open the canvas is showing a preview, so nothing else may change the shape.
  const rounding = !!editor.rounding;
  const locked = editor.locked;
  // With several shapes held the buttons belong to the group, so they do not care whether the
  // shape the panel happens to be showing has a wall of its own.
  const one = !group && something && !locked && !rounding && editor.picked;
  for (const id of ['flipXBtn', 'flipYBtn']) $(id).disabled = !(group ? !rounding : one);
  $('centerBtn').disabled = group ? rounding : !(one && !inner);
  $('clearBtn').disabled = rounding || locked || !something;
  $('alignHBtn').hidden = $('alignVBtn').hidden = !group;
  for (const id of ['alignHBtn', 'alignVBtn']) $(id).disabled = rounding;
  // Laying the plate out again is a plate-wide tidy-up, so it appears with the second shape and
  // does not care what is selected.
  $('arrangeBtn').hidden = editor.layerCount < 2;
  $('arrangeBtn').disabled = rounding || editor.unlockedCount < 2;
  syncRoundBar();
  // Centring moves the shapes you hold; on its own the inner wall has Align instead.
  $('alignWrap').hidden = !inner || !hasWall || group;
  if ($('alignWrap').hidden) setAlignMenu(false);
  $('alignBtn').disabled = !(shape.outer.length >= 3 && shape.inner.length >= 3) || rounding || locked;
  const n = editor.selectionCount;
  setTip($('flipXBtn'), group
    ? `Flip left–right — mirror the ${n} shapes you are holding about the middle of them: each shape is mirrored and they swap sides with it.`
    : inner
      ? 'Flip left–right — mirror the inner wall horizontally inside the shape. The outer wall is not touched.'
      : 'Flip left–right — mirror the whole shape horizontally, inner wall and all, as if held up to a mirror. The size stays the same.');
  setTip($('flipYBtn'), group
    ? `Flip top–bottom — mirror the ${n} shapes you are holding about the middle of them: each shape is mirrored and they swap places with it.`
    : inner
      ? 'Flip top–bottom — mirror the inner wall vertically inside the shape. The outer wall is not touched.'
      : 'Flip top–bottom — mirror the whole shape vertically, inner wall and all. The size stays the same.');
  const many = editor.layerCount > 1;
  setTip($('clearBtn'), inner
    ? 'Clear — remove the inner wall only. The outer wall stays. You can undo this.'
    : many
      ? `Clear — empty shape ${editor.index + 1}, inner wall included. The other shapes stay. You can undo this.`
      : 'Clear — remove the whole drawing, inner wall included, and start over. You can undo this.');
  setTip($('centerBtn'), group
    ? `Center — move the ${n} shapes you are holding to the middle of the canvas. They keep their places relative to each other.`
    : many
      ? `Center — move shape ${editor.index + 1} to the middle of the canvas. Select the others too (or press ⌘A) to move the whole plate together.`
      : 'Center — move the whole shape to the middle of the canvas. The shape and its size stay the same.');
}
setActive('outer');

// Sketch smoothing lives in the Canvas flyout and belongs to the pen: it is what a freehand
// stroke is cleaned up by when you lift it. Rounding a shape that is already drawn is the
// rounding tool below, which has a dial of its own.
function setSmoothing(v) {
  if (!isFinite(v)) return;
  editor.smoothing = Math.min(1, Math.max(0, v));
  if (document.activeElement !== $('smoothing')) $('smoothing').value = String(editor.smoothing);
  $('smoothingVal').textContent = editor.smoothing.toFixed(2);
}
$('smoothing').addEventListener('input', (e) => setSmoothing(parseFloat(e.target.value)));

// It cleans up a stroke when the pen comes off the canvas, and that is all it does — so under
// the other two tools it is a setting with nothing to act on, and the flyout leaves it out.
function syncSmoothSection() {
  const draw = editor.tool === 'draw';
  $('smoothSection').hidden = !draw;
  $('smoothRule').hidden = !draw;
}

// ---------- the rounding tool ----------
// A mode, not a button that fires: the toolbar toggle opens a slider at the bottom of the canvas
// that bends the corners of the wall being edited while you drag it — on the canvas and in the
// 3D preview — and the mode closes again on Apply or Cancel. It works from all three tools,
// on either wall of whichever shape is selected.
function syncRoundBar() {
  const on = editor.rounding, btn = $('roundToolBtn');
  $('roundBar').hidden = !on;
  document.querySelector('.canvas-wrap').classList.toggle('with-smooth', !!on);
  btn.setAttribute('aria-pressed', String(!!on));
  btn.disabled = !on && !editor.canRound;
  const wall = editor.active === 'inner' ? 'inner wall' : 'outer wall';
  setTip(btn, btn.disabled
    ? 'Round corners — draw a wall first, then this bends its corners.'
    : on
      ? 'Round corners — close the slider and leave the shape as it was.'
      : `Round corners — bend the corners of the ${wall} of this shape. A slider comes up at the bottom of the canvas and the shape follows it as you drag; nothing is settled until you press Apply.`);
  if (!on) return;
  $('roundName').textContent = editor.layerCount > 1 ? `Round shape ${editor.index + 1} · ${wall}` : `Round ${wall}`;
  setField('roundRange', on.amount);
  $('roundNow').textContent = on.amount.toFixed(2);
  setTip($('roundLabel'), on.kind === 'anchors'
    ? 'How round the corners are — left leaves them sharp, right bends them into a full curve. The corners you placed stay where they are and keep their handles, so you can still move them afterwards. A curve bulges past its corner, so the shape grows a little as you slide.'
    : 'How round the corners are — left leaves this outline as it is, right cuts its corners back into a smooth line. It has far too many points to be a set of corners, so it is smoothed as a line rather than curved corner by corner.');
}

$('roundToolBtn').addEventListener('click', () => {
  if (editor.rounding) { editor.cancelRound(); return; }
  if (editor.beginRound() === null) return;
  syncRoundBar();
  $('roundRange').focus();
});
$('roundRange').addEventListener('input', (e) => {
  editor.setRound(parseFloat(e.target.value));
  $('roundNow').textContent = (editor.rounding?.amount ?? 0).toFixed(2);
});
// The slider has focus while you are using it, and the canvas shortcuts stay out of a focused
// input — so the two keys that close the mode are answered here as well. The arrow keys are the
// slider's own, and nudge the rounding like any other range.
$('roundRange').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); $('roundApplyBtn').click(); }
  else if (e.key === 'Escape') { e.preventDefault(); editor.cancelRound(); }
  e.stopPropagation();
});
$('roundApplyBtn').addEventListener('click', () => {
  if (editor.applyRound()) toast('Corners rounded. Undo puts them back.');
});
$('roundCancelBtn').addEventListener('click', () => editor.cancelRound());

// Center, Align and Flip act on what is held: one shape, or the group. Everything that can
// refuse — a shape that would land on a neighbour — says so itself through onBlock.
$('centerBtn').addEventListener('click', () => {
  const n = editor.selectionCount;
  if (editor.centerSelection() && n > 1) toast(`${n} shapes centred together — they keep their places relative to each other.`);
});
$('flipXBtn').addEventListener('click', () => flipHeld('x'));
$('flipYBtn').addEventListener('click', () => flipHeld('y'));
function flipHeld(axis) {
  const n = editor.selectionCount;
  if (n > 1) { if (editor.flipSelection(axis)) toast(`${n} shapes flipped ${axis === 'x' ? 'left–right' : 'top–bottom'}. You can undo this.`); }
  else editor.flip(axis);
}
$('alignHBtn').addEventListener('click', () => alignHeld('h'));
$('alignVBtn').addEventListener('click', () => alignHeld('v'));
function alignHeld(axis) {
  const n = editor.selectionCount;
  if (editor.alignSelection(axis)) toast(`${n} shapes lined up on one ${axis === 'h' ? 'horizontal' : 'vertical'} line.`);
}

// Laying the plate out again: every shape that is not locked goes into rows in the middle of the
// canvas, clear of its neighbours — which is only true while overlapping is not allowed, so the
// setting goes off with it. That part is not undoable, so a plate that is using it is asked first.
$('arrangeBtn').addEventListener('click', async () => {
  if (editor.allowOverlap) {
    const ok = await confirmAction('Lay the shapes out again?',
      'They go into rows in the middle of the canvas, each one clear of its neighbours — so “Allow overlap” goes off with it. Locked shapes stay where they are. The move itself can be undone.', 'Arrange');
    if (!ok) return;
  }
  const n = editor.arrangeShapes();
  if (!n) { toast('Nothing to lay out — there is only one shape that can be moved.'); return; }
  setOverlapAllowed(false);
  toast(`${n} shapes laid out in the middle of the canvas. You can undo the move.`);
});
$('clearBtn').addEventListener('click', () => editor.clear());
$('undoBtn').addEventListener('click', () => editor.undo());
$('redoBtn').addEventListener('click', () => editor.redo());

// Align the inner wall against the outer one — nine spots in a little grid.
function setAlignMenu(open) {
  $('alignMenu').hidden = !open;
  $('alignBtn').setAttribute('aria-expanded', String(open));
}
$('alignBtn').addEventListener('click', () => setAlignMenu($('alignMenu').hidden));
$('alignMenu').addEventListener('click', (e) => {
  const b = e.target.closest('[data-h]'); if (!b) return;
  editor.alignInner(b.dataset.h, b.dataset.v);
  setAlignMenu(false);
});
document.addEventListener('pointerdown', (e) => {
  if (!$('alignMenu').hidden && !e.target.closest('.align-wrap')) setAlignMenu(false);
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setAlignMenu(false); });

// symmetry — a setting of the shape you are editing, not of the plate
function syncSymmetry() {
  editor.setSymmetry({ x: $('symXBtn').getAttribute('aria-pressed') === 'true', y: $('symYBtn').getAttribute('aria-pressed') === 'true' });
  setTool(editor.tool);
}
// Turning a mirror on or off reshapes what is already drawn, so it is worth a word first.
const SYM_EXPLAIN = {
  symXBtn: {
    on: ['Mirror left–right?', 'The right half of your drawing becomes the whole shape: everything left of the middle line is replaced by a mirrored copy of the right half. From then on you only draw the right half and the left follows along.'],
    off: ['Turn left–right mirroring off?', 'The mirrored shape is kept as it is now, and both halves become editable again. Later changes to one side no longer show up on the other.'],
  },
  symYBtn: {
    on: ['Mirror top–bottom?', 'The top half of your drawing becomes the whole shape: everything below the middle line is replaced by a mirrored copy of the top half. From then on you only draw the top half and the bottom follows along.'],
    off: ['Turn top–bottom mirroring off?', 'The mirrored shape is kept as it is now, and both halves become editable again. Later changes to one half no longer show up in the other.'],
  },
};
for (const id of ['symXBtn', 'symYBtn']) {
  $(id).addEventListener('click', async () => {
    const on = $(id).getAttribute('aria-pressed') !== 'true';
    if (editor.hasOuter) {
      const [title, body] = SYM_EXPLAIN[id][on ? 'on' : 'off'];
      const ok = await confirmAction(title, body + ' You can undo this.', on ? 'Mirror' : 'Turn off');
      if (!ok) return;
    }
    $(id).setAttribute('aria-pressed', String(on));
    syncSymmetry();
  });
}

// grid — the control sits at the canvas' bottom left, next to the scale bar it replaced
function syncGrid() { editor.setGrid(parseFloat($('gridSize').value), $('snapBtn').getAttribute('aria-pressed') === 'true'); }
$('gridSize').addEventListener('change', syncGrid);
$('snapBtn').addEventListener('click', () => { const b = $('snapBtn'); b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true')); syncGrid(); });

// The bar shows one grid square on screen; below ~6 px the grid draws every fifth line instead,
// and the bar follows that so it always measures something you can actually see.
function syncScaleBar() {
  const { px, mm } = editor.gridBar;
  $('scaleTick').style.width = `${Math.round(px)}px`;
  $('scaleLabel').textContent = `${mm} mm`;
}

// guides
$('guideVBtn').addEventListener('click', () => { editor.addGuide('v'); toast('Guide added — drag its tab at the top edge, double-tap it to remove.'); });
$('guideHBtn').addEventListener('click', () => { editor.addGuide('h'); toast('Guide added — drag its tab at the left edge, double-tap it to remove.'); });
$('guideClearBtn').addEventListener('click', () => editor.clearGuides());

const ARROWS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

document.addEventListener('keydown', (e) => {
  const typing = /input|textarea|select/i.test(document.activeElement?.tagName || '');
  if (typing) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); editor.undo(); }
  else if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); editor.redo(); }
  else if (e.key === '1') setTool('draw');
  else if (e.key === '2') setTool('points');
  else if (e.key === '3') setTool('move');
  else if (e.key.toLowerCase() === 'o') setActive('outer');
  else if (e.key.toLowerCase() === 'i') setActive('inner');
  else if ((e.key === 'Delete' || e.key === 'Backspace') && editor.tool === 'points' && editor.selected >= 0) { e.preventDefault(); editor.deletePoint(); }
  else if (ARROWS[e.key] && editor.tool === 'points' && editor.selected >= 0) {
    e.preventDefault();
    const [dx, dy] = ARROWS[e.key], step = e.shiftKey ? 5 : 1;   // millimetres
    editor.nudgePoint(dx * step, dy * step);
  }
  // ⌘A / Ctrl+A holds every shape — the Move tool's, like the row it presses. Elsewhere it does
  // nothing, but it still may not fall through to the browser selecting the whole page.
  else if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); if (editor.canHoldMany) $('selectAllBtn').click(); }
  else if (ARROWS[e.key] && editor.tool === 'move' && editor.picked && !editor.rounding) {
    e.preventDefault();
    const [dx, dy] = ARROWS[e.key], step = e.shiftKey ? 5 : 1;   // millimetres
    editor.nudgeShape(dx * step, dy * step);
  }
  else if (e.key === 'Enter' && editor.rounding) { e.preventDefault(); $('roundApplyBtn').click(); }
  else if (e.key === 'Escape' && editor.rounding) { e.preventDefault(); editor.cancelRound(); }
  // Escape lets go of whatever is being held: the selected point, or the shape the Move tool
  // has hold of.
  else if (e.key === 'Escape') { editor.selectPoint(-1); editor.dropShape(); closeMenu(); }
});

// ---------- size inputs ----------
$('lockBtn').addEventListener('click', () => {
  editor.lockAspect = !editor.lockAspect;
  $('lockBtn').setAttribute('aria-pressed', String(editor.lockAspect));
});
$('widthInput').addEventListener('change', (e) => { const v = parseFloat(e.target.value); if (v > 0) editor.setSize(v, null); });
$('heightInput').addEventListener('change', (e) => { const v = parseFloat(e.target.value); if (v > 0) editor.setSize(null, v); });

// ---------- cutter parameters ----------
const PARAM_INPUTS = {
  pHeight: 'height', pBladeWidth: 'bladeWidth', pBaseWidth: 'baseWidth', pBaseHeight: 'baseHeight',
  pRidgeWidth: 'ridgeWidth', pRidgeHeight: 'ridgeHeight',
  pBridgeCount: 'bridgeCount', pBridgeWidth: 'bridgeWidth', pBridgeAngle: 'bridgeAngle',
};
// Push the active shape's params back into their inputs (on a shape switch, or after opening
// a project). The box being typed in is left alone, so switching shapes mid-edit cannot swallow
// a half-typed number from under the cursor.
function syncParamInputs() {
  for (const [id, key] of Object.entries(PARAM_INPUTS)) {
    const el = $(id);
    if (document.activeElement !== el) el.value = params[key];
  }
  $('pRidge').checked = params.ridge;
  $('ridgeFields').hidden = !params.ridge;
  $('pMirror').checked = params.mirror;
  $('bridgeAutoBtn').setAttribute('aria-pressed', String(editor.layer.bridgeAuto));
  syncResetMarks();
}

for (const [id, key] of Object.entries(PARAM_INPUTS)) {
  const el = $(id);
  el.value = params[key];
  el.addEventListener('input', () => {
    const v = parseFloat(el.value);
    if (!isFinite(v)) return;
    if (v <= 0 && !['bridgeCount', 'bridgeAngle'].includes(key)) return;
    params[key] = key === 'bridgeCount' ? Math.max(0, Math.round(v)) : v;
    if (key === 'bridgeWidth' && editor.layer.bridgeAuto) { editor.layer.bridgeAuto = false; $('bridgeAutoBtn').setAttribute('aria-pressed', 'false'); }
    onParamsChanged();
  });
}
$('pRidge').addEventListener('change', (e) => {
  params.ridge = e.target.checked; $('ridgeFields').hidden = !params.ridge; onParamsChanged();
});
$('pMirror').addEventListener('change', (e) => setMirror(e.target.checked));

function onParamsChanged() {
  syncResetMarks();
  drawProfile();
  editor.requestRender();     // the wall bands are keyed on the settings, so they redraw by themselves
  scheduleRegen();
}

// ---------- settings that are off the default ----------
// A cutter read back out of an STL arrives with every number measured off the model, so it is
// usually nowhere near the settings a shape you draw starts from — and nothing on the panel said
// so. Each setting that differs now carries a small undo arrow, and a row at the top of the panel
// offers to put the whole shape back at once.
//
// A setting only counts while it is on screen and doing something: with the step switched off or
// with no inner wall, those fields are not shown and build nothing, so they are not a deviation
// anybody can see. Mirror is left out on purpose — it turns over the whole plate rather than this
// one shape, which is why it lives under Export and has a confirmation of its own.
const RESET_FIELDS = [
  { key: 'height',      name: 'Cutter height',   unit: ' mm' },
  { key: 'bladeWidth',  name: 'Blade thickness', unit: ' mm' },
  { key: 'baseWidth',   name: 'Base width',      unit: ' mm' },
  { key: 'baseHeight',  name: 'Base thickness',  unit: ' mm' },
  { key: 'ridge',       name: 'Support step',    bool: true },
  { key: 'ridgeWidth',  name: 'Step width',      unit: ' mm', when: (c) => c.p.ridge },
  { key: 'ridgeHeight', name: 'Step height',     unit: ' mm', when: (c) => c.p.ridge },
  { key: 'bridgeCount', name: 'Bars',            unit: '', when: (c) => c.inner },
  // The thickness has no default number: a shape you draw gets 10% of its width. So what it goes
  // back to is `auto`, and having auto on *is* being on the default, whatever it works out to.
  { key: 'bridgeWidth', name: 'Bar thickness',   unit: ' mm', when: (c) => c.inner, auto: true },
  { key: 'bridgeAngle', name: 'Bar rotation',    unit: '°', when: (c) => c.inner },
];
const resetMarks = new Map([...document.querySelectorAll('[data-reset]')].map(b => [b.dataset.reset, b]));
const showNum = (v) => String(Math.round(v * 1000) / 1000);

// Everything judging a setting needs, so the same rules can be read off a shape you are not on —
// which is what the marker in the shapes list is: its settings, whether its bar thickness is left
// to the app, and whether it has an inner wall for the bar settings to belong to. `inner` is the
// effective contour, so it has to be handed in; the shapes list already has one per shape.
const shapeCtx = (layer, inner) => ({ p: layer.params, auto: layer.bridgeAuto, inner: inner.length >= 3 });
const activeCtx = () => shapeCtx(editor.layer, editor.getShape().inner);
// The same, for every shape being held: Reset all puts the settings of all of them back, because
// the shapes list is where you said which shapes you meant.
function heldCtxs() {
  const list = editor.layerList();
  return editor.selection.map(i => ({ i, ctx: shapeCtx(editor.layers[i], list[i].inner) }));
}

function offDefault(f, c) {
  if (f.when && !f.when(c)) return false;
  if (f.auto) return !c.auto;
  if (f.bool) return c.p[f.key] !== DEFAULT_PARAMS[f.key];
  return Math.abs(c.p[f.key] - DEFAULT_PARAMS[f.key]) > 1e-6;
}
const offDefaultCount = (c) => RESET_FIELDS.reduce((n, f) => n + (offDefault(f, c) ? 1 : 0), 0);

function valueText(f, c) {
  if (f.auto && c.auto) return 'auto';
  if (f.bool) return c.p[f.key] ? 'on' : 'off';
  return showNum(c.p[f.key]) + f.unit;
}
function defaultText(f) {
  if (f.auto) return 'auto';
  if (f.bool) return DEFAULT_PARAMS[f.key] ? 'on' : 'off';
  return showNum(DEFAULT_PARAMS[f.key]) + f.unit;
}
// Mutates only; the caller syncs the panel once for the whole lot.
function applyReset(f, layer = editor.layer) {
  if (f.auto) layer.bridgeAuto = true;
  else layer.params[f.key] = DEFAULT_PARAMS[f.key];
}

function syncResetMarks() {
  const c = activeCtx();
  let n = 0;
  for (const f of RESET_FIELDS) {
    const el = resetMarks.get(f.key);
    if (!el) continue;
    const off = offDefault(f, c);
    if (off) { n++; setTip(el, `Reset — the default is ${defaultText(f)}.`); }
    el.hidden = !off;
  }
  // With several shapes held the row speaks for all of them — the marks above it still belong to
  // the one the panel is showing, which is the only one whose numbers are on screen.
  const held = editor.selectionCount > 1 ? heldCtxs().filter(h => offDefaultCount(h.ctx) > 0) : null;
  $('resetAllRow').hidden = held ? held.length === 0 : n === 0;
  $('resetAllNote').textContent = held
    ? (held.length === 1
      ? '1 of the shapes you are holding is off the defaults'
      : `${held.length} of the shapes you are holding are off the defaults`)
    : n === 1
      ? '1 setting differs from the default'
      : `${n} settings differ from the defaults`;
  $('resetAllLabel').textContent = held ? `Reset ${held.length === 1 ? 'it' : 'them'}` : 'Reset all';
  setTip($('resetAllBtn'), held
    ? `Reset — put every setting of the ${held.length === 1 ? 'shape' : `${held.length} shapes`} you are holding back to the app's default. It shows you what would change first.`
    : "Reset all — put every setting of this shape back to the app's default. It shows you what would change first.");
  syncShapeFlags();   // the same news, one level up: which shapes on the plate are not standard
}

// One setting, one press: the value is right there on screen, so there is nothing a dialog
// could tell you that you cannot already see.
for (const [key, el] of resetMarks) {
  el.addEventListener('click', () => {
    const f = RESET_FIELDS.find(x => x.key === key);
    if (!f || !offDefault(f, activeCtx())) return;
    applyReset(f);
    autoBridgeWidth(editor.getShape());   // a no-op unless the reset was the one that turned auto back on
    syncParamInputs();
    onParamsChanged();
    refreshSummaries();
  });
}

// All of them at once is a different matter: several numbers change, some of them in sections
// that are folded away, and wall settings have no undo. So it says what it is about to do first.
$('resetAllBtn').addEventListener('click', async () => {
  // One shape or the whole selection — the same dialog either way, with a heading per shape
  // once there is more than one.
  const shapes = (editor.selectionCount > 1 ? heldCtxs() : [{ i: editor.index, ctx: activeCtx() }])
    .map(h => ({ ...h, list: RESET_FIELDS.filter(f => offDefault(f, h.ctx)) }))
    .filter(h => h.list.length);
  if (!shapes.length) return;
  if (!await confirmReset(shapes)) return;
  for (const h of shapes) for (const f of h.list) applyReset(f, editor.layers[h.i]);
  // Bar thickness back on auto has to be worked out again, and only the active shape's is in
  // `params` — the others are read off their own layer.
  for (const h of shapes) autoBridgeWidthFor(editor.layers[h.i]);
  syncParamInputs();
  onParamsChanged();
  refreshSummaries();
  const n = shapes.reduce((k, h) => k + h.list.length, 0);
  toast(shapes.length > 1
    ? `${n} settings across ${shapes.length} shapes are back to their defaults.`
    : n === 1
      ? 'One setting is back to its default.'
      : `${n} settings are back to their defaults.`);
});

// Before and after, one row per setting — and, with more than one shape being reset, a heading
// per shape over its rows. Resolves false on Cancel, Esc or the backdrop.
function confirmReset(shapes) {
  const dlg = $('resetDialog');
  const many = editor.layers.length > 1;
  const total = shapes.reduce((n, h) => n + h.list.length, 0);
  $('resetTitle').textContent = shapes.length > 1
    ? `Reset the settings for ${shapes.length} shapes?`
    : many
      ? `Reset the settings for shape ${shapes[0].i + 1}?`
      : 'Reset the settings?';
  $('resetBody').textContent = total === 1
    ? 'One setting goes back to the default:'
    : `These ${total} settings go back to the defaults:`;
  const table = $('resetTable');
  table.textContent = '';
  const cell = (cls, text) => {
    const d = document.createElement('div');
    d.className = cls; d.textContent = text;
    return d;
  };
  for (const h of shapes) {
    if (shapes.length > 1) table.append(cell('rt-shape', `Shape ${h.i + 1}`));
    for (const f of h.list)
      table.append(cell('rt-name', f.name), cell('rt-from', valueText(f, h.ctx)), cell('rt-arrow', '\u2192'), cell('rt-to', defaultText(f)));
  }
  $('resetOkLabel').textContent = total === 1 ? 'Reset' : `Reset ${total} settings`;
  return new Promise((resolve) => {
    const done = (ok) => {
      dlg.removeEventListener('submit', onSubmit);
      dlg.removeEventListener('close', onClose);
      resolve(ok);
    };
    const onSubmit = () => done(true);   // the close that follows finds no listener left
    const onClose = () => done(false);
    dlg.addEventListener('submit', onSubmit);
    dlg.addEventListener('close', onClose);
    dlg.showModal();
    $('resetOkBtn').focus();
  });
}
$('resetCancelBtn').addEventListener('click', () => $('resetDialog').close());

// Cross-section diagram of one wall, so the numbers have a picture.
function drawProfile() {
  const svg = $('profile');
  const H = params.height, bw = Math.max(0.3, params.bladeWidth);
  const baseW = Math.max(bw, params.baseWidth), baseH = params.baseHeight;
  const rw = params.ridge ? Math.min(baseW, Math.max(bw, params.ridgeWidth)) : bw;
  const rh = params.ridge ? params.ridgeHeight : 0;
  const pts = [[0, 0], [baseW, 0], [baseW, baseH], [rw, baseH], [rw, baseH + rh], [bw, baseH + rh], [bw, H], [0, H]];
  const maxW = Math.max(baseW, 6), scale = Math.min(110 / maxW, 80 / H);
  const ox = 70, oy = 95;
  const P = pts.map(([x, z]) => `${(ox + x * scale).toFixed(1)},${(oy - z * scale).toFixed(1)}`).join(' ');
  const label = (x, y, t, anchor = 'start') => `<text x="${x}" y="${y}" text-anchor="${anchor}" font-size="11" fill="#b2b6ca" font-family="inherit">${t}</text>`;
  svg.innerHTML = `
    <rect x="0" y="${oy}" width="200" height="1.5" fill="#3f424d"/>
    <rect x="8" y="${oy - 12 * scale - 2}" width="${ox - 12}" height="${12 * scale + 2}" rx="4" fill="#9184d9" opacity="0.12"/>
    ${label(12, oy - 12 * scale - 8, 'cut piece')}
    <polygon points="${P}" fill="#292b31" stroke="#9184d9" stroke-width="1.2" stroke-linejoin="round"/>
    ${label(ox + bw * scale + 6, oy - H * scale + 8, `blade ${bw} mm`)}
    ${rh > 0 ? label(ox + rw * scale + 6, oy - (baseH + rh) * scale + 8, `step ${rw} mm`) : ''}
    ${label(ox + baseW * scale + 6, oy - 3, `base ${baseW} mm`)}
    ${label(ox - 6, oy - H * scale / 2 + 4, `${H} mm`, 'end')}
    ${label(198, 106, 'print bed', 'end')}
  `;
}

// Two size boxes tied together by a proportion lock. The SVG import and the starter shapes
// both ask for a size before anything lands on the canvas, and both mean the same by it.
// The returned object carries the ratio (height / width) the caller has to keep up to date.
function linkSizeFields(wId, hId, lockId) {
  const state = { ratio: 1, lock: true };
  $(lockId).addEventListener('click', () => {
    state.lock = !state.lock;
    $(lockId).setAttribute('aria-pressed', String(state.lock));
  });
  const follow = (from, to, f) => $(from).addEventListener('input', () => {
    const v = parseFloat($(from).value);
    if (state.lock && state.ratio > 0 && v > 0) $(to).value = f(v).toFixed(1);
  });
  follow(wId, hId, (w) => w * state.ratio);
  follow(hId, wId, (h) => h / state.ratio);
  return state;
}

// ---------- starter shapes ----------
// A drop-down could only list the names, so the button opens a grid of previews. Each tile is
// drawn from the very same anchors the editor is handed, so a picture here cannot drift away
// from the shape it inserts.
const presetBtn = $('presetBtn'), presetMenu = $('presetMenu');

// The anchors as an SVG path: a curve wherever the two points around a segment have handles.
function presetPath(pts) {
  const n = pts.length, r = (v) => Math.round(v * 100) / 100;
  let d = `M${r(pts[0].x)} ${r(pts[0].y)}`;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    if (a.out || b.in) {
      d += `C${r(a.x + (a.out?.x || 0))} ${r(a.y + (a.out?.y || 0))}`
         + ` ${r(b.x + (b.in?.x || 0))} ${r(b.y + (b.in?.y || 0))} ${r(b.x)} ${r(b.y)}`;
    } else d += `L${r(b.x)} ${r(b.y)}`;
  }
  return `${d}Z`;
}

// The viewBox that frames an outline with a little air around it, so the tile in the grid and
// the picture in the size dialog are the same drawing.
function presetArt(pts) {
  const b = bounds(flatten(pts)), box = Math.max(b.width, b.height) * 1.12, v = (n) => Math.round(n * 100) / 100;
  return { viewBox: `${v(b.cx - box / 2)} ${v(b.cy - box / 2)} ${v(box)} ${v(box)}`, d: presetPath(pts), b };
}

// Insert the shape at the size the dialog settled on. The anchors are drawn at their own scale
// (see presets.js), so this is where they are brought to millimetres; mapPts takes the handles
// along with their anchors.
function insertPreset(key, w, h) {
  const p = PRESETS[key]; if (!p) return;
  // The shapes are drawn with Bézier handles, so they go in as they are: cleaning them
  // through Clipper would flatten every curve into a polyline of hundreds of points.
  const pts = p.make(), b = bounds(flatten(pts));
  const sx = w / b.width, sy = h / b.height;
  const at = (cx, cy) => mapPts(pts, q => ({ x: cx + (q.x - b.cx) * sx, y: cy + (q.y - b.cy) * sy }));
  if (editor.active === 'inner') {
    // centred on the outer wall, so the hole lands inside it
    const c = editor.hasOuter ? bounds(editor.getPoints()) : { cx: 0, cy: 0 };
    editor.setPoints(at(c.cx, c.cy), { record: true });
  } else {
    editor.setShape({ outer: at(0, 0), inner: [] }, { record: true, center: true });
  }
  setTool('move');
}

// Picking a tile asks for the size first: a starter shape is a starting point for a cutter of
// a particular size, and 70 mm of circle is not what anyone making earrings is after.
let pendingPreset = null;
function askPresetSize(key) {
  const p = PRESETS[key]; if (!p) return;
  const art = presetArt(p.make()), b = art.b;
  const inner = editor.active === 'inner' && editor.hasOuter;
  let w, h;
  if (inner) {                                       // half the outer wall, the way it used to land
    const o = editor.getSize(), s = Math.min(o.width, o.height) * 0.5 / Math.max(b.width, b.height) || 1;
    w = b.width * s; h = b.height * s;
  } else {
    const s = PRESET_SIZE_MM / Math.max(b.width, b.height);
    w = b.width * s; h = b.height * s;
  }
  pendingPreset = { key, w, h };
  presetSize.ratio = b.height / b.width;
  $('presetPreview').setAttribute('viewBox', art.viewBox);
  $('presetPreviewPath').setAttribute('d', art.d);
  $('presetDialogNote').textContent = inner
    ? `${p.label}, sized to sit inside the outer wall. Change it if you want.`
    : `${p.label}, at the size cutters for earrings usually are. Change it if you want — the size boxes under the canvas can do it later too.`;
  $('presetWidth').value = w.toFixed(1); $('presetHeight').value = h.toFixed(1);
  $('presetDialog').showModal();
  $('presetWidth').focus(); $('presetWidth').select();
}

const presetSize = linkSizeFields('presetWidth', 'presetHeight', 'presetLockBtn');
$('presetCancelBtn').addEventListener('click', () => $('presetDialog').close());
$('presetDialog').addEventListener('close', () => { pendingPreset = null; });
$('presetDialog').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!pendingPreset) return;
  const { key, w, h } = pendingPreset;
  const mm = (v, fallback) => { const n = parseFloat(v); return n > 0 && n <= 400 ? n : fallback; };
  const width = mm($('presetWidth').value, w), height = mm($('presetHeight').value, h);
  $('presetDialog').close();
  insertPreset(key, width, height);
});

for (const [key, p] of Object.entries(PRESETS)) {
  const art = presetArt(p.make());
  const tile = document.createElement('button');
  tile.type = 'button';
  tile.className = 'preset-tile';
  tile.dataset.preset = key;
  tile.innerHTML = `<svg viewBox="${art.viewBox}" aria-hidden="true">`
    + `<path d="${art.d}" vector-effect="non-scaling-stroke" /></svg><span></span>`;
  tile.querySelector('span').textContent = p.label;
  presetMenu.append(tile);
}

// Put the grid under the button and keep it inside the window: on a phone the button can sit
// anywhere in a wrapped toolbar, and there may be more room above it than below.
function placePresetMenu() {
  const pad = 8, gap = 6, b = presetBtn.getBoundingClientRect();
  presetMenu.style.maxHeight = '';                       // measure it at its natural height
  const w = presetMenu.offsetWidth, h = presetMenu.scrollHeight;
  const below = innerHeight - b.bottom - gap - pad, above = b.top - gap - pad;
  const up = below < Math.min(h, 240) && above > below;
  presetMenu.style.left = `${Math.round(Math.min(Math.max(pad, b.right - w), innerWidth - w - pad))}px`;
  presetMenu.style.maxHeight = `${Math.round(Math.max(160, up ? above : below))}px`;
  presetMenu.style.top = up ? 'auto' : `${Math.round(b.bottom + gap)}px`;
  presetMenu.style.bottom = up ? `${Math.round(innerHeight - b.top + gap)}px` : 'auto';
}
let presetBtnTip = '';
function setPresetMenu(open) {
  presetMenu.hidden = !open;
  presetBtn.setAttribute('aria-expanded', String(open));
  // The button keeps the focus, and its own explanation would then sit on top of the grid
  // it just opened; give the tip back when the grid closes.
  if (open) {
    presetBtnTip = presetBtn.dataset.tip || presetBtnTip;
    delete presetBtn.dataset.tip;
    hideTip();
    placePresetMenu();
  } else if (presetBtnTip) {
    presetBtn.dataset.tip = presetBtnTip;
  }
}
presetBtn.addEventListener('click', () => setPresetMenu(presetMenu.hidden));
presetMenu.addEventListener('click', (e) => {
  const tile = e.target.closest('[data-preset]');
  if (!tile) return;
  setPresetMenu(false);
  askPresetSize(tile.dataset.preset);
});
document.addEventListener('pointerdown', (e) => {
  if (!presetMenu.hidden && !e.target.closest('.preset-picker')) setPresetMenu(false);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !presetMenu.hidden) { setPresetMenu(false); presetBtn.focus(); }
});
window.addEventListener('resize', () => { if (!presetMenu.hidden) placePresetMenu(); });
// It is fixed to the window, so a scroll anywhere but inside the grid itself moves the button away.
window.addEventListener('scroll', (e) => {
  if (!presetMenu.hidden && !presetMenu.contains(e.target)) placePresetMenu();
}, true);

// ---------- import (SVG outline, or a whole cutter from an STL) ----------
// One way in for every file, whichever door it came through: the two file pickers and the drop
// layer all hand it here, and the name decides what it is.
const isSTL = (file) => /\.stl$/i.test(file.name) || file.type === 'model/stl';
const isSVG = (file) => /\.svg$/i.test(file.name) || file.type === 'image/svg+xml';
const isProject = (file) => new RegExp(`\\${PROJECT_EXT}$`, 'i').test(file.name);

// One import at a time: a second file arriving while the first is still being read would put two
// dialogs on top of each other and two drawings into the same canvas.
let importing = false;
// A modal dialog is a question waiting for an answer — the size of the drawing being imported,
// most of the time. Starting a second import behind it would want the same dialog twice.
const busyImporting = () => importing || !!document.querySelector('dialog[open]');
async function beginImport(file) {
  if (!file || busyImporting()) return;
  importing = true;
  try {
    if (isSTL(file)) await openSTL(file);
    else if (isSVG(file)) await openSVG(file);
    else if (isProject(file) || /\.zip$/i.test(file.name)) await openProject(file);
    else toast(`${file.name} is not a file Cutter can read — drop an SVG outline, an STL cutter or a ${PROJECT_EXT} project.`);
  } finally {
    importing = false;
  }
}

let pendingSvg = null;
$('svgInput').addEventListener('change', (e) => {
  const file = e.target.files?.[0]; e.target.value = '';
  beginImport(file);
});

async function openSVG(file) {
  let res;
  await showLoader(`Reading ${file.name}…`);
  try {
    res = await importSVG(await file.text());
  } catch (err) {
    toast(err.message || 'Could not read that SVG.');
    return;
  } finally {
    hideLoader();
  }
  try {
    // An SVG of one plain outline dropped while the inner wall is the one being edited is that
    // wall, and neither adding a shape nor replacing the plate: it goes where you are working.
    const innerCase = editor.active === 'inner' && res.shapes.length === 1 && !res.shapes[0].inner;
    let mode = 'replace';
    if (!innerCase) {
      mode = await askImportMode(file, res.shapes.length, 'Import this drawing?',
        `${file.name} holds ${countShapes(res.shapes.length)}. ${res.shapes.length > 1 ? 'They can' : 'It can'} join what is on the canvas, or take its place.`);
      if (!mode) return;
    }
    pendingSvg = { res, name: file.name, mode: innerCase ? 'replace' : mode };
    // The size asked for is the size of the whole drawing; the shapes in it keep their places
    // and their proportions within it.
    const b = res.bounds;
    let w = b.width, h = b.height;
    if (!res.physical || Math.max(w, h) > 400 || Math.max(w, h) < 5) { const s = 80 / Math.max(w, h); w *= s; h *= s; }
    svgSize.ratio = b.height / b.width;
    $('svgWidth').value = w.toFixed(1); $('svgHeight').value = h.toFixed(1);
    const found = res.shapes.length > 1
      ? ` ${res.shapes.length} separate shapes were found; each becomes a cutter of its own.`
      : res.shapes[0].inner ? ' Outer and inner wall found.' : '';
    $('svgDialogNote').textContent = (res.physical
      ? `${file.name} specifies a physical size (${b.width.toFixed(1)} × ${b.height.toFixed(1)} mm). Change it if needed.`
      : `${file.name} has no physical size, so 80 mm wide is suggested. Set the size you want.`) + found;
    if (!$('svgDialog').open) $('svgDialog').showModal();
    $('svgWidth').focus(); $('svgWidth').select();
  } catch (err) {
    toast(err.message || 'Could not read that SVG.');
  }
}
const svgSize = linkSizeFields('svgWidth', 'svgHeight', 'svgLockBtn');
$('svgCancelBtn').addEventListener('click', () => { pendingSvg = null; $('svgDialog').close(); });
$('svgDialog').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!pendingSvg) return;
  const { res, name, mode } = pendingSvg; pendingSvg = null;
  $('svgDialog').close();
  const b = res.bounds;
  const w = parseFloat($('svgWidth').value), h = parseFloat($('svgHeight').value);
  const sx = w > 0 ? w / b.width : 1, sy = h > 0 ? h / b.height : sx;
  // Centre the whole drawing on the canvas, keeping the shapes where they sit inside it.
  const f = p => ({ x: (p.x - b.cx) * sx, y: (p.y - b.cy) * sy });
  const shapes = res.shapes.map(sh => ({ outer: sh.outer.map(f), inner: sh.inner ? sh.inner.map(f) : [] }));
  let msg = `${mode === 'add' ? 'Added' : 'Imported'} ${name} at ${(b.width * sx).toFixed(1)} × ${(b.height * sy).toFixed(1)} mm`;
  if (shapes.length > 1) msg += ` — ${shapes.length} shapes`;
  else if (shapes[0].inner.length) msg += ' — outer and inner wall';
  if (res.extraHoles) msg += ` (${res.extraHoles} extra hole${res.extraHoles === 1 ? '' : 's'} left out — one inner wall per shape)`;
  await withLoader(mode === 'add' ? 'Adding the shapes…' : `Importing ${name}…`, () => {
    if (mode === 'add') { addState(shapes); return; }
    if (editor.active === 'inner' && shapes.length === 1 && !shapes[0].inner.length) {
      editor.setPoints(shapes[0].outer, { record: true });
    } else {
      editor.setLayers(shapes);
      setActive('outer');
    }
    setTool('move');
    adoptOverlapFromDrawing();   // a sheet whose shapes touch is imported as it is, guard down
  }, { build: true });
  toast(msg + '.');
  setTimeout(warnIfClashing, 1200);   // after the "imported" message has had its turn
});

// ---------- dragging a file into the window ----------
// Dropping a file on the app is the same import as the two buttons, so it goes through
// beginImport() like everything else. The layer that comes up while a file is over the window is
// the answer to "where does this land": the canvas, lit up. It covers the rest of the window too,
// because a file let go beside the canvas would otherwise be opened by the browser — which
// throws the drawing away without asking.
const dropLayer = $('dropLayer'), dropZone = $('dropZone');
const DROP_LINGER = 700;   // ms without a dragover before the layer is taken to have left
let dropTimer = 0;

const draggingFile = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');

// The zone is the canvas, and only the part of it that is on screen: with that panel switched
// off, or with the canvas scrolled out of the window on a phone, there would be nothing to aim
// at, so the whole window becomes the zone instead. Measured on every move — panels come and go,
// and a drag near the edge of the window scrolls the page under it.
function placeDropZone() {
  const wrap = document.querySelector('.canvas-wrap');
  const r = wrap ? wrap.getBoundingClientRect() : null;
  const left = r ? Math.max(0, r.left) : 0, top = r ? Math.max(0, r.top) : 0;
  let box = r ? { left, top, width: Math.min(r.right, innerWidth) - left, height: Math.min(r.bottom, innerHeight) - top } : null;
  if (!box || box.width < 140 || box.height < 120) box = { left: 0, top: 0, width: innerWidth, height: innerHeight };
  const pad = Math.min(16, box.width * 0.04, box.height * 0.04);
  const out = { left: box.left + pad, top: box.top + pad, width: box.width - pad * 2, height: box.height - pad * 2 };
  dropZone.style.left = `${Math.round(out.left)}px`;
  dropZone.style.top = `${Math.round(out.top)}px`;
  dropZone.style.width = `${Math.round(out.width)}px`;
  dropZone.style.height = `${Math.round(out.height)}px`;
  return out;
}

function openDropLayer() {
  dropLayer.hidden = false;
  clearTimeout(dropTimer);
  dropTimer = setTimeout(closeDropLayer, DROP_LINGER);
  return placeDropZone();
}
function closeDropLayer() {
  clearTimeout(dropTimer);
  dropLayer.hidden = true;
  dropZone.classList.remove('hot');
}

// dragover keeps firing while the file is over the window (the browser repeats it even when the
// pointer stands still), so a timer that it keeps pushing back is what says the file has gone.
// Counting dragenter against dragleave is the usual way and gets this wrong whenever an element
// boundary is crossed mid-drag.
window.addEventListener('dragover', (e) => {
  if (!draggingFile(e)) return;
  // Always swallow the drop, even when the app cannot take the file: letting the browser have it
  // means opening the SVG in this tab, which throws the drawing away without asking. The layer,
  // though, is only offered when the file can actually land somewhere.
  e.preventDefault();
  if (!$('loader').hidden || busyImporting()) { e.dataTransfer.dropEffect = 'none'; return; }
  e.dataTransfer.dropEffect = 'copy';
  const r = openDropLayer();
  const over = e.clientX >= r.left && e.clientX <= r.left + r.width
            && e.clientY >= r.top && e.clientY <= r.top + r.height;
  dropZone.classList.toggle('hot', over);
});
window.addEventListener('dragleave', (e) => {
  if (e.relatedTarget === null) closeDropLayer();   // the pointer left the window altogether
});
window.addEventListener('dragend', closeDropLayer);
window.addEventListener('drop', (e) => {
  if (!draggingFile(e)) return;
  e.preventDefault();
  closeDropLayer();
  if (!$('loader').hidden || busyImporting()) return;
  const file = e.dataTransfer.files?.[0];
  if (e.dataTransfer.files?.length > 1) toast(`${e.dataTransfer.files.length} files dropped — only ${file.name} was read.`);
  beginImport(file);
});
window.addEventListener('resize', () => { if (!dropLayer.hidden) placeDropZone(); });
window.addEventListener('scroll', () => { if (!dropLayer.hidden) placeDropZone(); }, true);

// ---------- the shapes on this plate ----------
// One entry per shape, at the canvas' top left. The one you pick is the one you draw on and the
// one the settings panel belongs to; the rest stay on the canvas in grey. All of them are built
// into the 3D preview and downloaded together, because that is what comes off the printer.
const shapesList = $('shapesList');

// A thumbnail of one outline, so two shapes in the list can be told apart at a glance. Drawn
// from the outline itself, thinned down to what a 22 px picture can show.
function shapeThumb(outer, inner) {
  if (!outer || outer.length < 3) {
    return '<svg class="thumb blank" viewBox="0 0 22 22" aria-hidden="true">'
      + '<path d="M4 4h14v14H4z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-dasharray="3 3" /></svg>';
  }
  const b = bounds(outer), box = Math.max(b.width, b.height, 0.001) * 1.14;
  const r = (v) => Math.round(v * 100) / 100;
  const ring = (pts) => {
    const t = simplify(pts.concat([pts[0]]), box / 90);
    return 'M' + t.map(q => `${r(q.x)} ${r(q.y)}`).join('L') + 'Z';
  };
  let d = ring(outer);
  if (inner && inner.length >= 3) d += ring(inner);
  const vb = `${r(b.cx - box / 2)} ${r(b.cy - box / 2)} ${r(box)} ${r(box)}`;
  return `<svg class="thumb" viewBox="${vb}" aria-hidden="true">`
    + `<path d="${d}" fill-rule="evenodd" vector-effect="non-scaling-stroke" /></svg>`;
}

// Adding or removing a shape, or stepping to another one, redraws the list at once; a thumbnail
// that is only changing because a shape is being dragged waits for the drag to stop. Without that
// the list would be rebuilt sixty times a second, outline simplification and all.
let listShape = '', listTimer = 0;
function renderShapeList() {
  // Which shapes are held and which are locked shows in the rows, so both belong in the
  // signature: a ⌘-click that changes neither the plate nor the active shape still redraws.
  const sig = `${editor.layers.length}|${editor.index}|${editor.selection.join(',')}`
    + `|${editor.layers.map(l => (l.locked ? 1 : 0)).join('')}`;
  const structural = sig !== listShape;
  listShape = sig;
  clearTimeout(listTimer);
  if (structural) drawShapeList();
  else listTimer = setTimeout(drawShapeList, 200);
}

// The overlap switch is the plate's own setting, so it only appears once there is a plate: two
// shapes or more. It folds away behind the list header along with the shapes it belongs to.
function syncOverlapRow() {
  $('overlapBtn').setAttribute('aria-pressed', String(editor.allowOverlap));
  $('shapesFoot').hidden = editor.layerCount < 2 || shapesList.hidden;
  syncSelectRow();
}

function drawShapeList() {
  const list = editor.layerList();
  const many = list.length > 1;
  shapesList.textContent = '';
  for (const l of list) {
    const name = `Shape ${l.index + 1}`;
    const row = document.createElement('div');
    row.className = 'shape-row';
    row.classList.toggle('active', l.active);
    row.classList.toggle('locked', l.locked);
    row.setAttribute('role', 'option');
    // Selected is what the row says; the one being edited is marked on top of that, because the
    // settings panel can only ever show one of them.
    row.setAttribute('aria-selected', String(l.selected));
    row.dataset.index = String(l.index);
    row.innerHTML = `<button type="button" class="shape-pick">${shapeThumb(l.outer, l.inner)}<span class="nm"></span>`
      + '<span class="shape-flag" aria-hidden="true" hidden><i class="ph ph-arrow-counter-clockwise"></i></span></button>'
      + `<button type="button" class="btn ghost small icon shape-lock"><i class="ph ${l.locked ? 'ph-lock-simple' : 'ph-lock-simple-open'}"></i></button>`
      + '<button type="button" class="btn ghost small icon shape-del"><i class="ph ph-trash"></i></button>';
    row.querySelector('.nm').textContent = l.drafting ? `${name} — unfinished` : l.empty ? `${name} — empty` : name;
    const del = row.querySelector('.shape-del');
    del.hidden = !many || l.locked;
    setTip(del, `Delete ${name} — take this shape off the plate, settings and all. You can undo it.`);
    setTip(row.querySelector('.shape-lock'), l.locked
      ? `Unlock ${name} — let it be selected, moved and edited again.`
      : `Lock ${name} — put it out of reach. It stays on the canvas and in the STL, but cannot be selected, moved or drawn on, and Select all passes it by.`);
    shapesList.append(row);
  }
  syncShapeFlags(list);
  $('settingsScope').hidden = !many;
  $('settingsScopeName').textContent = `Shape ${editor.index + 1}`;
  // Another empty shape beside an empty one is nothing; finish this one first.
  const add = $('addShapeBtn');
  add.disabled = !editor.hasOuter;
  setTip(add, add.disabled
    ? 'Add shape — draw this shape first. Every shape on the plate is a cutter of its own.'
    : 'Add shape — another cutter on the same plate, with its own size, walls and settings.');
  syncOverlapRow();
}

// The same arrow the settings panel puts beside a number, one level up: this shape is not on the
// standard settings. It is a marker and nothing else — the row it sits in switches shapes, and
// putting the settings back is the panel's job, where you can see what you are changing. It has
// to keep up with typing as well as with drawing, so it is updated from `onParamsChanged()` too
// and does not redraw the rows (or their thumbnails) to do it.
function syncShapeFlags(list = editor.layerList()) {
  for (const row of shapesList.querySelectorAll('.shape-row')) {
    const l = list[+row.dataset.index];
    if (!l) continue;
    const n = offDefaultCount(shapeCtx(editor.layers[l.index], l.inner));
    if (row.dataset.off === String(n)) continue;
    row.dataset.off = String(n);
    row.querySelector('.shape-flag').hidden = n === 0;
    const name = `Shape ${l.index + 1}`;
    const off = n === 0 ? ''
      : n === 1
        ? ' One setting of it is not the standard one — the arrow says so, and the settings panel can put it back.'
        : ` ${n} of its settings are not the standard ones — the arrow says so, and the settings panel can put them back.`;
    setTip(row.querySelector('.shape-pick'), (l.active
      ? `${name} — the shape you are working on. Its size, walls and connections are what the settings panel shows.`
      : `${name} — switch to this shape. The one you are on now goes grey and cannot be moved until you come back.`) + off);
  }
}

shapesList.addEventListener('click', (e) => {
  const row = e.target.closest('.shape-row');
  if (!row) return;
  const i = Number(row.dataset.index);
  if (e.target.closest('.shape-del')) { deleteShape(i); return; }
  if (e.target.closest('.shape-lock')) { toggleLock(i); return; }
  if (editor.isLocked(i)) { toast(`Shape ${i + 1} is locked — open the padlock in its row to work on it.`); return; }
  // ⌘ on a Mac, Ctrl elsewhere: hold this one as well, or let go of it again — under the Move
  // tool, which is the only one that can hold more than one shape. Elsewhere the modifier means
  // nothing and the press is the plain one: work on this shape.
  if ((e.metaKey || e.ctrlKey) && editor.canHoldMany) {
    const was = editor.selectionCount;
    if (!editor.pickShape(i, 'toggle')) return;
    const n = editor.selectionCount;
    toast(n > was ? `${n} shapes held — Center, Align and Flip act on all of them.` : `${n} shape${n === 1 ? '' : 's'} held.`);
    return;
  }
  if (row.classList.contains('active') && !editor.multi) return;
  const switching = !row.classList.contains('active');
  editor.pickShape(i, 'only');
  if (switching) toast(`Shape ${i + 1} — the others are greyed out until you come back.`);
});

function toggleLock(i) {
  const on = !editor.isLocked(i);
  if (!editor.lockLayer(i, on)) return;
  toast(on
    ? `Shape ${i + 1} is locked — it stays on the plate and in the STL, but nothing can move or change it.`
    : `Shape ${i + 1} is unlocked.`);
}

// Lock every shape being held in one press. With none held it is the way back: everything on the
// plate that is locked, let go of at once — a locked shape cannot be held, so "the selected ones"
// has nothing to point at on the way out.
$('lockSelBtn').addEventListener('click', () => {
  const held = editor.selection;
  if (held.length > 1) {
    const n = editor.lockLayers(held, true);
    if (n) toast(`${n} shapes locked — they stay on the plate and in the STL, but nothing can move or change them.`);
    return;
  }
  const locked = editor.lockedLayers;
  const n = editor.lockLayers(locked, false);
  if (n) toast(n === 1 ? 'Shape unlocked.' : `${n} shapes unlocked.`);
});

// Everything on the plate at once, so Center, Align and Flip act on the lot; pressing it again
// puts the shapes back down. Locked shapes are passed by, so the count says what was taken.
$('selectAllBtn').addEventListener('click', () => {
  if (!editor.canHoldMany) return;   // not offered outside the Move tool; here for the shortcut
  const all = editor.unlockedCount;
  if (editor.selectionCount >= all && all > 0) { editor.dropShape(); toast('Shapes put down.'); return; }
  const n = editor.selectAll();
  if (!n) { toast('Every shape on this plate is locked.'); return; }
  const skipped = editor.layerCount - n;
  toast(skipped
    ? `${n} shapes held — ${skipped} locked shape${skipped === 1 ? ' was' : 's were'} left out.`
    : `${n} shapes held — Center, Align and Flip act on all of them.`);
});

// The foot of the shapes list, which follows the tool as much as the plate. Holding shapes is the
// Move tool's, so Select all and the lock row are simply not there under Draw or Points — a
// control that cannot do what it says is worse than no control. Unlocking is the exception: it is
// about the lock, not about the selection, so it is offered wherever there is a lock to open.
function syncSelectRow() {
  const move = editor.canHoldMany;
  const all = editor.unlockedCount, n = editor.selectionCount;
  const full = all > 0 && n >= all;
  const selShow = move && all >= 2;
  $('selectAllBtn').hidden = !selShow;
  if (selShow) {
    $('selectAllLabel').textContent = full ? 'Put the shapes down' : 'Select all';
    $('selCount').textContent = n > 1 ? `${n} held` : '';
    setTip($('selectAllBtn'), full
      ? 'Put the shapes down — let go of all of them. The shape you are working on stays the one the settings panel shows.'
      : 'Select all — hold every shape on the plate at once, so Center, Align and Flip act on the lot. Locked shapes are left out. (⌘A / Ctrl+A)');
  }
  // Locking is offered for the shapes you are holding — so only where several can be held at all;
  // unlocking for the ones that are locked, because a locked shape cannot be held and so cannot be
  // pointed at that way.
  const locked = editor.layerCount - all;
  const mode = move && n > 1 ? 'lock' : locked > 0 ? 'unlock' : null;
  $('lockSelBtn').hidden = !mode;
  if (!mode) return;
  $('lockSelIcon').className = `ph ${mode === 'lock' ? 'ph-lock-simple' : 'ph-lock-simple-open'}`;
  $('lockSelLabel').textContent = mode === 'lock'
    ? `Lock these ${n} shapes`
    : locked === 1 ? 'Unlock the locked shape' : `Unlock all ${locked} shapes`;
  setTip($('lockSelBtn'), mode === 'lock'
    ? `Lock these ${n} shapes — put all of them out of reach at once. They stay on the plate and in the STL; the padlock in a row lets one back in.`
    : locked === 1
      ? 'Unlock the locked shape — let it be selected, moved and edited again.'
      : `Unlock all ${locked} shapes — let every locked shape on the plate be selected, moved and edited again.`);
}

$('addShapeBtn').addEventListener('click', () => {
  editor.addLayer();
  setActive('outer');
  setShapesOpen(true);
  toast(`Shape ${editor.index + 1} added — draw it clear of the others. It keeps its own size, walls and settings.`);
});

// A file puts its shapes where it wants them, which may be on top of each other. Nothing is
// moved — the arrangement is the file's — but what that means is worth saying: shapes that run
// into each other come off the printer as one piece, so they are built as one object.
function shapeNames(list) { return list.map(i => i + 1).join(', '); }

// Did this file need the guard lowered? Read off the drawing, for the files that cannot say so
// themselves: an SVG sheet whose charms touch, an STL of a plate that was modelled as one piece.
let overlapAdopted = false;
function adoptOverlapFromDrawing() {
  overlapAdopted = !editor.allowOverlap && editor.clashingLayers().length > 0;
  if (overlapAdopted) setOverlapAllowed(true);
}

function warnIfClashing() {
  const bad = editor.clashingLayers();
  if (!bad.length) { overlapAdopted = false; return; }
  toast(overlapAdopted
    ? `Shapes ${shapeNames(bad)} run into each other, so “Allow overlap” is on — they come out as one merged object.`
    : `Shapes ${shapeNames(bad)} overlap — they come out as one merged object. Move them apart to print them separately.`);
  overlapAdopted = false;
}

async function deleteShape(i) {
  const list = editor.layerList();
  if (list.length < 2) return;
  if (!list[i].empty) {
    const ok = await confirmAction(`Delete shape ${i + 1}?`,
      'It comes off the plate with its own size, walls and settings. You can undo this.', 'Delete');
    if (!ok) return;
  }
  editor.removeLayer(i);
  toast('Shape deleted.');
}

// On a phone the list would take a bite out of the canvas, so it folds away behind its header
// and follows the width of the window — until you fold or unfold it yourself, after which it
// stays the way you left it.
function setShapesOpen(open) {
  $('shapesToggle').setAttribute('aria-expanded', String(open));
  shapesList.hidden = !open;
  syncOverlapRow();
}
const narrowScreen = window.matchMedia('(max-width: 760px)');
let shapesFoldedByHand = false;
const followScreenWidth = () => { if (!shapesFoldedByHand) setShapesOpen(!narrowScreen.matches); };
$('shapesToggle').addEventListener('click', () => { shapesFoldedByHand = true; setShapesOpen(shapesList.hidden); });
narrowScreen.addEventListener('change', followScreenWidth);
followScreenWidth();

// ---------- point selection bar & context menu ----------
function updatePointBar(sel) {
  const bar = $('pointBar');
  if (!sel || editor.tool !== 'points') { bar.hidden = true; return; }
  setToolTipOpen(false);   // a tip tapped open on touch has no business over the point bar
  const p = sel.point, curved = !!(p.in || p.out);
  $('pointLabel').textContent = `Point ${sel.index + 1} of ${editor.points.length}`;
  $('ptCurveBtn').hidden = curved;
  $('ptResetBtn').hidden = !curved;
  $('ptRemoveCurveBtn').hidden = !curved;
  $('ptSyncBtn').hidden = !curved;
  $('ptSyncBtn').setAttribute('aria-pressed', String(p.smooth !== false));
  setField('ptX', p.x); setField('ptY', p.y);
  $('ptHandleIn').hidden = !curved;
  $('ptHandleOut').hidden = !curved;
  if (curved) {
    setField('ptInX', p.in?.x ?? 0); setField('ptInY', p.in?.y ?? 0);
    setField('ptOutX', p.out?.x ?? 0); setField('ptOutY', p.out?.y ?? 0);
  }
  bar.hidden = false;
}

// Never overwrite the box someone is typing in — the selection is refreshed on every change.
function setField(id, v) {
  const el = $(id);
  if (document.activeElement !== el) el.value = String(Math.round(v * 100) / 100);
}

function readPointFields() {
  const i = editor.selected;
  if (i < 0) return;
  editor.movePoint(i, parseFloat($('ptX').value), parseFloat($('ptY').value));
}
function readHandleField(which) {
  const i = editor.selected;
  if (i < 0) return;
  const px = which === 'in' ? 'ptInX' : 'ptOutX', py = which === 'in' ? 'ptInY' : 'ptOutY';
  editor.setHandle(i, which, parseFloat($(px).value), parseFloat($(py).value));
}
['ptX', 'ptY'].forEach(id => $(id).addEventListener('change', readPointFields));
['ptInX', 'ptInY'].forEach(id => $(id).addEventListener('change', () => readHandleField('in')));
['ptOutX', 'ptOutY'].forEach(id => $(id).addEventListener('change', () => readHandleField('out')));
// Enter commits without leaving the box, and the arrow keys are the spinner's, not the canvas'.
['ptX', 'ptY', 'ptInX', 'ptInY', 'ptOutX', 'ptOutY'].forEach(id => {
  $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } e.stopPropagation(); });
});

$('ptCurveBtn').addEventListener('click', () => editor.setCurve(editor.selected, 'add'));
$('ptResetBtn').addEventListener('click', () => editor.setCurve(editor.selected, 'reset'));
$('ptRemoveCurveBtn').addEventListener('click', () => editor.setCurve(editor.selected, 'remove'));
$('ptSyncBtn').addEventListener('click', () => editor.setSmooth(editor.selected, $('ptSyncBtn').getAttribute('aria-pressed') !== 'true'));
$('ptDeleteBtn').addEventListener('click', () => editor.deletePoint());

// ---------- shape position bar ----------
// The same idea as the point bar, for the shape the Move tool is holding: where it sits, so a
// cutter can be placed by number instead of by eye. It reads the middle of the wall being
// edited — the box the move handles are drawn on.
function updateShapeBar() {
  const bar = $('shapeBar');
  // Only while the tool is actually holding a shape — with nothing picked up there is no
  // position to show and nothing the numbers would move.
  const pos = editor.tool === 'move' && editor.picked ? editor.shapePos : null;
  if (!pos) { bar.hidden = true; return; }
  const n = editor.selectionCount;
  $('shapeBarLabel').textContent = n > 1 ? `${n} shapes`
    : editor.active === 'inner' ? 'Inner wall'
      : editor.layerCount > 1 ? `Shape ${editor.index + 1}` : 'Shape';
  setTip($('shapeBar').querySelector('.field-group'), n > 1
    ? 'Where the middle of the shapes you are holding sits on the canvas. Typing a number moves all of them together; the arrow keys do the same, by 1 mm (5 mm with Shift).'
    : 'Where the middle of this shape sits on the canvas — x to the right, y downwards, from the middle of the canvas. Arrow keys move it by 1 mm (5 mm with Shift); hold Shift while dragging to keep it on one line.');
  setField('shX', pos.x); setField('shY', pos.y);
  bar.hidden = false;
}

function readShapeFields() {
  editor.moveShapeTo(parseFloat($('shX').value), parseFloat($('shY').value));
  updateShapeBar();   // a move a neighbour refused must not leave the box claiming it happened
}
['shX', 'shY'].forEach(id => {
  $(id).addEventListener('change', readShapeFields);
  // Enter commits without leaving the box, and the arrow keys are the spinner's, not the canvas'.
  $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } e.stopPropagation(); });
});

function openPointMenu(info) {
  const m = $('ctxMenu');
  const curved = !!(info.point.in || info.point.out);
  m.querySelector('[data-act=curve]').hidden = curved;
  m.querySelector('[data-act=reset]').hidden = !curved;
  m.querySelector('[data-act=straight]').hidden = !curved;
  const sync = m.querySelector('[data-act=sync]');
  sync.hidden = !curved; sync.textContent = info.point.smooth === false ? 'Sync handles: off → turn on' : 'Sync handles: on → turn off';
  m.hidden = false;
  const x = Math.min(info.clientX, window.innerWidth - m.offsetWidth - 8), y = Math.min(info.clientY, window.innerHeight - m.offsetHeight - 8);
  m.style.left = `${x}px`; m.style.top = `${y}px`;
}
function closeMenu() { $('ctxMenu').hidden = true; }
$('ctxMenu').addEventListener('click', (e) => {
  const act = e.target.dataset.act; if (!act) return;
  const i = editor.selected;
  if (act === 'curve') editor.setCurve(i, 'add');
  else if (act === 'reset') editor.setCurve(i, 'reset');
  else if (act === 'straight') editor.setCurve(i, 'remove');
  else if (act === 'sync') editor.setSmooth(i, editor.points[i]?.smooth === false);
  else if (act === 'delete') editor.deletePoint(i);
  closeMenu();
});
document.addEventListener('pointerdown', (e) => { if (!$('ctxMenu').hidden && !$('ctxMenu').contains(e.target)) closeMenu(); }, true);
window.addEventListener('blur', closeMenu);

// ---------- 3D view buttons ----------
$('fitBtn').addEventListener('click', () => viewer.fit());
$('topBtn').addEventListener('click', () => viewer.viewTop());
$('backBtn').addEventListener('click', () => viewer.viewFromBelow());

// ---------- the cut piece ----------
// What the cutter leaves behind, in a popup: the cut line filled in, the inner wall punched out,
// shaded as a slab so it reads as clay on a worktop instead of as another drawing. A cutter is
// used upside-down, so the piece comes out the way the 3D "Back" view shows it — mirrored from
// the drawing unless Mirror is on. The colour belongs to the sitting, not to the cutter: it is
// not saved with the project, it is only there to see the shape in the clay you will use.
const resultDlg = $('resultDialog'), resultColors = $('resultColors');
let clayColor = '#c8714a';

$('resultBtn').addEventListener('click', openResult);

function openResult() {
  const b = editor.allBounds();
  if (!b) { toast('Draw a shape first — then you can see the piece it cuts.'); return; }
  $('resultSize').textContent = `${b.width.toFixed(1)} × ${b.height.toFixed(1)} mm`;
  syncResultMirror();
  resultDlg.showModal();
  renderResult();
}

// The stage has no size until the dialog is laid out, and it changes again with the window, so
// the canvas follows its box rather than guessing when the box is ready.
new ResizeObserver(() => renderResult()).observe($('resultCanvas').parentElement);

resultColors.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-color]');
  if (b) setClayColor(b.dataset.color);
});
$('resultColor').addEventListener('input', (e) => setClayColor(e.target.value));

function setClayColor(hex) {
  clayColor = hex;
  $('resultColor').value = hex;
  for (const b of resultColors.querySelectorAll('button[data-color]'))
    b.setAttribute('aria-pressed', String(b.dataset.color.toLowerCase() === hex.toLowerCase()));
  renderResult();
}

// Mirror is one setting with two switches: the checkbox under Export and the button in the
// popup. It turns over the whole plate, so it is the one wall setting every shape shares.
function setMirror(on) {
  for (const l of editor.layers) l.params.mirror = on;
  $('pMirror').checked = on;
  onParamsChanged();
  syncResultMirror();
  renderResult();
}
$('resultMirrorBtn').addEventListener('click', () => setMirror(!params.mirror));

// Whether the shapes on this plate may run into each other. It belongs to the plate rather than
// to any one shape, which is why it sits under the shapes list and not in the settings panel. It
// governs the guard and nothing else: what the builder does with shapes that really do overlap is
// decided by the shapes themselves, so a plate that came in overlapping stays one merged object
// even with the guard back up.
function setOverlapAllowed(on, { note = false } = {}) {
  editor.allowOverlap = !!on;
  syncOverlapRow();
  if (!note) return;
  const bad = editor.clashingLayers();
  if (on) {
    toast(bad.length
      ? `Shapes may overlap now — shapes ${shapeNames(bad)} already do, and come out as one merged object.`
      : 'Shapes may overlap now — where two of them run into each other they come out as one merged object.');
  } else {
    toast(bad.length
      ? `Shapes ${shapeNames(bad)} still overlap — nothing is moved, so they stay one merged object until you move them apart.`
      : 'Shapes stay apart again — a shape now stops against its neighbour.');
  }
}
$('overlapBtn').addEventListener('click', () => setOverlapAllowed(!editor.allowOverlap, { note: true }));

function syncResultMirror() {
  const row = $('resultMirror'), matters = mirrorMatters();
  row.hidden = !matters;
  if (!matters) return;   // a shape that is its own mirror image comes out the same either way
  $('resultMirrorText').textContent = params.mirror
    ? 'The cutter is mirrored, so this comes out the same way round as you drew it.'
    : 'A cutter is used upside-down, so this comes out mirrored from your drawing.';
  $('resultMirrorBtn').setAttribute('aria-pressed', String(params.mirror));
}

// Does the Mirror setting change the piece at all? It does not for a shape that is its own
// mirror image — the two results are then the same piece, turned round. Only the two obvious
// axes are tested, and anything the test cannot settle counts as "it matters", so the sentence
// is never withheld from a shape that really does come out back-to-front.
// With more than one shape it always matters: mirroring turns the whole plate over, so the
// shapes swap sides even when each of them is its own mirror image.
function mirrorMatters() {
  const drawn = editor.layerList().filter(l => !l.empty);
  if (!drawn.length) return false;
  if (drawn.length > 1) return true;
  if (editor.sym.x || editor.sym.y) return false;
  const shape = { outer: drawn[0].outer, inner: drawn[0].inner };
  try { return !(sameAfterFlip(shape, 'x') || sameAfterFlip(shape, 'y')); } catch { return true; }
}

function sameAfterFlip(shape, axis) {
  const c = bounds(shape.outer);
  // both contours turn about the outer wall's centre, and the winding is restored with reverse()
  const flip = (pts) => pts.map(p => ({ x: axis === 'x' ? 2 * c.cx - p.x : p.x, y: axis === 'y' ? 2 * c.cy - p.y : p.y })).reverse();
  const area = (pts) => Math.abs(signedArea(pts));
  const same = (pts) => {
    const union = unionPolygons([pts, flip(pts)]).reduce((t, p) => t + area(p), 0);
    return union <= area(pts) * 1.02;   // 2% of overhang counts as drawn by hand, not as asymmetric
  };
  return same(shape.outer) && (shape.inner.length < 3 || same(shape.inner));
}

// hex → rgb; amount > 0 lightens towards white, < 0 darkens towards black
function shade(hex, amount) {
  const h = hex.replace('#', '');
  const n = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  const v = parseInt(n, 16);
  const ch = [(v >> 16) & 255, (v >> 8) & 255, v & 255]
    .map(c => Math.round(amount > 0 ? c + (255 - c) * amount : c * (1 + amount)));
  return `rgb(${ch[0]}, ${ch[1]}, ${ch[2]})`;
}

// The contours to draw for the whole plate: the outlines to measure it by, and every ring the
// even-odd fill needs. Where two shapes run into each other the clay comes away as one piece, so
// their outlines are joined first and the holes cut out of the join — left as they are, even-odd
// would punch the overlap out and draw a hole where the piece is thickest. With the shapes apart
// the outlines as drawn are already the right answer, and nothing is handed to Clipper.
function pieceRings(pieces) {
  const outers = pieces.map(pc => pc.outer), holes = pieces.map(pc => pc.inner).filter(Boolean);
  const plain = { outers, rings: outers.concat(holes) };
  if (outers.length < 2) return plain;
  const boxes = outers.map(bounds);
  const apart = (a, b) => a.maxX < b.minX || b.maxX < a.minX || a.maxY < b.minY || b.maxY < a.minY;
  let meet = false;
  for (let a = 0; a < boxes.length && !meet; a++)
    for (let b = a + 1; b < boxes.length && !meet; b++) meet = !apart(boxes[a], boxes[b]);
  if (!meet) return plain;
  try {
    // Clipper fills by winding, so every outline has to run the same way round before it is joined.
    const ccw = (pts) => (signedArea(pts) < 0 ? pts.slice().reverse() : pts);
    const merged = unionPolygons(outers.map(ccw));
    if (!merged.length) return plain;
    const cut = holes.length ? subtractPolygons(merged, holes.map(ccw)) : merged;
    return { outers: merged, rings: cut.length ? cut : merged };
  } catch { return plain; }   // a picture of the piece is worth more than a perfect one
}

function renderResult() {
  if (!resultDlg.open) return;
  const cv = $('resultCanvas'), stage = cv.parentElement;
  const w = Math.max(1, stage.clientWidth), h = Math.max(1, stage.clientHeight);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  cv.style.width = `${w}px`; cv.style.height = `${h}px`;
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const top = ctx.createRadialGradient(w / 2, h * 0.4, 0, w / 2, h * 0.4, Math.max(w, h) * 0.8);
  top.addColorStop(0, '#2b2e3e'); top.addColorStop(1, '#14161f');
  ctx.fillStyle = top; ctx.fillRect(0, 0, w, h);

  // Every shape on the plate, in the places they sit in — this is what the cutter leaves behind.
  const drawn = editor.layerList().filter(l => !l.empty);
  if (!drawn.length) return;
  // The face that meets the clay. A cutter is used upside-down, so unless the model is mirrored
  // already the piece is a mirror image of the drawing. It is turned over left–right rather than
  // top–bottom: the two differ only by turning the piece round on the table, and the sideways one
  // keeps the drawing the right way up, so what you see is the mirroring and nothing else.
  const face = (pts) => pts.map(p => ({ x: params.mirror ? p.x : -p.x, y: p.y }));
  const pieces = drawn.map(l => ({ outer: face(l.outer), inner: l.inner.length >= 3 ? face(l.inner) : null }));
  const { outers, rings } = pieceRings(pieces);
  const b = bounds(outers.flat());
  const scale = Math.min(w / Math.max(b.width, 0.001), h / Math.max(b.height, 0.001)) * 0.76;
  const depth = Math.max(4, Math.min(16, Math.min(w, h) * 0.04));   // apparent thickness of the slab
  const toPx = (p) => ({ x: w / 2 + (p.x - b.cx) * scale, y: h / 2 - depth / 2 + (p.y - b.cy) * scale });
  const path = (pts) => {
    const p0 = toPx(pts[0]); ctx.moveTo(p0.x, p0.y);
    for (let i = 1; i < pts.length; i++) { const q = toPx(pts[i]); ctx.lineTo(q.x, q.y); }
    ctx.closePath();
  };
  // What the clay is: one region per lump of it. Where two shapes run into each other that is
  // their join, not two pieces lying on top of one another.
  const piece = () => {
    ctx.beginPath();
    for (const r of rings) path(r);
  };
  // Where it is cut. Every blade on the plate leaves an edge, the ones that run through the
  // middle of a join included — that is where the clay comes apart into separate pieces.
  const edges = () => {
    ctx.beginPath();
    for (const pc of pieces) { path(pc.outer); if (pc.inner) path(pc.inner); }
  };

  // a second copy pushed down behind the top face gives the piece a cut edge and a shadow
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.5)'; ctx.shadowBlur = depth * 2.2; ctx.shadowOffsetY = depth * 0.8;
  ctx.translate(0, depth);
  piece(); ctx.fillStyle = shade(clayColor, -0.42); ctx.fill('evenodd');
  ctx.restore();

  // the top face, lit from above
  ctx.save();
  piece();
  const lit = ctx.createLinearGradient(0, h / 2 - (b.height * scale) / 2, 0, h / 2 + (b.height * scale) / 2);
  lit.addColorStop(0, shade(clayColor, 0.14)); lit.addColorStop(1, shade(clayColor, -0.09));
  ctx.fillStyle = lit; ctx.fill('evenodd');
  ctx.clip('evenodd');
  // shading where the surface rolls over the cut edge: a fat line on the outline, blurred and
  // clipped to the piece, so the edge darkens gradually instead of drawing a second outline.
  // A browser without canvas filters simply gets the unblurred band.
  ctx.filter = `blur(${(depth * 0.6).toFixed(1)}px)`;
  ctx.lineWidth = depth * 1.6; ctx.strokeStyle = 'rgba(0, 0, 0, 0.2)'; ctx.lineJoin = 'round';
  edges(); ctx.stroke();
  ctx.filter = 'none';
  const sheen = ctx.createRadialGradient(w * 0.34, h * 0.28, 0, w * 0.34, h * 0.28, Math.max(w, h) * 0.62);
  sheen.addColorStop(0, 'rgba(255, 255, 255, 0.16)'); sheen.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = sheen; ctx.fillRect(0, 0, w, h);
  ctx.restore();

  edges(); ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(0, 0, 0, 0.28)'; ctx.stroke();
}

setClayColor(clayColor);   // marks the swatch that is on; the canvas waits until the popup opens

// ---------- confirm dialog ----------
// For the few actions that reshape what is already drawn; resolves false on Cancel or Esc.
function confirmAction(title, body, okLabel = 'Continue') {
  const dlg = $('confirmDialog');
  $('confirmTitle').textContent = title;
  $('confirmBody').textContent = body;
  $('confirmOkLabel').textContent = okLabel;
  return new Promise((resolve) => {
    const done = (ok) => {
      dlg.removeEventListener('submit', onSubmit);
      dlg.removeEventListener('close', onClose);
      resolve(ok);
    };
    const onSubmit = () => done(true);   // the close event that follows finds no listener left
    const onClose = () => done(false);   // Cancel, Esc, or a click on the backdrop
    dlg.addEventListener('submit', onSubmit);
    dlg.addEventListener('close', onClose);
    dlg.showModal();
    $('confirmOkBtn').focus();
  });
}
$('confirmCancelBtn').addEventListener('click', () => $('confirmDialog').close());

// ---------- the import question ----------
// A file arriving on a plate that already has something on it can mean two things, and only the
// person who dropped it knows which: another cutter beside the ones there, or a fresh start.
// Resolves 'add', 'replace', or null on Cancel and Esc. An empty canvas is not asked — there is
// nothing to keep and nothing to replace.
function askImportMode(file, count, title, body) {
  if (!editor.hasAnyShape) return Promise.resolve('replace');
  const dlg = $('importDialog');
  $('importTitle').textContent = title;
  $('importBody').textContent = body;
  $('importAddLabel').textContent = count > 1 ? `Add ${count} shapes` : 'Add as a shape';
  $('importReplaceLabel').textContent = 'Replace the drawing';
  dlg.returnValue = '';
  return new Promise((resolve) => {
    const done = (v) => {
      dlg.removeEventListener('submit', onSubmit);
      dlg.removeEventListener('close', onClose);
      resolve(v === 'add' || v === 'replace' ? v : null);
    };
    // The answer is the button that was pressed, read off the submit rather than off the close
    // that follows it — the same way confirmAction() does, and for the same reason.
    const onSubmit = (e) => done(e.submitter?.value || dlg.returnValue);
    const onClose = () => done(dlg.returnValue);   // Esc, or a click on the backdrop
    dlg.addEventListener('submit', onSubmit);
    dlg.addEventListener('close', onClose);
    if (!dlg.open) dlg.showModal();
    $('importAddBtn').focus();
  });
}

// ---------- the loader ----------
// Reading a file and building the solid both happen on the main thread and both take long enough
// on a big drawing to look like nothing is happening. The veil says otherwise — and it has to be
// painted before the work starts, which is why putting it up is something you wait for.
async function showLoader(text) {
  $('loaderText').textContent = text;
  $('loader').hidden = false;
  // Two frames is one painted frame. A tab in the background is never painted and never gets a
  // frame either, so the wait is raced against a timer — an import must not be able to hang on
  // the user having looked at something else for a moment.
  await new Promise(resolve => {
    const done = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(done, 60);
    requestAnimationFrame(() => requestAnimationFrame(done));
  });
}
function hideLoader() { $('loader').hidden = true; }

// Everything an import does, behind one veil. The 3D build that follows is part of the same wait,
// so with `build` it is pulled out of its debounce and done here rather than after the veil has
// come down and the app looks finished.
async function withLoader(text, fn, { build = false } = {}) {
  await showLoader(text);
  try {
    const out = await fn();
    if (build) { clearTimeout(regenTimer); regenerate(); }
    return out;
  } finally {
    hideLoader();
  }
}

// ---------- toast ----------
let toastTimer;
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 4200);
}

// ---------- start ----------
// The solid modeller (Manifold, WebAssembly) loads in the background; the 3D preview waits for it.
$('viewerHint').querySelector('p').textContent = 'Loading the 3D engine…';
loadManifold().then(() => {
  $('viewerHint').querySelector('p').textContent = 'The cutter appears here as soon as there is a shape. Drag to turn it, pinch or scroll to zoom.';
  regenerate();
}).catch((e) => {
  const err = $('errorBox');
  err.textContent = 'The 3D engine could not load (' + (e.message || e) + '). Please use a current browser with WebAssembly support.';
  err.hidden = false;
});
drawProfile();
$('ridgeFields').hidden = !params.ridge;
$('secInnerWrap').hidden = true;
updateHint(editor.getShape());
shownLayer = editor.layer.id;
renderShapeList();

// ---------- edits 3 & 4: chrome wiring (flyout, collapsible sections, summaries) ----------

// The Canvas setup flyout holds what used to be the bottom assist bar.
const flyout = $('canvasFlyout'), flyoutBtn = $('canvasSetupBtn');
function setFlyout(open) {
  flyout.hidden = !open;
  flyoutBtn.setAttribute('aria-pressed', String(open));
  flyoutBtn.setAttribute('aria-expanded', String(open));
}
flyoutBtn.addEventListener('click', () => setFlyout(flyout.hidden));
$('canvasFlyoutClose').addEventListener('click', () => setFlyout(false));
document.addEventListener('pointerdown', (e) => {
  if (flyout.hidden) return;
  if (!flyout.contains(e.target) && !flyoutBtn.contains(e.target)) setFlyout(false);
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !flyout.hidden) setFlyout(false); });

// Collapsible settings sections.
document.querySelectorAll('.sec-head').forEach(head => {
  head.addEventListener('click', () => {
    const body = document.getElementById(head.getAttribute('aria-controls'));
    const open = head.getAttribute('aria-expanded') !== 'true';
    head.setAttribute('aria-expanded', String(open));
    body.hidden = !open;
  });
});

// Collapsed heads carry the value, so nothing is hidden from view.
function setReady(text) { const n = $('readyNote'); if (n) n.textContent = text; }
function refreshSummaries() {
  const s = editor.getSize();
  $('sumSize').textContent = s && s.width ? `${s.width.toFixed(1)} × ${s.height.toFixed(1)} mm` : '—';
  $('sumWalls').textContent = `${params.height} mm · ${params.bladeWidth} mm blade`;
  const inner = editor.getShape().inner;
  $('sumInner').textContent = inner && inner.length >= 3 ? `${params.bridgeCount} bars` : 'none yet';
  $('sumExport').textContent = `${(($('fileName').value || 'cutter').trim())}.stl`;
}
document.querySelector('.pane-settings').addEventListener('input', refreshSummaries);
document.querySelector('.pane-settings').addEventListener('change', refreshSummaries);
editor.canvas.addEventListener('pointerup', () => setTimeout(refreshSummaries, 0));
refreshSummaries();

// handy for debugging in the browser console
window.cutter = { editor, viewer, get params() { return editor.params; }, get layers() { return editor.layers; } };

// ---------- explanation tooltips ----------
// Icon-only buttons carry no label, so what they do has to be spelled out somewhere. Native
// title tooltips are slow, unstyled and never show on touch, so every title= is moved onto
// data-tip and rendered here instead. New markup only needs a title= to join in.
const tipBubble = document.createElement('div');
tipBubble.className = 'tip-bubble';
tipBubble.setAttribute('role', 'tooltip');
tipBubble.hidden = true;
document.body.appendChild(tipBubble);

// Re-label a control whose explanation depends on which wall is being edited.
function setTip(el, text) {
  el.dataset.tip = text;
  if (!el.textContent.trim()) el.setAttribute('aria-label', text);
  if (tipTarget === el) { tipTarget = null; showTip(el); }
}

function adoptTitles(root = document) {
  for (const el of root.querySelectorAll('[title]')) {
    el.dataset.tip = el.getAttribute('title');
    el.removeAttribute('title');
    // Screen readers get the same explanation; on a labelled control it describes, not replaces.
    if (!el.hasAttribute('aria-label') && !el.textContent.trim()) el.setAttribute('aria-label', el.dataset.tip);
  }
}
adoptTitles();
syncWallActions();   // re-applies the tips that depend on which wall is being edited

function placeTip(el) {
  const r = el.getBoundingClientRect();
  tipBubble.hidden = false;
  const t = tipBubble.getBoundingClientRect();
  const gap = 8;
  let left = r.left + r.width / 2 - t.width / 2;
  left = Math.min(Math.max(8, left), window.innerWidth - t.width - 8);
  // Below the control, unless that would run off the bottom.
  const top = r.bottom + gap + t.height > window.innerHeight ? r.top - gap - t.height : r.bottom + gap;
  tipBubble.style.left = `${Math.round(left)}px`;
  tipBubble.style.top = `${Math.round(top)}px`;
}
function showTip(el) {
  const text = el.dataset.tip;
  if (!text || el === tipTarget) return;
  tipTarget = el;
  // Bold the leading "Name — " so the label reads first on an icon-only button.
  const dash = text.indexOf(' — ');
  tipBubble.textContent = '';
  if (dash > 0) {
    const b = document.createElement('b'); b.textContent = text.slice(0, dash);
    tipBubble.append(b, text.slice(dash));
  } else {
    tipBubble.textContent = text;
  }
  placeTip(el);
  requestAnimationFrame(() => tipBubble.classList.add('show'));
}
function hideTip() {
  clearTimeout(tipTimer); tipTimer = 0; tipTarget = null;
  tipBubble.classList.remove('show');
  tipBubble.hidden = true;
}
const tipFor = (e) => e.target.closest && e.target.closest('[data-tip]');

document.addEventListener('pointerover', (e) => {
  if (e.pointerType === 'touch') return;              // touch gets it on long-press instead
  const el = tipFor(e);
  if (!el) { if (tipTarget) hideTip(); return; }
  if (el === tipTarget) return;
  hideTip();
  tipTimer = setTimeout(() => showTip(el), 350);      // only for a real pause, not a pass-over
});
document.addEventListener('pointerout', (e) => { if (tipFor(e) === tipTarget) hideTip(); });
document.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'touch') hideTip(); });
document.addEventListener('focusin', (e) => { const el = tipFor(e); if (el) showTip(el); });
document.addEventListener('focusout', hideTip);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideTip(); });
window.addEventListener('scroll', hideTip, true);
window.addEventListener('resize', hideTip);

// Touch: hold a control to read what it does, without firing it.
document.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'touch') return;
  const el = tipFor(e);
  if (el) tipTimer = setTimeout(() => showTip(el), 450);
}, true);
document.addEventListener('pointerup', (e) => {
  if (e.pointerType !== 'touch') return;
  if (tipTarget) setTimeout(hideTip, 1800);           // leave it up long enough to read
  else { clearTimeout(tipTimer); tipTimer = 0; }
});

// ---------- canvas zoom & pan ----------
// The editor owns the view state; this only drives the controls and keeps them in sync,
// because the view also changes from the scroll wheel and middle-drag.
const zoomMenu = $('zoomMenu'), zoomBtn = $('zoomBtn'), panBtn = $('panBtn');
const asPct = (z) => `${Math.round(z * 100)}%`;

function syncZoomUI(view) {
  syncScaleBar();
  const pct = asPct(view.zoom);
  $('zoomVal').textContent = pct;
  $('zoomNow').textContent = pct;
  const { min, max } = editor.zoomLimits;
  $('zoomOutBtn').disabled = view.zoom <= min + 1e-6;
  $('zoomInBtn').disabled = view.zoom >= max - 1e-6;
}

function setZoomMenu(open) {
  zoomMenu.hidden = !open;
  zoomBtn.setAttribute('aria-expanded', String(open));
  document.querySelector('.canvas-wrap').classList.toggle('zooming', open);
}
zoomBtn.addEventListener('click', () => setZoomMenu(zoomMenu.hidden));
document.addEventListener('pointerdown', (e) => {
  if (!zoomMenu.hidden && !e.target.closest('.view-zoom')) setZoomMenu(false);
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !zoomMenu.hidden) setZoomMenu(false); });

$('zoomInBtn').addEventListener('click', () => editor.zoomIn());
$('zoomOutBtn').addEventListener('click', () => editor.zoomOut());
$('zoomResetBtn').addEventListener('click', () => { editor.resetView(); setZoomMenu(false); });
document.querySelectorAll('.zoom-presets [data-zoom]').forEach(b => {
  b.addEventListener('click', () => { editor.setZoom(Number(b.dataset.zoom) / 100); setZoomMenu(false); });
});

function setPan(on) {
  panBtn.setAttribute('aria-pressed', String(on));
  editor.setPanMode(on);
  if (on) setZoomMenu(false);
}
panBtn.addEventListener('click', () => setPan(panBtn.getAttribute('aria-pressed') !== 'true'));

document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;           // leave browser zoom and undo alone
  if (e.target.matches('input, textarea, select')) return;
  if (e.key.toLowerCase() === 'h') setPan(panBtn.getAttribute('aria-pressed') !== 'true');
  else if (e.key === '+' || e.key === '=') editor.zoomIn();
  else if (e.key === '-' || e.key === '_') editor.zoomOut();
  else if (e.key === '0') editor.resetView();
});

syncZoomUI(editor.view);
syncWallActions();

// ---------- which panels are on screen ----------
// Each of the three panels can be switched off from the header so the others get its width: the
// canvas on its own to draw in, or the 3D preview on its own to look at the cutter. The canvas and
// the preview are the two panels that actually show the cutter, so one of them always stays —
// the switch of the last one left is disabled instead of quietly doing nothing.
const PANELS = {
  draw: {
    el: document.querySelector('.pane-draw'), btn: $('panelDrawBtn'), cls: 'panes-no-draw',
    tip: 'Canvas — show or hide the drawing area. Hidden, its width goes to the 3D preview.',
    stuck: 'Canvas — the only view on screen. Switch the 3D preview on first if you want to hide this one.',
  },
  view: {
    el: document.querySelector('.pane-3d'), btn: $('panel3dBtn'), cls: 'panes-no-3d',
    tip: '3D preview — show or hide the preview of the cutter. Hidden, its width goes to the canvas.',
    stuck: '3D preview — the only view on screen. Switch the canvas on first if you want to hide this one.',
  },
  settings: {
    el: document.querySelector('.pane-settings'), btn: $('panelSettingsBtn'), cls: 'panes-no-settings',
    tip: 'Settings — show or hide the panel with the size, the walls and the export settings.',
  },
};
const panelOn = { draw: true, view: true, settings: true };

function syncPanels() {
  for (const [key, p] of Object.entries(PANELS)) {
    p.el.hidden = !panelOn[key];
    p.btn.setAttribute('aria-pressed', String(panelOn[key]));
    document.body.classList.toggle(p.cls, !panelOn[key]);
  }
  const alone = panelOn.draw !== panelOn.view;   // exactly one of the two views left
  for (const key of ['draw', 'view']) {
    const p = PANELS[key], stuck = alone && panelOn[key];
    p.btn.disabled = stuck;
    setTip(p.btn, stuck ? p.stuck : p.tip);
  }
}

for (const [key, p] of Object.entries(PANELS)) {
  p.btn.addEventListener('click', () => { panelOn[key] = !panelOn[key]; syncPanels(); });
}
syncPanels();
