import { ShapeEditor, flatten, mapPts } from './editor.js';
import { CutterViewer } from './viewer.js';
import { importSVG } from './svgimport.js';
import { importSTL } from './stlimport.js';
import { PRESETS, PRESET_SIZE_MM } from './presets.js';
import { packProject, unpackProject, PROJECT_EXT } from './project.js';
import { buildAll, toBinarySTL, offsetPolygon, cleanPolygon, bounds, bridgeShapes, signedArea, simplify,
         unionPolygons, loadManifold, manifoldReady, DEFAULT_PARAMS } from './geometry.js';

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
  onBlock: (msg) => toast(msg),
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
$('bridgeAutoBtn').addEventListener('click', () => {
  const on = !editor.layer.bridgeAuto;
  editor.layer.bridgeAuto = on;
  $('bridgeAutoBtn').setAttribute('aria-pressed', String(on));
  if (on) { autoBridgeWidth(editor.getShape()); scheduleRegen(); }
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
  // An outline still being placed comes first: nothing else the hint could say matters while
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
    $('stats').title = `${cm3.toFixed(1)} cm³ · ${result.triangles.toLocaleString()} triangles`
      + (built.length > 1 ? ` · ${built.length} shapes` : '');
    setReady(built.length > 1 ? `${built.length} shapes · ready` : 'Watertight · ready');
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
  const n = result.parts ? result.parts.length : 1;
  toast(`Saved ${name}.stl — ${n > 1 ? `${n} shapes, ` : ''}print it base down, no supports.`);
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
  try {
    state = await unpackProject(await file.arrayBuffer());
  } catch (e) {
    toast(e.message || 'Could not open that project file.');
    return;
  }
  if (editor.hasAnyShape) {
    const ok = await confirmAction('Open this project?',
      'Every shape on the canvas now is replaced by the saved drawing and its settings. This cannot be undone.', 'Open');
    if (!ok) return;
  }
  applyState(state);
  const n = state.layers.length;
  toast(`Opened ${file.name} — ${n > 1 ? `${n} shapes` : 'shape'} and settings restored.`);
  setTimeout(warnIfClashing, 1200);
}

// The shapes go in first, settings and all; everything after that only follows them.
function applyState(state) {
  shownLayer = null;         // force the settings panel to pick up the shape it lands on
  ringsCache.clear();
  editor.setState(state);
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
  try {
    res = importSTL(await file.arrayBuffer());
  } catch (e) {
    toast(e.message || 'Could not read that STL.');
    return;
  }
  if (editor.hasAnyShape) {
    const ok = await confirmAction('Open this STL?',
      'Every shape on the canvas now is replaced by the shapes and the settings read out of the model. This cannot be undone.', 'Open');
    if (!ok) return;
  }
  applyState({
    ...editor.getState(), // the grid, the smoothing and the aspect lock are yours, not the file's
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
  });
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
  if (file) (isSTL(file) ? openSTL : openProject)(file);
});
setSaveEnabled(false);

