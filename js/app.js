import { ShapeEditor } from './editor.js';
import { CutterViewer } from './viewer.js';
import { importSVG } from './svgimport.js';
import { PRESETS } from './presets.js';
import { buildCutter, toBinarySTL, offsetPolygon, cleanPolygon, bounds, bridgeShapes, loadManifold, manifoldReady, DEFAULT_PARAMS } from './geometry.js';

const $ = (id) => document.getElementById(id);

// Custom tooltips (see the explanation-tooltips section below); declared up here because
// controls whose explanation depends on the active wall are relabelled during start-up.
let tipTarget = null, tipTimer = 0;

// ---------- state ----------
const params = { ...DEFAULT_PARAMS };
let result = null;          // last successful buildCutter() result
let rings = null;           // 2D preview rings for the editor
let ringsKey = '';
let regenTimer = null;

// ---------- editor & viewer ----------
const editor = new ShapeEditor($('drawCanvas'), {
  onChange: onShapeChange,
  rings: (shape) => ringsFor(shape),
  onSelect: updatePointBar,
  onMenu: openPointMenu,
  onView: syncZoomUI,
});
const viewer = new CutterViewer($('viewer'));

function onShapeChange(shape) {
  syncSizeInputs(shape.outer);
  const hasOuter = shape.outer.length >= 3;
  const innerBtn = document.querySelector('.seg[data-active=inner]');
  innerBtn.disabled = !hasOuter;
  if (!hasOuter && editor.active === 'inner') setActive('outer');
  updateHint(shape);
  $('undoBtn').disabled = !editor.canUndo;
  $('redoBtn').disabled = !editor.canRedo;
  $('secInnerWrap').hidden = shape.inner.length < 3;
  syncWallActions();
  autoBridgeWidth(shape);
  scheduleRegen();
}

// Connection thickness defaults to 10% of the shape's width, rounded to 0.5 mm.
let bridgeAuto = true;
function autoBridgeWidth(shape) {
  if (!bridgeAuto || shape.outer.length < 3) return;
  const w = bounds(shape.outer).width;
  const v = Math.max(0.5, Math.round(w * 0.1 * 2) / 2);
  if (v !== params.bridgeWidth) {
    params.bridgeWidth = v;
    $('pBridgeWidth').value = v;
    ringsKey = ''; editor.requestRender();
  }
}
$('bridgeAutoBtn').addEventListener('click', () => {
  bridgeAuto = !bridgeAuto;
  $('bridgeAutoBtn').setAttribute('aria-pressed', String(bridgeAuto));
  if (bridgeAuto) { autoBridgeWidth(editor.getShape()); scheduleRegen(); }
});

// Offsets for the 2D preview (walls + connections), cached per shape version.
function ringsFor(shape) {
  const key = `${editor.version}|${shape === editor.shape ? 'r' : 's'}|${JSON.stringify(params)}`;
  if (key === ringsKey) return rings;
  ringsKey = key;
  try {
    const bw = params.bladeWidth, baseW = Math.max(bw, params.baseWidth);
    const rw = params.ridge ? Math.min(baseW, Math.max(bw, params.ridgeWidth)) : null;
    const o = shape.outer, i = shape.inner.length >= 3 ? shape.inner : null;
    rings = {
      base: offsetPolygon(o, baseW), ridge: rw ? offsetPolygon(o, rw) : null, blade: offsetPolygon(o, bw),
      innerBase: i ? offsetPolygon(i, -baseW) : null, innerRidge: i && rw ? offsetPolygon(i, -rw) : null,
      innerBlade: i ? offsetPolygon(i, -bw) : null,
      bridges: i ? bridgeShapes(o, i, params) : null,
    };
  } catch { rings = null; }
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
  if (editor.active === 'inner' && shape.inner.length < 3 && shape.outer.length >= 3) {
    text.innerHTML = '<strong>Draw the inner wall</strong> inside the shape — the area between the two walls is what gets cut out. Sketch it, place corners, or upload an SVG that already has a hole.';
    hint.classList.add('corner'); hint.hidden = false;
  } else if (shape.outer.length < 1) {
    hint.classList.remove('corner');
    text.innerHTML = '<strong>Draw the shape to cut.</strong> Drag to sketch — the outline closes and smooths itself. Or place corners one by one with <em>Points</em>, upload an SVG, or pick a starter shape.';
    hint.hidden = false;
  } else hint.hidden = true;
}

// ---------- 3D regeneration ----------
function scheduleRegen() {
  clearTimeout(regenTimer);
  regenTimer = setTimeout(regenerate, 120);
}

function regenerate() {
  const shape = editor.getShape();
  const err = $('errorBox');
  if (!manifoldReady()) return; // the engine calls regenerate() again once loaded
  if (shape.outer.length < 3) {
    result = null; viewer.clearMesh(); err.hidden = true;
    $('viewerHint').hidden = false; setDownloadEnabled(false);
    $('statFootprint').textContent = '—'; $('statHeight').textContent = '—'; $('statTris').textContent = '—';
    setReady('No shape yet');
    return;
  }
  try {
    const outer = cleanPolygon(shape.outer, 0.002);
    if (!outer) throw new Error('The outline crosses itself too much to make a cutter. Try Undo or Clear.');
    const inner = shape.inner.length >= 3 ? cleanPolygon(shape.inner, 0.002) : null;
    result = buildCutter({ outer, inner }, params);
    viewer.setMesh(result.positions, result.bounds);
    err.hidden = true; $('viewerHint').hidden = true;
    setDownloadEnabled(true);
    const f = result.footprint, cm3 = result.volumeMm3 / 1000;
    $('statFootprint').textContent = `${f.width.toFixed(1)} × ${f.height.toFixed(1)} mm`;
    $('statHeight').textContent = `${f.height3d.toFixed(1)} mm`;
    $('statTris').textContent = `${(cm3 * 1.24).toFixed(1)} g`;
    $('stats').title = `${cm3.toFixed(1)} cm³ · ${result.triangles.toLocaleString()} triangles`;
    setReady('Watertight · ready');
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
  toast(`Saved ${name}.stl — print it base down, no supports.`);
}
$('downloadBtn').addEventListener('click', download);
$('downloadBtnMobile').addEventListener('click', download);

// A fresh name on every page load, e.g. cutter-k7x2q
$('fileName').value = `cutter-${Math.random().toString(36).slice(2, 7)}`;

// ---------- tools ----------
const TOOL_TIPS = {
  draw: 'Drag to sketch the outline in one go.',
  points: 'Tap to add corners, tap a line to insert one. Select a corner to delete it or give it a curve; right-click (or hold) for the menu.',
  move: 'Drag the shape to move it. Use the handles to resize and the top knob to rotate. Two fingers pinch and twist.',
};
// The tool explanation reads itself out for a few seconds, then tucks away behind its (i).
const TOOL_TIP_HOLD = 5000;
let toolTipTimer = 0;
function setToolTipOpen(open) {
  $('toolTip').classList.toggle('collapsed', !open);
  $('toolTipIcon').setAttribute('aria-expanded', String(open));
}
function showToolTip(text) {
  $('toolTipText').textContent = text;
  setToolTipOpen(true);
  clearTimeout(toolTipTimer);
  toolTipTimer = setTimeout(() => setToolTipOpen(false), TOOL_TIP_HOLD);
}
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
  showToolTip(TOOL_TIPS[tool] + (editor.symOn ? ' Only the bright side is editable — the mirror side follows.' : ''));
  updatePointBar(null); closeMenu();
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
  updateHint(editor.getShape());
}