// ---------- tools ----------
const TOOL_TIPS = {
  draw: 'Drag to sketch the outline in one go.',
  points: 'Tap to place corners one after the other, then click the first one again to close the shape. Hold and pull as you place one and it comes out curved. After that, tap a line to insert a corner. Select one to delete it or give it a curve; right-click (or hold) for the menu.',
  move: 'Drag the shape to move it — hold Shift to keep it on one line. Use the handles to resize, with Alt to resize around the middle, and the top knob to rotate. Arrow keys nudge it by 1 mm. Two fingers pinch and twist.',
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

// Centre, align, flip and clear all act on the wall you are editing, so the controls change with
// it — and they stay out of the way entirely until there is something for them to act on.
function syncWallActions() {
  const inner = editor.active === 'inner';
  const shape = editor.getShape();
  const hasWall = (inner ? shape.inner : shape.outer).length >= 3;
  // An unfinished outline is not a wall, but it is something: Clear has to be able to get rid
  // of it, and Flip works on the line as it stands.
  const something = hasWall || !!editor.draft;
  for (const id of ['centerBtn', 'flipXBtn', 'flipYBtn', 'clearBtn', 'shapeActionsDivider']) $(id).hidden = !something;
  // While the tool is open the canvas is showing a preview, so nothing else may change the shape.
  const rounding = !!editor.rounding;
  for (const id of ['centerBtn', 'flipXBtn', 'flipYBtn', 'clearBtn', 'alignBtn']) $(id).disabled = rounding;
  $('centerBtn').disabled = inner || rounding;
  syncRoundBar();
  // Centring moves the whole drawing; on its own the inner wall has Align instead.
  $('alignWrap').hidden = !inner || !hasWall;
  if ($('alignWrap').hidden) setAlignMenu(false);
  $('alignBtn').disabled = !(shape.outer.length >= 3 && shape.inner.length >= 3);
  setTip($('flipXBtn'), inner
    ? 'Flip left–right — mirror the inner wall horizontally inside the shape. The outer wall is not touched.'
    : 'Flip left–right — mirror the whole shape horizontally, inner wall and all, as if held up to a mirror. The size stays the same.');
  setTip($('flipYBtn'), inner
    ? 'Flip top–bottom — mirror the inner wall vertically inside the shape. The outer wall is not touched.'
    : 'Flip top–bottom — mirror the whole shape vertically, inner wall and all. The size stays the same.');
  const many = editor.layerCount > 1;
  setTip($('clearBtn'), inner
    ? 'Clear — remove the inner wall only. The outer wall stays. You can undo this.'
    : many
      ? `Clear — empty shape ${editor.index + 1}, inner wall included. The other shapes stay. You can undo this.`
      : 'Clear — remove the whole drawing, inner wall included, and start over. You can undo this.');
  setTip($('centerBtn'), many
    ? 'Center — move the whole drawing to the middle of the canvas. Every shape moves together, so they keep their places relative to each other.'
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

$('centerBtn').addEventListener('click', () => editor.center());
$('flipXBtn').addEventListener('click', () => editor.flip('x'));
$('flipYBtn').addEventListener('click', () => editor.flip('y'));
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
  else if (ARROWS[e.key] && editor.tool === 'move' && !editor.rounding) {
    e.preventDefault();
    const [dx, dy] = ARROWS[e.key], step = e.shiftKey ? 5 : 1;   // millimetres
    editor.nudgeShape(dx * step, dy * step);
  }
  else if (e.key === 'Enter' && editor.rounding) { e.preventDefault(); $('roundApplyBtn').click(); }
  else if (e.key === 'Escape' && editor.rounding) { e.preventDefault(); editor.cancelRound(); }
  else if (e.key === 'Escape') { editor.selectPoint(-1); closeMenu(); }
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
  drawProfile();
  editor.requestRender();     // the wall bands are keyed on the settings, so they redraw by themselves
  scheduleRegen();
}

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
const isSTL = (file) => /\.stl$/i.test(file.name) || file.type === 'model/stl';

let pendingSvg = null;
$('svgInput').addEventListener('change', async (e) => {
  const file = e.target.files?.[0]; e.target.value = '';
  if (!file) return;
  if (isSTL(file)) { openSTL(file); return; }
  try {
    const text = await file.text();
    const res = await importSVG(text);
    pendingSvg = { res, name: file.name };
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
    $('svgDialog').showModal();
    $('svgWidth').focus(); $('svgWidth').select();
  } catch (err) {
    toast(err.message || 'Could not read that SVG.');
  }
});
const svgSize = linkSizeFields('svgWidth', 'svgHeight', 'svgLockBtn');
$('svgCancelBtn').addEventListener('click', () => { pendingSvg = null; $('svgDialog').close(); });
$('svgDialog').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!pendingSvg) return;
  const { res, name } = pendingSvg; pendingSvg = null;
  $('svgDialog').close();
  const b = res.bounds;
  const w = parseFloat($('svgWidth').value), h = parseFloat($('svgHeight').value);
  const sx = w > 0 ? w / b.width : 1, sy = h > 0 ? h / b.height : sx;
  // Centre the whole drawing on the canvas, keeping the shapes where they sit inside it.
  const f = p => ({ x: (p.x - b.cx) * sx, y: (p.y - b.cy) * sy });
  const shapes = res.shapes.map(sh => ({ outer: sh.outer.map(f), inner: sh.inner ? sh.inner.map(f) : [] }));
  let msg = `Imported ${name} at ${(b.width * sx).toFixed(1)} × ${(b.height * sy).toFixed(1)} mm`;
  if (shapes.length > 1) msg += ` — ${shapes.length} shapes`;
  else if (shapes[0].inner.length) msg += ' — outer and inner wall';
  if (res.extraHoles) msg += ` (${res.extraHoles} extra hole${res.extraHoles === 1 ? '' : 's'} left out — one inner wall per shape)`;
  if (editor.active === 'inner' && shapes.length === 1 && !shapes[0].inner.length) {
    editor.setPoints(shapes[0].outer, { record: true });
  } else {
    editor.setLayers(shapes);
    setActive('outer');
  }
  setTool('move');
  toast(msg + '.');
  setTimeout(warnIfClashing, 1200);   // after the "imported" message has had its turn
});

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
  const sig = `${editor.layers.length}|${editor.index}`;
  const structural = sig !== listShape;
  listShape = sig;
  clearTimeout(listTimer);
  if (structural) drawShapeList();
  else listTimer = setTimeout(drawShapeList, 200);
}