// Centre, align, flip and clear all act on the wall you are editing, so the controls change with
// it — and they stay out of the way entirely until there is something for them to act on.
function syncWallActions() {
  const inner = editor.active === 'inner';
  const shape = editor.getShape();
  const hasWall = (inner ? shape.inner : shape.outer).length >= 3;
  for (const id of ['centerBtn', 'flipXBtn', 'flipYBtn', 'clearBtn', 'shapeActionsDivider']) $(id).hidden = !hasWall;
  $('roundBtn').disabled = !hasWall;
  // Centring moves the whole drawing; on its own the inner wall has Align instead.
  $('centerBtn').disabled = inner;
  $('alignWrap').hidden = !inner || !hasWall;
  if ($('alignWrap').hidden) setAlignMenu(false);
  $('alignBtn').disabled = !(shape.outer.length >= 3 && shape.inner.length >= 3);
  setTip($('flipXBtn'), inner
    ? 'Flip left–right — mirror the inner wall horizontally inside the shape. The outer wall is not touched.'
    : 'Flip left–right — mirror the whole shape horizontally, inner wall and all, as if held up to a mirror. The size stays the same.');
  setTip($('flipYBtn'), inner
    ? 'Flip top–bottom — mirror the inner wall vertically inside the shape. The outer wall is not touched.'
    : 'Flip top–bottom — mirror the whole shape vertically, inner wall and all. The size stays the same.');
  setTip($('clearBtn'), inner
    ? 'Clear — remove the inner wall only. The outer wall stays. You can undo this.'
    : 'Clear — remove the whole drawing, inner wall included, and start over. You can undo this.');
}
setActive('outer');

$('smoothing').addEventListener('input', (e) => { editor.smoothing = parseFloat(e.target.value); });
$('centerBtn').addEventListener('click', () => editor.center());
$('flipXBtn').addEventListener('click', () => editor.flip('x'));
$('flipYBtn').addEventListener('click', () => editor.flip('y'));
$('clearBtn').addEventListener('click', () => editor.clear());
$('roundBtn').addEventListener('click', () => { if (editor.points.length >= 3) editor.roundCorners(); else toast('Nothing to round yet — draw or select a wall first.'); });
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

// symmetry
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
for (const [id, key] of Object.entries(PARAM_INPUTS)) {
  const el = $(id);
  el.value = params[key];
  el.addEventListener('input', () => {
    const v = parseFloat(el.value);
    if (!isFinite(v)) return;
    if (v <= 0 && !['bridgeCount', 'bridgeAngle'].includes(key)) return;
    params[key] = key === 'bridgeCount' ? Math.max(0, Math.round(v)) : v;
    if (key === 'bridgeWidth' && bridgeAuto) { bridgeAuto = false; $('bridgeAutoBtn').setAttribute('aria-pressed', 'false'); }
    onParamsChanged();
  });
}
$('pRidge').addEventListener('change', (e) => {
  params.ridge = e.target.checked; $('ridgeFields').hidden = !params.ridge; onParamsChanged();
});
$('pMirror').addEventListener('change', (e) => { params.mirror = e.target.checked; onParamsChanged(); });