function drawShapeList() {
  const list = editor.layerList();
  const many = list.length > 1;
  shapesList.textContent = '';
  for (const l of list) {
    const name = `Shape ${l.index + 1}`;
    const row = document.createElement('div');
    row.className = 'shape-row';
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(l.active));
    row.dataset.index = String(l.index);
    row.innerHTML = `<button type="button" class="shape-pick">${shapeThumb(l.outer, l.inner)}<span class="nm"></span></button>`
      + '<button type="button" class="btn ghost small icon shape-del"><i class="ph ph-trash"></i></button>';
    row.querySelector('.nm').textContent = l.drafting ? `${name} — unfinished` : l.empty ? `${name} — empty` : name;
    const pick = row.querySelector('.shape-pick');
    setTip(pick, l.active
      ? `${name} — the shape you are working on. Its size, walls and connections are what the settings panel shows.`
      : `${name} — switch to this shape. The one you are on now goes grey and cannot be moved until you come back.`);
    const del = row.querySelector('.shape-del');
    del.hidden = !many;
    setTip(del, `Delete ${name} — take this shape off the plate, settings and all. You can undo it.`);
    shapesList.append(row);
  }
  $('settingsScope').hidden = !many;
  $('settingsScopeName').textContent = `Shape ${editor.index + 1}`;
  // Another empty shape beside an empty one is nothing; finish this one first.
  const add = $('addShapeBtn');
  add.disabled = !editor.hasOuter;
  setTip(add, add.disabled
    ? 'Add shape — draw this shape first. Every shape on the plate is a cutter of its own.'
    : 'Add shape — another cutter on the same plate, with its own size, walls and settings.');
}

shapesList.addEventListener('click', (e) => {
  const row = e.target.closest('.shape-row');
  if (!row) return;
  const i = Number(row.dataset.index);
  if (e.target.closest('.shape-del')) deleteShape(i);
  else if (!row.matches('[aria-selected="true"]')) { editor.setLayer(i); toast(`Shape ${i + 1} — the others are greyed out until you come back.`); }
});

$('addShapeBtn').addEventListener('click', () => {
  editor.addLayer();
  setActive('outer');
  setShapesOpen(true);
  toast(`Shape ${editor.index + 1} added — draw it clear of the others. It keeps its own size, walls and settings.`);
});

// A file puts its shapes where it wants them, which may be closer together than a printer can
// keep apart. Nothing is moved — the arrangement is the file's — but it is worth saying.
function warnIfClashing() {
  const bad = editor.clashingLayers();
  if (!bad.length) return;
  const names = bad.map(i => i + 1).join(', ');
  toast(`Shapes ${names} are touching or overlapping. Move them apart, or they will print as one piece.`);
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
  const pos = editor.tool === 'move' ? editor.shapePos : null;
  if (!pos) { bar.hidden = true; return; }
  $('shapeBarLabel').textContent = editor.active === 'inner' ? 'Inner wall'
    : editor.layerCount > 1 ? `Shape ${editor.index + 1}` : 'Shape';
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
  const b = bounds(pieces.map(pc => pc.outer).flat());
  const scale = Math.min(w / Math.max(b.width, 0.001), h / Math.max(b.height, 0.001)) * 0.76;
  const depth = Math.max(4, Math.min(16, Math.min(w, h) * 0.04));   // apparent thickness of the slab
  const toPx = (p) => ({ x: w / 2 + (p.x - b.cx) * scale, y: h / 2 - depth / 2 + (p.y - b.cy) * scale });
  const path = (pts) => {
    const p0 = toPx(pts[0]); ctx.moveTo(p0.x, p0.y);
    for (let i = 1; i < pts.length; i++) { const q = toPx(pts[i]); ctx.lineTo(q.x, q.y); }
    ctx.closePath();
  };
  const piece = () => {
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
  piece(); ctx.stroke();
  ctx.filter = 'none';
  const sheen = ctx.createRadialGradient(w * 0.34, h * 0.28, 0, w * 0.34, h * 0.28, Math.max(w, h) * 0.62);
  sheen.addColorStop(0, 'rgba(255, 255, 255, 0.16)'); sheen.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = sheen; ctx.fillRect(0, 0, w, h);
  ctx.restore();

  piece(); ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(0, 0, 0, 0.28)'; ctx.stroke();
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