function onParamsChanged() {
  drawProfile();
  ringsKey = ''; editor.requestRender();
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

// ---------- presets ----------
for (const [key, p] of Object.entries(PRESETS)) {
  const o = document.createElement('option'); o.value = key; o.textContent = p.label; $('presetSelect').appendChild(o);
}
$('presetSelect').addEventListener('change', (e) => {
  const p = PRESETS[e.target.value]; if (!p) return;
  const pts = cleanPolygon(p.make(), 0.02);
  if (editor.active === 'inner') {
    // scale the preset to fit inside the outer shape
    const ob = editor.getSize(), pb = bounds(pts);
    const s = Math.min(ob.width, ob.height) * 0.5 / Math.max(pb.width, pb.height) || 1;
    const c = bounds(editor.getPoints());
    editor.setPoints(pts.map(q => ({ x: c.cx + (q.x - pb.cx) * s, y: c.cy + (q.y - pb.cy) * s })), { record: true });
  } else {
    editor.setShape({ outer: pts, inner: [] }, { record: true, center: true });
  }
  setTool('move');
  e.target.value = '';
});

// ---------- SVG upload (with a size dialog) ----------
let pendingSvg = null;
$('svgInput').addEventListener('change', async (e) => {
  const file = e.target.files?.[0]; e.target.value = '';
  if (!file) return;
  try {
    const text = await file.text();
    const res = await importSVG(text);
    pendingSvg = { res, name: file.name };
    const b = bounds(res.points);
    let w = b.width, h = b.height;
    if (!res.physical || Math.max(w, h) > 400 || Math.max(w, h) < 5) { const s = 80 / Math.max(w, h); w *= s; h *= s; }
    pendingSvg.ratio = b.height / b.width;
    $('svgWidth').value = w.toFixed(1); $('svgHeight').value = h.toFixed(1);
    $('svgDialogNote').textContent = res.physical
      ? `${file.name} specifies a physical size (${b.width.toFixed(1)} × ${b.height.toFixed(1)} mm). Change it if needed.`
      : `${file.name} has no physical size, so 80 mm wide is suggested. Set the size you want.`
      + (res.inner ? ' Outer and inner wall found.' : '');
    $('svgDialog').showModal();
    $('svgWidth').focus(); $('svgWidth').select();
  } catch (err) {
    toast(err.message || 'Could not read that SVG.');
  }
});
let svgLock = true;
$('svgLockBtn').addEventListener('click', () => { svgLock = !svgLock; $('svgLockBtn').setAttribute('aria-pressed', String(svgLock)); });
$('svgWidth').addEventListener('input', () => { if (svgLock && pendingSvg) { const w = parseFloat($('svgWidth').value); if (w > 0) $('svgHeight').value = (w * pendingSvg.ratio).toFixed(1); } });
$('svgHeight').addEventListener('input', () => { if (svgLock && pendingSvg) { const h = parseFloat($('svgHeight').value); if (h > 0) $('svgWidth').value = (h / pendingSvg.ratio).toFixed(1); } });
$('svgCancelBtn').addEventListener('click', () => { pendingSvg = null; $('svgDialog').close(); });
$('svgDialog').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!pendingSvg) return;
  const { res, name } = pendingSvg; pendingSvg = null;
  $('svgDialog').close();
  const b = bounds(res.points);
  const w = parseFloat($('svgWidth').value), h = parseFloat($('svgHeight').value);
  const sx = w > 0 ? w / b.width : 1, sy = h > 0 ? h / b.height : sx;
  const f = p => ({ x: p.x * sx, y: p.y * sy });
  const outer = res.points.map(f), inner = res.inner ? res.inner.map(f) : null;
  let msg = `Imported ${name} at ${(b.width * sx).toFixed(1)} × ${(b.height * sy).toFixed(1)} mm`;
  if (inner) msg += ' — outer and inner wall';
  if (res.holes > 1) msg += ` (${res.holes} holes, using the largest)`;
  if (res.pieces > 1) msg += ` (${res.pieces} separate shapes, using the largest)`;
  if (editor.active === 'inner' && !inner) {
    editor.setPoints(outer, { record: true });
  } else {
    editor.setShape({ outer, inner: inner || [] }, { record: true, center: true });
    setActive('outer');
  }
  setTool('move');
  toast(msg + '.');
});

// ---------- point selection bar & context menu ----------
function updatePointBar(sel) {
  const bar = $('pointBar');
  if (!sel || editor.tool !== 'points') { bar.hidden = true; $('toolTip').style.visibility = ''; return; }
  $('toolTip').style.visibility = 'hidden';
  const p = sel.point, curved = !!(p.in || p.out);
  $('pointLabel').textContent = `Point ${sel.index + 1} of ${editor.points.length}`;
  $('ptCurveBtn').hidden = curved;
  $('ptResetBtn').hidden = !curved;
  $('ptRemoveCurveBtn').hidden = !curved;
  $('ptSyncBtn').hidden = !curved;
  $('ptSyncBtn').setAttribute('aria-pressed', String(p.smooth !== false));
  bar.hidden = false;
}
$('ptCurveBtn').addEventListener('click', () => editor.setCurve(editor.selected, 'add'));
$('ptResetBtn').addEventListener('click', () => editor.setCurve(editor.selected, 'reset'));
$('ptRemoveCurveBtn').addEventListener('click', () => editor.setCurve(editor.selected, 'remove'));
$('ptSyncBtn').addEventListener('click', () => editor.setSmooth(editor.selected, $('ptSyncBtn').getAttribute('aria-pressed') !== 'true'));
$('ptDeleteBtn').addEventListener('click', () => editor.deletePoint());

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
$('smoothing').addEventListener('input', (e) => { $('smoothingVal').textContent = parseFloat(e.target.value).toFixed(2); });

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
window.cutter = { editor, viewer, params };

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
