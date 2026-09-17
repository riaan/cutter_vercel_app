// 2D shape editor on a <canvas>. Works with mouse, pen and touch (pointer events).
// All coordinates are millimetres with y pointing down (screen convention).
//
// The drawing is a list of shape layers. Each layer is one cutter: an outer contour, an
// optional inner contour (a hole in the cut piece), its own mirror settings and its own wall
// parameters — changing the height of one shape leaves the others alone. Exactly one layer is
// active; the others stay on the canvas, greyed out and untouchable, and every layer is built
// into the 3D preview and the STL.
// Contour points may carry Bézier handles: { x, y, in?: {x,y}, out?: {x,y}, smooth? }
// where in/out are offsets from the anchor.

import { simplify, chaikin, cleanPolygon, bounds, signedArea, symmetrize, clipToRegion, roundCorners,
         offsetPolygon, intersectPolygons, DEFAULT_PARAMS } from './geometry.js';

const HANDLE_R = 9;    // drawn radius (css px)
const HANDLE_TIP = 5;  // half-diagonal of the diamond on the end of a Bézier handle (css px)
const HIT_R = 20;      // touch-friendly hit radius (css px)
const SNAP_PX = 10;    // magnet distance for guides, mirror lines and grid (css px)
const ROT_STEM = 34;   // distance of the rotation handle above the box
const LONG_PRESS = 550; // ms, opens the point menu on touch
// How far the pointer has to travel after placing a corner before the press becomes a pull on
// its curve rather than a click. Small, but past the shake of a hand letting go of a button.
const PEN_PULL = 3;    // css px
const DIM_ALPHA = 0.4;  // how far the wall you are not editing fades back
const MIN_ZOOM = 0.25; // 25 % — any further out and the grid stops being readable
const MAX_ZOOM = 8;    // 800 % — enough to place a point on a 0.1 mm feature
const ZOOM_STEP = 1.25; // one press of zoom in / out
// Two cutters on one plate have to come off the printer as two cutters, so their bases are
// kept a nozzle width apart. Everything that moves or reshapes a layer is measured against it.
const SHAPE_GAP = 0.4;  // mm of clear air between the base of one shape and the base of the next
// Rounding a contour means two different things depending on what the contour is. Up to this many
// anchors it is the set of corners somebody placed, so each one is curved where it stands and the
// shape keeps its points; beyond it the outline is traced (an import, a sketch) and has no corners
// to speak of, so it is smoothed as a polyline instead. The biggest starter shape has 20 anchors
// and an import runs to hundreds, so the line falls in open country.
const ROUND_ANCHORS = 48;
// How far a rounded corner may bulge, as a fraction of the distance to its neighbour, at full
// strength. A third is the classic handle length; half of the way to the next corner is as round
// as a corner can get before the curve starts to double back on itself.
const ROUND_BULGE = 0.5;
// The deepest corner cut for a traced outline, which is the classic Chaikin quarter. Below it
// the cut is shallower, which is what makes a slider over a traced outline move smoothly
// instead of jumping a whole pass at a time.
const CHAIKIN_CUT = 0.25;
const BLOCK_MSG = 'That runs into another shape — two cutters on one plate have to stay apart.';

const ROTATE_CURSOR = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'%3E%3Cpath d='M12 4a8 8 0 1 1-7.5 5' fill='none' stroke='white' stroke-width='4.5' stroke-linecap='round'/%3E%3Cpath d='M12 4a8 8 0 1 1-7.5 5' fill='none' stroke='%2314202B' stroke-width='2' stroke-linecap='round'/%3E%3Cpath d='M3 4.5v5h5' fill='none' stroke='white' stroke-width='4.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3Cpath d='M3 4.5v5h5' fill='none' stroke='%2314202B' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") 12 12, auto`;

// Nearest multiple of 45° for a handle vector, keeping its length (Shift while dragging).
const snapAngle45 = (h) => {
  const l = Math.hypot(h.x, h.y);
  if (!l) return h;
  const a = Math.round(Math.atan2(h.y, h.x) / (Math.PI / 4)) * (Math.PI / 4);
  return { x: Math.cos(a) * l, y: Math.sin(a) * l };
};

const copyPt = (p) => {
  const q = { x: p.x, y: p.y };
  if (p.in) q.in = { x: p.in.x, y: p.in.y };
  if (p.out) q.out = { x: p.out.x, y: p.out.y };
  if (p.smooth !== undefined) q.smooth = p.smooth;
  return q;
};
const copy = (pts) => pts.map(copyPt);
const copyShape = (s) => ({ outer: copy(s.outer), inner: copy(s.inner) });

// Apply a geometric transform to anchors and handles alike.
export function mapPts(pts, f) {
  return pts.map(p => {
    const q = f(p), r = { x: q.x, y: q.y };
    if (p.in) { const a = f({ x: p.x + p.in.x, y: p.y + p.in.y }); r.in = { x: a.x - q.x, y: a.y - q.y }; }
    if (p.out) { const a = f({ x: p.x + p.out.x, y: p.y + p.out.y }); r.out = { x: a.x - q.x, y: a.y - q.y }; }
    if (p.smooth !== undefined) r.smooth = p.smooth;
    return r;
  });
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// ---------- shape layers ----------
// A layer is one cutter: the seed contours, its own mirror settings (whose lines cross at
// `symOrigin`, so a shape away from the canvas centre can still be drawn symmetrically), and
// the wall parameters that build it. `rev` counts edits to this layer alone — the overlap
// guard uses it to know that the *other* layers have not moved.
let layerSeq = 0;
export function newLayer(params = null) {
  layerSeq++;
  return {
    id: `s${layerSeq}`,
    shape: { outer: [], inner: [] },
    sym: { x: false, y: false },
    symOrigin: { x: 0, y: 0 },
    params: { ...DEFAULT_PARAMS, ...(params || {}) },
    // Which contours are still being placed: a line of corners, not a shape yet. The Points
    // tool opens one and a click on its first point closes it. Never true in symmetry mode —
    // there the mirror lines close the half, so there is nothing for the user to close.
    open: { outer: false, inner: false },
    bridgeAuto: true,
    rev: 0,
  };
}

const copyLayer = (l) => ({
  id: l.id, shape: copyShape(l.shape), sym: { ...l.sym }, symOrigin: { ...l.symOrigin },
  params: { ...l.params }, open: { ...l.open }, bridgeAuto: l.bridgeAuto, rev: l.rev,
});

// Turn a control polygon (with optional Bézier handles) into a plain polyline.
export function flatten(pts, closed = true) {
  const n = pts.length;
  if (n < 2) return pts.map(p => ({ x: p.x, y: p.y }));
  const out = [];
  const m = closed ? n : n - 1;
  for (let i = 0; i < m; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    out.push({ x: a.x, y: a.y });
    if (a.out || b.in) {
      const c1 = { x: a.x + (a.out?.x || 0), y: a.y + (a.out?.y || 0) };
      const c2 = { x: b.x + (b.in?.x || 0), y: b.y + (b.in?.y || 0) };
      const len = dist(a, c1) + dist(c1, c2) + dist(c2, b);
      const steps = Math.max(8, Math.min(240, Math.ceil(len / 0.25)));
      for (let k = 1; k < steps; k++) {
        const t = k / steps, u = 1 - t;
        out.push({
          x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x,
          y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y,
        });
      }
    }
  }
  if (!closed) out.push({ x: pts[n - 1].x, y: pts[n - 1].y });
  return out;
}

// Round every corner of a control polygon by giving it Bézier handles, instead of chopping it
// into more polyline points: the shape keeps the corners you placed and stays editable, and
// `strength` — the fraction of the way to each neighbour that the handle reaches — says how far
// the curve bulges. 0 takes the handles off again, which is what "no rounding" has to mean.
// The two ends of an open line (a mirrored half, an outline still being drawn) stay sharp:
// they have only one neighbour, and on a mirror line they have to meet it square.
export function curveCorners(pts, strength, closed = true) {
  const n = pts.length;
  return pts.map((p, i) => {
    const q = { x: p.x, y: p.y };
    const prev = pts[(i - 1 + n) % n], next = pts[(i + 1) % n];
    if (!strength || (!closed && (i === 0 || i === n - 1))) return q;
    let tx = next.x - prev.x, ty = next.y - prev.y;
    const tl = Math.hypot(tx, ty);
    if (!tl) return q;
    tx /= tl; ty /= tl;
    const d1 = dist(p, prev) * strength, d2 = dist(p, next) * strength;
    q.in = { x: -tx * d1, y: -ty * d1 };
    q.out = { x: tx * d2, y: ty * d2 };
    q.smooth = true;
    return q;
  });
}

// Which of the two roundings a contour wants. Anything up to ROUND_ANCHORS is a set of corners
// somebody placed; beyond that it is traced.
function roundKindOf(pts) {
  return pts.length >= 3 && pts.length <= ROUND_ANCHORS ? 'anchors' : 'outline';
}

// How round a control polygon already is, on the same 0..1 dial the tool uses: the average
// handle as a fraction of the way to the neighbour it reaches towards. A traced outline has no
// handles to read, so it opens at nothing — there is no un-rounding a polyline anyway.
function roundAmountOf(pts) {
  if (roundKindOf(pts) !== 'anchors') return 0;
  const n = pts.length;
  let sum = 0, k = 0;
  for (let i = 0; i < n; i++) {
    const p = pts[i], next = pts[(i + 1) % n], d = dist(p, next);
    if (!d) continue;
    if (p.out) { sum += Math.hypot(p.out.x, p.out.y) / d; k++; }
    if (next.in) { sum += Math.hypot(next.in.x, next.in.y) / d; k++; }
  }
  if (!k) return 0;
  return Math.min(1, Math.round((sum / k) / ROUND_BULGE * 20) / 20);
}

// Is a point inside a closed contour? Used both for the shape being moved and for picking
// another one up off the canvas.
function inPoly(pts, m) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const pi = pts[i], pj = pts[j];
    if ((pi.y > m.y) !== (pj.y > m.y) && m.x < (pj.x - pi.x) * (m.y - pi.y) / (pj.y - pi.y) + pi.x) inside = !inside;
  }
  return inside;
}

export class ShapeEditor {
  constructor(canvas, { onChange = () => {}, onGuides = () => {}, onSelect = () => {}, onMenu = () => {}, onView = () => {},
               onBlock = () => {}, rings = () => null, colors = {} } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onChange = onChange;
    this.onGuides = onGuides;
    this.onSelect = onSelect;
    this.onMenu = onMenu;
    this.onView = onView;
    this.onBlock = onBlock;   // "that would run into another shape" — the canvas cannot say it itself
    this.ringsProvider = rings;
    this.colors = Object.assign({
      grid: '#232532', gridMajor: '#2E3140', ink: '#E9E9ED', muted: '#9397AB',
      dough: 'rgba(145,132,217,0.10)', doughLine: '#9184D9', base: 'rgba(233,233,237,0.06)', blade: '#9184D9',
      accent: '#9184D9', accentSoft: 'rgba(145,132,217,0.18)', paper: '#161826',
      inactive: 'rgba(22,24,38,0.55)', guide: '#B5ABFC', handle: '#B5ABFC',
      dimLine: 'rgba(145,132,217,0.38)',   // the wall you are not editing
      // the shapes you are not editing: grey, and faint enough to read as background
      otherLine: 'rgba(147,151,171,0.6)', otherFill: 'rgba(147,151,171,0.07)',
      otherBase: 'rgba(147,151,171,0.09)', otherBlade: 'rgba(147,151,171,0.3)',
      // the one under the pointer: a step from that grey towards the shape you are editing, so
      // you can see what a click would pick up without it already looking picked up
      hotLine: 'rgba(145,132,217,0.7)', hotFill: 'rgba(145,132,217,0.08)',
      hotBase: 'rgba(147,151,171,0.14)', hotBlade: 'rgba(145,132,217,0.4)',

    }, colors);

    // One layer per shape, `index` picks the one being edited. this.shape / this.sym / this.params
    // are accessors onto that layer, so everything below reads as if there were only ever one.
    this.layers = [newLayer()];
    this.index = 0;
    // Whether the Move tool is holding the shape being edited: the box, its handles and the
    // position bar are on it and the arrow keys nudge it. A click on empty canvas puts it down;
    // a click on a shape picks that one up. Anything that changes which shape is being edited
    // hands the new one over held, so the tool is never left grasping at nothing.
    this.picked = true;
    this.hot = -1;   // the shape under the pointer, lit up as what a click would pick up
    this.active = 'outer';
    this.tool = 'draw';
    this.smoothing = 0.4;
    this.lockAspect = true;
    // Off, two cutters on one plate have to stay apart — the guard below stops a drag against
    // its neighbour. On, they may run into each other; where they do, the builder makes one
    // merged object out of them, because that is what comes off the printer.
    this.allowOverlap = false;
    this.grid = { size: 10, snap: false };
    this.guides = [];
    // size = mm across the shorter canvas edge at 100 %; zoom multiplies it; pan is the mm
    // point sitting at the centre of the canvas.
    // `manual` flips once the user drives the view themselves; auto-fit then stays out of
    // the way until Reset. It cannot be inferred from pan/zoom, because centring on a shape
    // that does not sit on the origin leaves a non-zero pan at 100 %.
    this.view = { size: 160, zoom: 1, pan: { x: 0, y: 0 }, manual: false };
    this.panMode = false;
    this.stroke = null;
    this.drag = null;
    this.pointers = new Map();
    this.gesture = null;
    this.viewGesture = null;
    this.undoStack = [];
    this.redoStack = [];
    this.dirty = true;
    this.lastTap = { t: 0, key: null };
    this.version = 0;
    this._keepOutCache = { key: null, polys: [] };
    this.selected = -1;
    this._pressTimer = null;
    this.round = null;   // the rounding tool while it is open: the wall, the shape it started from

    this._bind();
    this._resize();
    this.ro = new ResizeObserver(() => { this._resize(); this.requestRender(); });
    this.ro.observe(canvas);
    this._loop();
  }

  // ---------- public API ----------

  // ----- shape layers -----
  // The layer being edited stands in for "the shape" everywhere below.
  get layer() { return this.layers[this.index]; }
  get shape() { return this.layer.shape; }
  set shape(v) { this.layer.shape = v; }
  get sym() { return this.layer.sym; }
  set sym(v) { this.layer.sym = v; }
  // Where this shape's mirror lines cross. It travels with the shape, so a symmetric cutter
  // can be moved anywhere on the plate and still be drawn by its half.
  get symOrigin() { return this.layer.symOrigin; }
  set symOrigin(v) { this.layer.symOrigin = v; }
  get params() { return this.layer.params; }
  // Which of this shape's contours are unfinished outlines rather than shapes.
  get open() { return this.layer.open; }
  get layerCount() { return this.layers.length; }

  // What the canvas has to say about an outline still being placed — null while there is none.
  // `closable` is the moment the first point turns into the button that finishes the shape.
  get draft() {
    const k = this.active;
    // An outline with no corners in it yet is not one being placed — it is an empty canvas.
    if (!this.open[k] || !this.shape[k].length) return null;
    return { wall: k, count: this.shape[k].length, closable: this.shape[k].length >= 3 };
  }

  // Finish the outline being placed: from here on it is a shape — filled, measured, built into
  // the 3D preview, and added to only on its own lines. This is what clicking the first point does.
  closeContour(k = this.active) {
    if (!this.open[k] || this.shape[k].length < 3) return false;
    this._record();
    this.open[k] = false;
    this.layer._disp = null;
    // Every point was measured against the other shapes as it went down, so this can only fail
    // if they moved underneath; it is checked all the same rather than closing into a neighbour.
    if (k === 'outer' && !this._allowed()) {
      this.open[k] = true; this.layer._disp = null;
      this.undoStack.pop();
      this._blockNote('That outline runs into another shape — move it clear before closing it.');
      return false;
    }
    this._select(-1);
    this._autoFit();
    this._changed();
    return true;
  }

  // What the shapes list is drawn from: one entry per layer, with the outline it shows.
  layerList() {
    return this.layers.map((l, i) => {
      const d = this._displayOf(l);
      // An unfinished outline is not a shape, but it is not nothing either — deleting it still
      // throws away work, so the list says "unfinished" rather than "empty".
      const drafting = ['outer', 'inner'].some(k => l.open[k] && l.shape[k].length);
      return {
        id: l.id, index: i, active: i === this.index,
        outer: d.outer, inner: d.inner, drafting,
        empty: d.outer.length < 3 && !drafting,
      };
    });
  }

  setLayer(i) {
    if (i < 0 || i >= this.layers.length || i === this.index) return;
    this._dropRound();
    this.stroke = null; this.drag = null; this.gesture = null; this.viewGesture = null;
    this.index = i;
    this.picked = true;
    // The inner wall of the shape you have just come to may not exist; fall back rather than
    // leaving the tabs pointing at nothing.
    if (this.active === 'inner' && this.shape.inner.length < 3) this.active = 'outer';
    this._select(-1);
    this.dirty = true;
    this._changed({ selectionOnly: true });
  }

  // Pick a shape up off the canvas: it becomes the shape being edited and the Move tool takes
  // hold of it. Clicking a shape is the other way into the shapes list's job — with your eyes
  // on the drawing, where the shape you mean is the one you can see.
  pickShape(i) {
    if (i < 0 || i >= this.layers.length) return false;
    if (i === this.index && this.picked) return false;
    this.picked = true;
    this._setHot(-1);
    if (i !== this.index) this.setLayer(i);   // reports the change itself
    else this._changed({ selectionOnly: true });
    return true;
  }

  // Put the shape down: nothing is held, so the box, its handles and the position bar go. The
  // shape itself stays the one being edited — it is the one the settings panel is showing, and
  // the other tools still draw on it — it is only the Move tool that has let go.
  dropShape() {
    if (this.tool !== 'move' || !this.picked) return false;   // only this tool ever holds a shape
    this.picked = false;
    this._setHot(-1);
    this._changed({ selectionOnly: true });
    return true;
  }

  // A new shape starts empty but with the wall settings of the one you were on: the height and
  // the blade are usually meant for the whole plate, and every one of them is still its own.
  addLayer() {
    this._dropRound();
    this._record();
    const l = newLayer(this.params);
    this.layers.push(l);
    this.index = this.layers.length - 1;
    this.picked = true;
    this.active = 'outer';
    this._select(-1);
    this._changed();
    return this.index;
  }

  removeLayer(i = this.index) {
    if (this.layers.length <= 1 || i < 0 || i >= this.layers.length) return;
    this._dropRound();
    this._record();
    this.layers.splice(i, 1);
    if (this.index > i) this.index--;
    if (this.index >= this.layers.length) this.index = this.layers.length - 1;
    this.picked = true;
    this.active = 'outer';
    this._select(-1);
    this._autoFit();
    this._changed();
  }

  // Every layer as the 3D build wants it: the effective contours plus that layer's settings.
  buildParts() {
    return this.layers.map((l, i) => ({
      label: `Shape ${i + 1}`,
      shape: copyShape(this._displayOf(l)),
      params: { ...l.params },
    })).filter(p => p.shape.outer.length >= 3);
  }

  // Reaching for the Move tool means moving the shape you are on, so it comes back held
  // however the canvas was left.
  setTool(tool) { this.tool = tool; this.stroke = null; this.drag = null; this.picked = true; this._setHot(-1); this._select(-1); this._setCursor(this._defaultCursor()); this.requestRender(); }
  setActive(which) { this._dropRound(); this.active = which; this.stroke = null; this.drag = null; this._select(-1); this.requestRender(); }

  // ----- view (zoom / pan) -----
  // Zoom is a multiplier on the auto-fitted size, so 100 % always means "the whole shape fits".
  getZoom() { return this.view.zoom; }
  get zoomLimits() { return { min: MIN_ZOOM, max: MAX_ZOOM }; }

  // The middle of the drawing, which is what zoom centres on. Falls back to the origin
  // while there is nothing drawn yet.
  _shapeCenter() {
    const b = this.allBounds();
    return b ? { x: b.cx, y: b.cy } : { x: 0, y: 0 };
  }

  // anchorPx keeps the mm point under the cursor in place while the scale changes; without
  // one the view re-centres on the shape, so zooming in never leaves it off screen.
  setZoom(z, anchorPx = null) {
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
    if (next === this.view.zoom) { this._centerOnShape(); return; }
    const before = anchorPx ? this.toMm(anchorPx) : null;
    this.view.zoom = next;
    if (before) {
      const after = this.toMm(anchorPx);
      this.view.pan.x += before.x - after.x;
      this.view.pan.y += before.y - after.y;
      this.view.manual = true;
      this.dirty = true;
      this.onView(this.view);
    } else {
      this._centerOnShape();
    }
  }
  _centerOnShape() {
    this.view.pan = this._shapeCenter();
    this.view.manual = true;
    this.dirty = true;
    this.onView(this.view);
  }
  zoomBy(factor, anchorPx = null) { this.setZoom(this.view.zoom * factor, anchorPx); }
  zoomIn(anchorPx = null) { this.zoomBy(ZOOM_STEP, anchorPx); }
  zoomOut(anchorPx = null) { this.zoomBy(1 / ZOOM_STEP, anchorPx); }

  // Back to 100 % and centred — the state the canvas starts in.
  resetView() {
    this.view.zoom = 1; this.view.pan = { x: 0, y: 0 }; this.view.manual = false;
    this._autoFit();
    this.dirty = true; this.onView(this.view);
  }

  setPanMode(on) {
    this.panMode = !!on;
    this.stroke = null; this.drag = null; this.gesture = null; this.viewGesture = null;
    this._setCursor(this._defaultCursor());
    this.requestRender();
  }
  _defaultCursor() { return this.panMode ? 'grab' : this.tool === 'draw' ? 'crosshair' : 'default'; }

  get points() { return this.shape[this.active]; }
  set points(v) { this.shape[this.active] = v; }

  // The effective shape: curves flattened; in symmetry mode the edited half, closed along the mirror lines and mirrored.
  getShape() { return copyShape(this._display()); }
  getPoints() { return copy(this._display().outer); }
  // A wall exists once its outline is closed — an unfinished line of corners is not one yet.
  get hasInner() { return !this.open.inner && this.shape.inner.length >= 3; }
  get hasOuter() { return !this.open.outer && this.shape.outer.length >= 3; }
  // Is this wall an open line rather than a closed ring? A mirrored half is closed by its
  // mirror lines and an outline still being placed has not been closed yet; both are rounded
  // end to end instead of round the corner where the last point meets the first.
  _openWall(k = this.active) { return this.symOn || !!this.open[k]; }

  // Is there anything on the canvas at all, on any layer? What "this replaces your drawing"
  // has to mean once there is more than one shape.
  get hasAnyShape() { return this.layers.some(l => this._displayOf(l).outer.length >= 3); }

  // Put a whole shape into the active layer. A shape that lands on top of another one is moved
  // clear of it rather than refused: the size was settled in a dialog, and nudging it aside is
  // a smaller surprise than throwing it away.
  // `open` says which of the two contours arrive unfinished; a whole shape handed in — a
  // sketch, a starter shape, a file — is finished by definition, so both default to closed.
  setShape(shape, { record = true, center = false, fit = true, place = true,
                    open = { outer: false, inner: false } } = {}) {
    this._dropRound();
    if (record) this._record();
    this.shape = { outer: copy(shape.outer || []), inner: copy(shape.inner || []) };
    this.layer.open = { outer: !!open.outer && !this.symOn, inner: !!open.inner && !this.symOn };
    if (this.symOn) this._toSeeds();
    if (center && this.shape.outer.length) this._centerShape();
    if (place && this.active === 'outer' && this._blocked(this._display().outer)) {
      const spot = this._freeSpot(this._display().outer);
      if (spot) {
        this._shift(spot.dx, spot.dy);
        this._blockNote('Put beside the other shapes — two cutters on one plate must not touch.');
      }
    }
    this._select(-1);
    if (fit) this._autoFit();
    this._changed();
  }

  // Replace the whole plate — an SVG with several shapes on it, or an STL holding several
  // cutters. Recorded, so it can be undone like any other edit; the wall settings of the shape
  // you were on are the starting point for every new one unless the caller brings its own.
  setLayers(shapes, { record = true, params = null } = {}) {
    this._dropRound();
    if (record) this._record();
    const base = params || { ...this.params };
    this.layers = (shapes.length ? shapes : [{ outer: [], inner: [] }]).map((sh, i) => {
      const l = newLayer(Array.isArray(params) ? params[i] : base);
      l.shape = { outer: copy(sh.outer || []), inner: copy(sh.inner || []) };
      if (sh.sym) l.sym = { x: !!sh.sym.x, y: !!sh.sym.y };
      if (sh.symOrigin) l.symOrigin = { x: sh.symOrigin.x, y: sh.symOrigin.y };
      if (sh.params) l.params = { ...DEFAULT_PARAMS, ...sh.params };
      if (sh.bridgeAuto !== undefined) l.bridgeAuto = !!sh.bridgeAuto;
      return l;
    });
    this.index = 0;
    this.picked = true;
    this.active = 'outer';
    this._select(-1);
    this._keepOutCache = { key: null, polys: [] };
    this._autoFit();
    this._changed();
  }

  // Put more shapes on the plate without touching the ones already on it — a file dropped onto
  // a drawing that is already there. The entries are the ones setState() takes (a file's layers,
  // seeds and all); a plain { outer, inner } is taken as a shape with no settings of its own,
  // and then the wall settings of the shape you are on are what it starts with.
  // The arrivals keep their own arrangement and are moved clear of the plate as one group: a
  // sheet of four charms is added as that sheet, not as four shapes shuffled into the gaps.
  addLayers(list, { record = true, params = null } = {}) {
    const items = (list || []).filter(it => ((it.shape || it).outer || []).length);
    if (!items.length) return 0;
    this._dropRound();
    if (record) this._record();
    const base = params || { ...this.params };
    const first = this.layers.length;
    for (const it of items) this.layers.push(this._layerFrom(it, base));
    this._placeGroup(first);
    this.index = first;
    this.picked = true;
    this.active = 'outer';
    this._select(-1);
    this._keepOutCache = { key: null, polys: [] };
    this._autoFit();
    this._changed();
    return items.length;
  }

  // One layer out of whatever a file hands over. Nested ({ shape, sym, params, … }) is the form
  // a project and an STL come in; flat ({ outer, inner }) is what an SVG gives.
  _layerFrom(it, base) {
    const src = it.shape || it;
    const l = newLayer(it.params || base);
    l.shape = { outer: copy(src.outer || []), inner: copy(src.inner || []) };
    if (it.sym) l.sym = { x: !!it.sym.x, y: !!it.sym.y };
    const o = it.symOrigin;
    if (o) l.symOrigin = { x: isFinite(o.x) ? o.x : 0, y: isFinite(o.y) ? o.y : 0 };
    // A symmetric half is closed by its mirror lines, so it can never be an open outline.
    const symOn = l.sym.x || l.sym.y;
    l.open = { outer: !!it.open?.outer && !symOn, inner: !!it.open?.inner && !symOn };
    if (it.bridgeAuto !== undefined) l.bridgeAuto = !!it.bridgeAuto;
    return l;
  }

  // The box round a run of layers, with the widest base among them: what has to be kept clear.
  _groupBox(from, to) {
    let box = null, pad = 0;
    for (let i = from; i < to; i++) {
      const o = this._displayOf(this.layers[i]).outer;
      if (o.length < 3) continue;
      const b = bounds(o);
      box = box ? { minX: Math.min(box.minX, b.minX), maxX: Math.max(box.maxX, b.maxX),
                    minY: Math.min(box.minY, b.minY), maxY: Math.max(box.maxY, b.maxY) } : b;
      pad = Math.max(pad, this._baseWidthOf(this.layers[i]));
    }
    return box ? { ...box, pad } : null;
  }

  // Move the shapes added from `first` on clear of the ones already there, keeping the
  // arrangement they arrived in. Only when they would land on top of something: a file whose
  // shapes sit somewhere else entirely keeps the place it chose.
  _placeGroup(first) {
    if (first === 0) return;
    const old = this._groupBox(0, first), added = this._groupBox(first, this.layers.length);
    if (!old || !added) return;
    const gap = old.pad + added.pad + SHAPE_GAP;
    if (added.minX - gap > old.maxX || added.maxX + gap < old.minX
        || added.minY - gap > old.maxY || added.maxY + gap < old.minY) return;
    const dx = old.maxX + gap - added.minX;
    const dy = (old.minY + old.maxY) / 2 - (added.minY + added.maxY) / 2;
    for (let i = first; i < this.layers.length; i++) this._shiftLayer(this.layers[i], dx, dy);
  }

  _shiftLayer(l, dx, dy) {
    if (!dx && !dy) return;
    const f = p => ({ x: p.x + dx, y: p.y + dy });
    l.shape = { outer: mapPts(l.shape.outer, f), inner: mapPts(l.shape.inner, f) };
    l.symOrigin = f(l.symOrigin);
    l.rev++; l._disp = null;
  }

  // Replace the active contour only.
  setPoints(pts, opts = {}) {
    const s = copyShape(this.shape);
    s[this.active] = pts || [];
    // The wall being replaced arrives finished; the other one keeps whatever it was.
    const open = { ...this.open, [this.active]: false };
    if (this.active === 'outer' && opts.dropInner) { s.inner = []; open.inner = false; }
    this.setShape(s, { ...opts, open });
  }

  // ----- saving and opening a project -----
  // The seeds are handed out as they are stored: in symmetry mode that is the edited half,
  // which is exactly what setState() expects back.
  getState() {
    return {
      layers: this.layers.map(l => ({
        shape: copyShape(l.shape),
        sym: { ...l.sym },
        symOrigin: { ...l.symOrigin },
        params: { ...l.params },
        open: { ...l.open },
        bridgeAuto: !!l.bridgeAuto,
      })),
      index: this.index,
      active: this.active,
      tool: this.tool,
      smoothing: this.smoothing,
      lockAspect: this.lockAspect,
      allowOverlap: this.allowOverlap,
      grid: { ...this.grid },
    };
  }

  // Restores a saved project. The seeds go in untouched — _toSeeds() must not run, or a
  // symmetric half would be clipped a second time.
  setState(st) {
    this.round = null;   // the whole drawing is being replaced; there is nothing to put back
    const list = Array.isArray(st.layers) && st.layers.length ? st.layers : [st];
    this.layers = list.map(l => {
      const layer = newLayer(l.params);
      layer.shape = { outer: copy(l.shape?.outer || []), inner: copy(l.shape?.inner || []) };
      layer.sym = { x: !!l.sym?.x, y: !!l.sym?.y };
      const o = l.symOrigin;
      layer.symOrigin = { x: isFinite(o?.x) ? o.x : 0, y: isFinite(o?.y) ? o.y : 0 };
      // A symmetric half is closed by its mirror lines, so it can never be an open outline —
      // a file that says otherwise is read the only way that makes sense.
      const symOn = layer.sym.x || layer.sym.y;
      layer.open = { outer: !!l.open?.outer && !symOn, inner: !!l.open?.inner && !symOn };
      layer.bridgeAuto = !!l.bridgeAuto;
      return layer;
    });
    this.index = Math.min(Math.max(0, Math.round(st.index) || 0), this.layers.length - 1);
    this.picked = true;
    this.active = st.active === 'inner' && this.shape.inner.length >= 3 ? 'inner' : 'outer';
    this.tool = ['draw', 'points', 'move'].includes(st.tool) ? st.tool : 'move';
    if (typeof st.smoothing === 'number') this.smoothing = st.smoothing;
    if (typeof st.lockAspect === 'boolean') this.lockAspect = st.lockAspect;
    // A plate whose shapes overlap can only be opened with the guard down; app.js works out
    // what a file that does not say means before it gets here.
    if (typeof st.allowOverlap === 'boolean') this.allowOverlap = st.allowOverlap;
    if (st.grid) this.grid = { size: Math.max(0.5, st.grid.size || 10), snap: !!st.grid.snap };
    this.undoStack.length = 0; this.redoStack.length = 0;
    this.stroke = null; this.drag = null; this.gesture = null; this.viewGesture = null;
    this._keepOutCache = { key: null, polys: [] };
    this._select(-1);
    this.view.manual = false;
    this._autoFit();
    this._changed();
    this.onView(this.view);
  }

  // A clean picture of the drawing for the project file: shape and walls only, no grid,
  // guides, handles or dimensions, fitted to the given size.
  renderPreview(w = 1000, h = 1000, { background = this.colors.paper, pad = 0.07 } = {}) {
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = background; ctx.fillRect(0, 0, w, h);

    const drawn = this.layers.map(l => ({ disp: this._displayOf(l), rings: this._ringsFor(l) }))
      .filter(d => d.disp.outer.length >= 3);
    if (!drawn.length) return cv;
    const extent = drawn.map(d => (d.rings && d.rings.base && d.rings.base.length >= 3 ? d.rings.base : d.disp.outer));
    const b = bounds(extent.flat());
    const s = Math.min(w / Math.max(b.width, 0.001), h / Math.max(b.height, 0.001)) * (1 - 2 * pad);
    const toPx = (p) => ({ x: w / 2 + (p.x - b.cx) * s, y: h / 2 + (p.y - b.cy) * s });
    const path = (pts) => {
      if (!pts || pts.length < 2) return;
      const p0 = toPx(pts[0]); ctx.moveTo(p0.x, p0.y);
      for (let i = 1; i < pts.length; i++) { const q = toPx(pts[i]); ctx.lineTo(q.x, q.y); }
      ctx.closePath();
    };
    const band = (outerRing, innerRing, fill) => {
      if (!outerRing || !innerRing) return;
      ctx.beginPath(); path(outerRing); path(innerRing);
      ctx.fillStyle = fill; ctx.fill('evenodd');
    };
    const C = this.colors;
    for (const { disp, rings } of drawn) {
      const hasInner = disp.inner.length >= 3;
      ctx.beginPath(); path(disp.outer); if (hasInner) path(disp.inner);
      ctx.fillStyle = C.dough; ctx.fill('evenodd');
      if (rings) {
        band(rings.base, disp.outer, C.base);
        band(rings.ridge, disp.outer, C.base);
        band(rings.blade, disp.outer, C.blade);
        if (hasInner) {
          band(disp.inner, rings.innerBase, C.base);
          band(disp.inner, rings.innerRidge, C.base);
          band(disp.inner, rings.innerBlade, C.blade);
        }
        if (rings.bridges && rings.bridges.length) {
          ctx.beginPath(); for (const g of rings.bridges) path(g);
          ctx.fillStyle = 'rgba(145,132,217,0.16)'; ctx.fill();
        }
      }
      ctx.lineWidth = Math.max(1.5, s * 0.15); ctx.strokeStyle = C.doughLine; ctx.lineJoin = 'round';
      ctx.beginPath(); path(disp.outer); ctx.stroke();
      if (hasInner) { ctx.beginPath(); path(disp.inner); ctx.stroke(); }
    }
    return cv;
  }

  clear() {
    if (this.active === 'outer') { if (!this.shape.outer.length && !this.shape.inner.length) return; this.setShape({ outer: [], inner: [] }); }
    else { if (!this.shape.inner.length) return; this.setPoints([]); }
  }

  undo() {
    this._dropRound();
    if (!this.undoStack.length) return;
    this.redoStack.push(this._snapshot());
    this._restore(this.undoStack.pop());
    this._select(-1); this._autoFit(); this._changed();
  }

  redo() {
    this._dropRound();
    if (!this.redoStack.length) return;
    this.undoStack.push(this._snapshot());
    this._restore(this.redoStack.pop());
    this._select(-1); this._autoFit(); this._changed();
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }

  getSize() {
    const o = this._display().outer;
    if (o.length < 3) return { width: 0, height: 0 };
    const b = bounds(o);
    return { width: b.width, height: b.height };
  }

  // Scale the whole shape about its centre to the given size (mm). Either value may be null.
  setSize(width, height, { record = true } = {}) {
    if (this._display().outer.length < 3) return;
    const b = bounds(this._display().outer);
    let sx = width ? width / b.width : null;
    let sy = height ? height / b.height : null;
    if (this.lockAspect) { const s = sx ?? sy; sx = s; sy = s; }
    sx = sx ?? 1; sy = sy ?? 1;
    if (!isFinite(sx) || !isFinite(sy) || sx <= 0 || sy <= 0) return;
    if (record) this._record();
    const f = p => ({ x: b.cx + (p.x - b.cx) * sx, y: b.cy + (p.y - b.cy) * sy });
    const run = () => {
      this.shape = { outer: mapPts(this.shape.outer, f), inner: mapPts(this.shape.inner, f) };
      this.symOrigin = f(this.symOrigin);
    };
    if (!this._guard(run, 'That size would run into another shape. Move the shapes apart first.')) {
      if (record) this.undoStack.pop();
      return;
    }
    this._autoFit(); this._changed();
  }

  // Where the shape sits: the middle of the wall being edited, which is the box the Move tool
  // draws its handles on. null while that wall has no contour.
  get shapePos() {
    const pts = this._display()[this.active];
    if (pts.length < 3) return null;
    const b = bounds(pts);
    return { x: b.cx, y: b.cy };
  }

  // Shift the shape by a distance (arrow keys, position boxes). It goes through the same
  // transform a drag does, so the inner wall comes along in outer mode, the mirror origin
  // travels with it, and a step into another shape is simply not taken.
  nudgeShape(dx, dy, { record = true } = {}) {
    if (!dx && !dy) return;
    if (this._display()[this.active].length < 3) return;
    if (record) this._record();
    if (!this._applyTransform(this._startState(), p => ({ x: p.x + dx, y: p.y + dy }))) {
      if (record) this.undoStack.pop();
      return;
    }
    this._autoFit();
    this._changed();
  }

  // Put the middle of the shape on an absolute point (the position boxes).
  moveShapeTo(x, y) {
    const c = this.shapePos;
    if (!c || !isFinite(x) || !isFinite(y)) return;
    this.nudgeShape(x - c.x, y - c.y);
  }

  // Centre the drawing on the canvas. With more than one shape the whole arrangement moves as
  // one, so the shapes keep their places relative to each other — and cannot run into anything.
  center() {
    const b = this.allBounds();
    if (!b) return;
    this._record();
    const f = p => ({ x: p.x - b.cx, y: p.y - b.cy });
    for (const l of this.layers) {
      l.shape = { outer: mapPts(l.shape.outer, f), inner: mapPts(l.shape.inner, f) };
      l.symOrigin = f(l.symOrigin);
      l.rev++;
    }
    this._changed();
  }

  // Flipping follows the wall you are editing: the outer wall carries the inner one with it,
  // the inner wall flips on its own inside the shape.
  flip(axis) {
    const keys = this._affected();
    const ref = this._activeOutline();
    if (ref.length < 3) return;
    if ((axis === 'x' && this.sym.x) || (axis === 'y' && this.sym.y)) return; // already symmetric that way
    this._record();
    const b = bounds(ref);
    const f = p => axis === 'x' ? { x: 2 * b.cx - p.x, y: p.y } : { x: p.x, y: 2 * b.cy - p.y };
    const fix = (pts, k) => {
      const r = mapPts(pts, f);
      if (this.symOn) return this._reverse(r); // keep the seed's start/end on the mirror line
      // An unfinished outline keeps its ends where they are: the first point is the one that
      // closes it, and swapping that for the last one under a flip would be a riddle.
      if (!this.open[k] && r.length >= 3 && signedArea(r) < 0) return this._reverse(r);
      return r;
    };
    for (const k of keys) this.shape[k] = fix(this.shape[k], k);
    this._changed();
  }

  // Line the inner wall up against the outer one: h/v are 'start' | 'center' | 'end'
  // (left/centre/right and top/middle/bottom in screen terms).
  alignInner(h = 'center', v = 'center') {
    const disp = this._display();
    if (disp.outer.length < 3 || disp.inner.length < 3) return;
    const o = bounds(disp.outer), i = bounds(disp.inner);
    const along = (pos, oLo, oHi, iLo, iHi) =>
      pos === 'start' ? oLo - iLo : pos === 'end' ? oHi - iHi : (oLo + oHi) / 2 - (iLo + iHi) / 2;
    const dx = along(h, o.minX, o.maxX, i.minX, i.maxX);
    const dy = along(v, o.minY, o.maxY, i.minY, i.maxY);
    if (!dx && !dy) return;
    this._record();
    this.shape.inner = mapPts(this.shape.inner, p => ({ x: p.x + dx, y: p.y + dy }));
    this._changed();
  }

  // ----- rounding the corners -----
  // A tool with a mode of its own: it takes the wall being edited as it stands, shows what any
  // amount of rounding would do to it while the slider moves, and then either keeps that or puts
  // the original back. Nothing is recorded until it is applied, so sliding about costs no undo
  // steps and lands as a single one; and the canvas is left alone while it is open, because what
  // it is showing is a preview and not yet the drawing.
  get rounding() {
    const r = this.round;
    return r ? { wall: r.wall, amount: r.amount, kind: r.kind } : null;
  }

  // Is there a wall here to round? What the toolbar button is enabled by.
  get canRound() { return flatten(this.points, !this._openWall()).length >= 3; }

  beginRound() {
    if (this.round || !this.canRound) return null;
    const k = this.active, base = copy(this.shape[k]);
    // The slider opens where the shape already stands, so it can be turned both ways: down to
    // sharp corners as readily as up to round ones.
    this.round = { wall: k, id: this.layer.id, base, amount: roundAmountOf(base), kind: roundKindOf(base) };
    this.stroke = null; this.drag = null; this.gesture = null; this.viewGesture = null;
    this._select(-1);
    this._setCursor(this._defaultCursor());
    this.dirty = true;
    return this.round.amount;
  }

  // Show what this much rounding looks like. Always worked out from the shape as it was when
  // the tool opened, so the slider is a dial and not a ratchet — sliding back really goes back.
  setRound(amount) {
    const r = this.round;
    if (!r) return;
    r.amount = Math.min(1, Math.max(0, isFinite(amount) ? amount : 0));
    this.shape[r.wall] = this._roundedFrom(r.base, r.wall, r.amount);
    this._changed();
  }

  applyRound() {
    const r = this.round;
    if (!r) return false;
    const rounded = this.shape[r.wall];
    this.layer._disp = null;
    if (r.wall === 'outer' && this._blocked(this._guardOutline())) {
      this._blockNote('That much rounding runs into another shape — take the slider back a little.');
      return false;   // the tool stays open: the slider is the way out of this
    }
    // The undo step has to record the wall as it was before the tool opened. Every preview in
    // between went in without being recorded, so the original goes back just long enough to be
    // snapshotted and the rounded one takes its place again.
    this.shape[r.wall] = r.base;
    this._record();
    this.shape[r.wall] = rounded;
    this.round = null;
    this.layer._disp = null;
    this._autoFit();
    this._changed();
    return true;
  }

  cancelRound() {
    if (!this.round) return false;
    this._dropRound();
    this._autoFit();
    this._changed();
    return true;
  }

  // Put the preview back without saying anything. Everything that replaces the drawing under
  // the tool calls this first: what it is showing was never recorded, so it must not be left
  // behind. It restores by layer id, so it is safe even from code that is about to switch shapes.
  _dropRound() {
    const r = this.round;
    if (!r) return;
    this.round = null;
    const l = this.layers.find(x => x.id === r.id);
    if (!l) return;
    l.shape[r.wall] = r.base;
    l._disp = null;
  }

  // What rounding this contour by `amount` gives. Few enough anchors and they are the corners
  // somebody placed: curve them where they stand, so the shape keeps its points and can still be
  // edited corner by corner. A traced outline has no corners to speak of — hundreds of tiny
  // handles would change nothing you can see — so that one is cut back as a polyline instead.
  _roundedFrom(base, wall, amount) {
    const open = this._openWall(wall);
    if (roundKindOf(base) === 'anchors') return curveCorners(base, amount * ROUND_BULGE, !open);
    const pts = flatten(base, !open);
    if (pts.length < 3 || !amount) return copy(base);
    const cut = amount * CHAIKIN_CUT;
    if (open) return roundCorners(pts, 2, false, cut);
    return cleanPolygon(roundCorners(pts, 2, true, cut), 0.002) || copy(base);
  }

  // Switching symmetry: bake the current full shape, then keep only the editable part as the seed.
  setSymmetry(sym) {
    this._dropRound();
    const next = { x: !!sym.x, y: !!sym.y };
    if (next.x === this.sym.x && next.y === this.sym.y) return;
    if (this.shape.outer.length >= 3) this._record();
    // An outline still being placed is taken as the shape it would be if it were closed here:
    // mirroring turns it into a half, and a half is closed by its mirror lines, so there is
    // nothing left for the user to click. Reading the (empty) display instead would lose it.
    const full = {
      outer: this.open.outer ? flatten(this.shape.outer, true) : this._display().outer,
      inner: this.open.inner ? flatten(this.shape.inner, true) : this._display().inner,
    };
    const wasOn = this.symOn;
    this.shape = copyShape(full);
    // The mirror lines cross in the middle of this shape, wherever it sits on the plate — an
    // empty layer mirrors about the canvas centre, which is where drawing starts anyway.
    if (!wasOn) {
      const b = full.outer.length >= 3 ? bounds(full.outer) : null;
      this.symOrigin = b ? { x: b.cx, y: b.cy } : { x: 0, y: 0 };
    }
    this.sym = next;
    // Mirror lines close a half by themselves, so switching symmetry on finishes whatever was
    // being drawn; switching it off bakes the full shape, which is closed either way.
    this.layer.open = { outer: false, inner: false };
    if (this.symOn) this._toSeeds();
    this._select(-1);
    this._changed();
  }

  setGrid(size, snap) {
    this.grid = { size: Math.max(0.5, size || 10), snap: !!snap };
    this.onView(this.view);   // the scale bar in the grid control follows the grid size
    this.requestRender();
  }

  addGuide(axis) {
    const existing = this.guides.filter(g => g.axis === axis).length;
    this.guides.push({ axis, pos: existing * 10 });
    this.onGuides(this.guides); this.requestRender();
  }

  clearGuides() { this.guides = []; this.onGuides(this.guides); this.requestRender(); }

  // ----- point selection / curves -----

  get selectedPoint() { return this.selected >= 0 ? this.points[this.selected] : null; }

  selectPoint(i) { this._select(i); this.requestRender(); }

  deletePoint(i = this.selected) {
    if (i < 0 || i >= this.points.length) return;
    // A closed outline has to stay a polygon; a half needs two ends; an outline still being
    // drawn may be taken apart down to nothing — it is not holding anything up yet.
    const min = this.symOn ? 2 : this.open[this.active] ? 0 : 3;
    if (this.points.length <= min) return;
    this._record();
    if (!this._guard(() => this.points.splice(i, 1), BLOCK_MSG)) { this.undoStack.pop(); return; }
    this._select(-1);
    this._changed();
  }

  // mode: 'add' (curve handles from the neighbours), 'reset' (same, recomputed), 'remove'
  setCurve(i = this.selected, mode = 'add') {
    const pts = this.points;
    if (i < 0 || i >= pts.length) return;
    this._record();
    const run = () => {
    const p = pts[i];
    if (mode === 'remove') { delete p.in; delete p.out; delete p.smooth; }
    else {
      const n = pts.length;
      const prev = pts[(i - 1 + n) % n], next = pts[(i + 1) % n];
      let tx = next.x - prev.x, ty = next.y - prev.y;
      const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
      const d1 = dist(p, prev) / 3, d2 = dist(p, next) / 3;
      p.in = { x: -tx * d1, y: -ty * d1 };
      p.out = { x: tx * d2, y: ty * d2 };
      if (p.smooth === undefined) p.smooth = true;
    }
    };
    if (!this._guard(run, BLOCK_MSG)) { this.undoStack.pop(); return; }
    this._changed();
  }

  // Move a point to an absolute position (properties panel, arrow keys).
  movePoint(i, x, y, { record = true } = {}) {
    const p = this.points[i];
    if (!p || !isFinite(x) || !isFinite(y)) return;
    if (record) this._record();
    const c = this._clamp({ x, y });
    if (!this._guard(() => { const q = this.points[i]; q.x = c.x; q.y = c.y; }, BLOCK_MSG)) {
      if (record) this.undoStack.pop();
      return;
    }
    this._changed();
  }

  // Arrow keys: step the selected point by a whole number of millimetres.
  nudgePoint(dx, dy, i = this.selected) {
    const p = this.points[i];
    if (!p) return;
    this.movePoint(i, p.x + dx, p.y + dy);
  }

  // Set one Bézier handle as an offset from its anchor (properties panel).
  setHandle(i, which, x, y) {
    const p = this.points[i];
    if (!p || !p[which] || !isFinite(x) || !isFinite(y)) return;
    this._record();
    const run = () => { const q = this.points[i]; q[which] = { x, y }; this._mirrorHandle(q, which); };
    if (!this._guard(run, BLOCK_MSG)) { this.undoStack.pop(); return; }
    this._changed();
  }

  // Keep the opposite handle collinear (same length) while 'Sync handles' is on.
  _mirrorHandle(p, which) {
    if (p.smooth === false) return;
    const h = p[which], other = which === 'in' ? 'out' : 'in';
    const l = Math.hypot(h.x, h.y) || 1;
    const lo = p[other] ? Math.hypot(p[other].x, p[other].y) : l;
    p[other] = { x: -h.x / l * lo, y: -h.y / l * lo };
  }

  setSmooth(i = this.selected, smooth = true) {
    const p = this.points[i];
    if (!p) return;
    this._record();
    p.smooth = !!smooth;
    if (p.smooth && p.in && p.out) {
      // align the incoming handle with the outgoing one
      const l = Math.hypot(p.in.x, p.in.y), lo = Math.hypot(p.out.x, p.out.y) || 1;
      p.in = { x: -p.out.x / lo * l, y: -p.out.y / lo * l };
    }
    this._changed();
  }

  // Finish a freehand sketch: smooth, clean, and make it a proper polygon.
  // In symmetry mode the stroke stays an open half; it is closed along the mirror lines.
  finalizeSketch(raw) {
    const s = this.smoothing;
    const tol = 0.15 + s * 1.6;
    const passes = s < 0.15 ? 0 : s < 0.6 ? 1 : 2;
    let pts = simplify(raw, tol);
    if (this.symOn) {
      if (passes) pts = chaikin(pts, passes, false);
      return pts.length >= 2 ? pts : null;
    }
    if (passes) pts = chaikin(pts, passes);
    return cleanPolygon(pts, 0.03);
  }

  requestRender() { this.dirty = true; }

  // ---------- internals ----------

  get symOn() { return this.sym.x || this.sym.y; }

  // The 2D wall bands for one layer. Its own settings decide them, so the cache is keyed on
  // the layer and its edit counter as well.
  _ringsFor(layer) {
    const d = this._displayOf(layer);
    if (d.outer.length < 3) return null;
    return this.ringsProvider(d, layer.params, layer.id, layer.rev);
  }

  _select(i) {
    if (i === this.selected) return;
    this.selected = i;
    this.onSelect(i >= 0 ? { index: i, point: this.points[i] } : null);
    this.dirty = true;
  }

  _record() {
    this.undoStack.push(this._snapshot());
    if (this.undoStack.length > 60) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  // Undo covers the drawing: every layer's contours and mirror, which layer you were on, and
  // which wall. Wall settings have no undo of their own, so a layer that is still here keeps
  // the settings it has now — only a layer being brought back from the dead gets its own again.
  _snapshot() {
    return { layers: this.layers.map(copyLayer), index: this.index, active: this.active };
  }

  _restore(snap) {
    const now = new Map(this.layers.map(l => [l.id, l]));
    this.layers = snap.layers.map(l => {
      const out = copyLayer(l), cur = now.get(l.id);
      if (cur) { out.params = cur.params; out.bridgeAuto = cur.bridgeAuto; out.rev = cur.rev; }
      out.rev++;
      return out;
    });
    this.index = Math.min(Math.max(0, snap.index), this.layers.length - 1);
    this.picked = true;
    this.active = snap.active === 'inner' && this.shape.inner.length >= 3 ? 'inner' : 'outer';
  }

  // selectionOnly: which shape you are on has changed, not what any of them look like — the
  // panel and the canvas follow, but nothing needs building again.
  _changed({ selectionOnly = false } = {}) {
    this.version++; this.layer.rev++; this.dirty = true;
    if (this.selected >= this.points.length) this._select(-1);
    else if (this.selected >= 0) this.onSelect({ index: this.selected, point: this.points[this.selected] });
    this.onChange(this.getShape(), { selectionOnly });
  }

  // Reverse a contour, swapping in/out handles.
  _reverse(pts) {
    return pts.slice().reverse().map(p => { const q = copyPt(p); const t = q.in; q.in = q.out; q.out = t; if (!q.in) delete q.in; if (!q.out) delete q.out; return q; });
  }

  _centerShape() {
    const b = bounds(this._display().outer);
    this._shift(-b.cx, -b.cy);
  }

  // Reduce full contours to their editable part (seed) for symmetry mode.
  _toSeeds() {
    for (const k of ['outer', 'inner']) {
      if (this.shape[k].length < 3) continue;
      this.shape[k] = clipToRegion(flatten(this.shape[k]), this.sym, this.symOrigin) || [];
    }
  }

  // Close an open half along the mirror lines: last point → axis → (origin) → axis → first point.
  // The lines cross at the layer's own symOrigin, not at the canvas centre.
  _closeViaAxesIn(layer, pts) {
    const sym = layer.sym, ox = layer.symOrigin.x, oy = layer.symOrigin.y;
    const proj = (p) => {
      if (sym.x && sym.y) return (p.x - ox) < -(p.y - oy) ? { x: ox, y: p.y } : { x: p.x, y: oy };
      return sym.x ? { x: ox, y: p.y } : { x: p.x, y: oy };
    };
    const first = pts[0], last = pts[pts.length - 1];
    const detour = [proj(last)];
    if (sym.x && sym.y) detour.push({ x: ox, y: oy });
    detour.push(proj(first));
    return pts.concat(detour);
  }
  _closeViaAxes(pts) { return this._closeViaAxesIn(this.layer, pts); }

  // The full contour for a seed: curves flattened, closed along the mirror lines, cleaned and mirrored.
  _effectiveIn(layer, pts) {
    const sym = layer.sym;
    if (!(sym.x || sym.y)) return flatten(pts, true);
    if (pts.length < 2) return [];
    return symmetrize(this._closeViaAxesIn(layer, flatten(pts, false)), sym, layer.symOrigin) || [];
  }
  _effective(pts) { return this._effectiveIn(this.layer, pts); }

  // What is drawn and exported: the effective version of each contour. Cached per layer on its
  // own edit counter *and* on the identity of the two arrays — code that swaps a contour in and
  // reads the display back before _changed() runs depends on that second half.
  _displayOf(layer) {
    const c = layer._disp;
    const key = `${layer.rev}|${layer.sym.x}|${layer.sym.y}|${layer.symOrigin.x}|${layer.symOrigin.y}`
      + `|${layer.open.outer}|${layer.open.inner}`;
    if (c && c.key === key && c.outerRef === layer.shape.outer && c.innerRef === layer.shape.inner) return c.shape;
    // An outline still being placed contributes nothing: no fill, no wall bands, no solid, no
    // size. It is drawn as the line it is (_renderDraft) and becomes a shape when it is closed.
    const s = {
      outer: layer.open.outer ? [] : this._effectiveIn(layer, layer.shape.outer),
      inner: layer.open.inner ? [] : this._effectiveIn(layer, layer.shape.inner),
    };
    layer._disp = { key, shape: s, outerRef: layer.shape.outer, innerRef: layer.shape.inner };
    return s;
  }
  _display() { return this._displayOf(this.layer); }

  // The whole drawing: every layer's outer contour, for fitting the view and for the totals.
  allOuters() {
    const out = [];
    for (const l of this.layers) {
      const o = this._displayOf(l).outer;
      if (o.length >= 3) out.push(o);
    }
    return out;
  }
  allBounds() {
    const all = this.allOuters();
    if (!all.length) return null;
    return bounds(all.flat());
  }

  // ----- keeping the shapes apart -----
  // Two cutters on one plate have to come off the printer as two cutters, so every move, resize
  // and stroke is measured against what the other layers occupy: their outline grown by their
  // own base, by this shape's base, and by a nozzle width of air. The grown outlines are worked
  // out once and reused — the other layers do not move while you are dragging this one.
  _baseWidthOf(l) { return Math.max(l.params.bladeWidth, l.params.baseWidth); }

  _keepOut() {
    const mine = this._baseWidthOf(this.layer);
    const key = this.layers.map((l, i) => (i === this.index ? '' : `${l.id}:${l.rev}:${this._baseWidthOf(l)}`)).join('|') + `#${mine}`;
    if (this._keepOutCache.key === key) return this._keepOutCache.polys;
    const polys = [];
    for (let i = 0; i < this.layers.length; i++) {
      if (i === this.index) continue;
      const o = this._displayOf(this.layers[i]).outer;
      if (o.length < 3) continue;
      try {
        const grown = offsetPolygon(o, this._baseWidthOf(this.layers[i]) + mine + SHAPE_GAP);
        if (grown && grown.length >= 3) polys.push(grown);
      } catch { /* an outline Clipper cannot grow is the builder's problem, not the guard's */ }
    }
    this._keepOutCache = { key, polys };
    return polys;
  }

  // Would this outline (canvas mm) run into another shape? Overlap either way round counts, so
  // a shape cannot be dropped inside another one's hole either.
  _blocked(outer) {
    if (this.allowOverlap) return false;   // shapes are allowed to run into each other
    if (!outer || outer.length < 3 || this.layers.length < 2) return false;
    const keep = this._keepOut();
    if (!keep.length) return false;
    try {
      for (const k of keep) if (intersectPolygons([outer], [k]).length) return true;
    } catch { return false; }
    return false;
  }

  // Which shapes are touching or sitting on top of another one. With the guard up nothing you
  // draw can get into that state, but a file decides for itself where its shapes go — so an
  // import has to be looked over before it is called a plate, and that is also what tells the
  // app the file needs overlapping shapes allowed.
  clashingLayers() {
    const drawn = this.layers.map((l, i) => ({ i, outer: this._displayOf(l).outer, w: this._baseWidthOf(l) }))
      .filter(d => d.outer.length >= 3);
    const bad = new Set();
    for (let a = 0; a < drawn.length; a++) {
      for (let b = a + 1; b < drawn.length; b++) {
        try {
          const grown = offsetPolygon(drawn[b].outer, drawn[a].w + drawn[b].w + SHAPE_GAP);
          if (grown && grown.length >= 3 && intersectPolygons([drawn[a].outer], [grown]).length) {
            bad.add(drawn[a].i); bad.add(drawn[b].i);
          }
        } catch { /* an outline Clipper cannot grow is the builder's problem, not the guard's */ }
      }
    }
    return [...bad].sort((x, y) => x - y);
  }

  // Say it once: a drag would otherwise repeat the same sentence sixty times a second.
  _blockNote(msg) {
    if (!msg) return;
    const now = performance.now();
    if (this._lastBlock === msg && now - this._lastBlockAt < 1500) return;
    this._lastBlock = msg; this._lastBlockAt = now;
    this.onBlock(msg);
  }

  // Is the active layer, exactly as it stands this instant, clear of the others? The display
  // cache is dropped first: an edit that moved a point in place leaves the arrays and the edit
  // counter alone, so the cached contour would still be the one from before the move.
  _allowed() {
    if (this.active === 'inner') return true;
    this.layer._disp = null;
    return !this._blocked(this._guardOutline());
  }

  // What the guard measures. An outline still being placed has no display contour, so it is
  // measured by what it would enclose if it were closed here: the corner that crosses a
  // neighbour is stopped as it goes down, rather than the whole outline failing to close later.
  _guardOutline() {
    const pts = this.shape.outer;
    if (!this.open.outer) return this._display().outer;
    return pts.length >= 3 ? flatten(pts, true) : [];
  }

  // The contour of the wall being edited as it stands: the finished ring, or the open line of
  // an outline still being drawn. What Flip and the Move box measure.
  _activeOutline(k = this.active) {
    const d = this._display()[k];
    if (d.length || !this.open[k]) return d;
    return flatten(this.shape[k], false);
  }

  // Make a change to the active layer and take it back whole if it would run into another shape.
  _guard(fn, message) {
    if (this.allowOverlap || this.layers.length < 2 || this.active === 'inner') { fn(); return true; }
    const before = copyShape(this.shape), origin = { ...this.symOrigin };
    fn();
    if (this._allowed()) return true;
    this.shape = before; this.symOrigin = origin; this.layer._disp = null;
    this._blockNote(message);
    return false;
  }

  // Somewhere a shape fits without touching anything: clear to the right of all the others,
  // level with the middle of them.
  _freeSpot(outer) {
    let right = -Infinity, top = Infinity, bottom = -Infinity;
    for (let i = 0; i < this.layers.length; i++) {
      if (i === this.index) continue;
      const o = this._displayOf(this.layers[i]).outer;
      if (o.length < 3) continue;
      const b = bounds(o), pad = this._baseWidthOf(this.layers[i]);
      right = Math.max(right, b.maxX + pad);
      top = Math.min(top, b.minY); bottom = Math.max(bottom, b.maxY);
    }
    if (right === -Infinity) return null;
    const b = bounds(outer);
    return { dx: right + this._baseWidthOf(this.layer) + SHAPE_GAP + b.width / 2 - b.cx, dy: (top + bottom) / 2 - b.cy };
  }

  _shift(dx, dy) {
    const f = p => ({ x: p.x + dx, y: p.y + dy });
    this.shape = { outer: mapPts(this.shape.outer, f), inner: mapPts(this.shape.inner, f) };
    this.symOrigin = f(this.symOrigin);
  }

  _autoFit() {
    // Once the view has been zoomed or panned by hand it belongs to the user; re-fitting
    // under them would move the drawing out from under the cursor.
    if (this.view.manual) return;
    const b = this.allBounds();
    if (!b) { this.view.size = 160; return; }
    const extent = 2 * Math.max(Math.abs(b.minX), Math.abs(b.maxX), Math.abs(b.minY), Math.abs(b.maxY)) + 24;
    const needed = Math.max(120, extent);
    if (needed > this.view.size * 0.98 || needed < this.view.size * 0.55) this.view.size = Math.ceil(needed / 10) * 10;
  }

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    const r = this.canvas.getBoundingClientRect();
    this.w = Math.max(1, r.width); this.h = Math.max(1, r.height);
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.dirty = true;
  }

  get scale() { return Math.min(this.w, this.h) / this.view.size * this.view.zoom; }
  toPx(p) {
    const s = this.scale, v = this.view.pan;
    return { x: this.w / 2 + (p.x - v.x) * s, y: this.h / 2 + (p.y - v.y) * s };
  }
  toMm(px) {
    const s = this.scale, v = this.view.pan;
    return { x: (px.x - this.w / 2) / s + v.x, y: (px.y - this.h / 2) / s + v.y };
  }
  get snapMm() { return SNAP_PX / this.scale; }

  _eventPos(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  _bind() {
    const c = this.canvas;
    c.style.touchAction = 'none';
    c.addEventListener('pointerdown', (e) => this._down(e));
    c.addEventListener('pointermove', (e) => this._move(e));
    c.addEventListener('pointerup', (e) => this._up(e));
    c.addEventListener('pointercancel', (e) => this._up(e));
    c.addEventListener('pointerleave', () => { this._setHot(-1); if (!this.drag && !this.stroke) this._setCursor(this._defaultCursor()); });
    c.addEventListener('wheel', (e) => {
      // Zoom towards the cursor. preventDefault stops the page scrolling under the canvas.
      e.preventDefault();
      this.zoomBy(Math.exp(-e.deltaY * 0.0015), this._eventPos(e));
    }, { passive: false });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  _setCursor(c) { if (this.canvas.style.cursor !== c) this.canvas.style.cursor = c; }

  // ----- snapping -----

  inRegion(p) {
    const o = this.symOrigin;
    return (!this.sym.x || p.x >= o.x - 1e-9) && (!this.sym.y || p.y <= o.y + 1e-9);
  }

  _clamp(p) {
    const o = this.symOrigin;
    return { x: this.sym.x ? Math.max(o.x, p.x) : p.x, y: this.sym.y ? Math.min(o.y, p.y) : p.y };
  }

  // clamp: false lets the result leave the editable half — a Bézier handle may reach across
  // the mirror line (the curve itself is clipped to the region when the shape is built).
  _snapPoint(p, { grid = true, axis = true, guides = true, clamp = true } = {}) {
    const t = this.snapMm;
    let x = p.x, y = p.y, sx = false, sy = false;
    if (guides) for (const g of this.guides) {
      if (g.axis === 'v' && !sx && Math.abs(x - g.pos) < t) { x = g.pos; sx = true; }
      if (g.axis === 'h' && !sy && Math.abs(y - g.pos) < t) { y = g.pos; sy = true; }
    }
    if (axis) {
      const o = this.symOrigin;
      if (this.sym.x && !sx && Math.abs(x - o.x) < t) { x = o.x; sx = true; }
      if (this.sym.y && !sy && Math.abs(y - o.y) < t) { y = o.y; sy = true; }
    }
    if (grid && this.grid.snap) {
      const g = this.grid.size;
      if (!sx) x = Math.round(x / g) * g;
      if (!sy) y = Math.round(y / g) * g;
    }
    return clamp ? this._clamp({ x, y }) : { x, y };
  }

  _snapBox(b) {
    const t = this.snapMm;
    // Guides and the grid only: a shape's own mirror line moves along with it, so snapping
    // the box it sits inside to that line would mean snapping it to itself.
    const targetsX = this.guides.filter(g => g.axis === 'v').map(g => g.pos);
    const targetsY = this.guides.filter(g => g.axis === 'h').map(g => g.pos);
    const best = (edges, targets) => {
      let d = 0, bestAbs = t;
      for (const e of edges) {
        for (const tg of targets) { const dd = tg - e; if (Math.abs(dd) < bestAbs) { bestAbs = Math.abs(dd); d = dd; } }
        if (this.grid.snap) { const g = this.grid.size; const dd = Math.round(e / g) * g - e; if (Math.abs(dd) < bestAbs) { bestAbs = Math.abs(dd); d = dd; } }
      }
      return d;
    };
    return { dx: best([b.minX, b.maxX, b.cx], targetsX), dy: best([b.minY, b.maxY, b.cy], targetsY) };
  }

  // ----- hit testing -----

  _editBounds() {
    const pts = this._display()[this.active];
    if (pts.length < 3) return null;
    const b = bounds(pts);
    if (this.sym.x) b.minX = Math.max(b.minX, this.symOrigin.x);
    if (this.sym.y) b.maxY = Math.min(b.maxY, this.symOrigin.y);
    b.width = b.maxX - b.minX; b.height = b.maxY - b.minY; b.cx = (b.minX + b.maxX) / 2; b.cy = (b.minY + b.maxY) / 2;
    return b;
  }

  _bboxHandles() {
    // Nothing held: no box, no handles, and nothing for a drag to catch hold of.
    if (!this.picked) return null;
    const b = this._editBounds();
    if (!b) return null;
    const tl = this.toPx({ x: b.minX, y: b.minY }), br = this.toPx({ x: b.maxX, y: b.maxY });
    const cx = (tl.x + br.x) / 2, cy = (tl.y + br.y) / 2;
    let handles = [
      { id: 'nw', x: tl.x, y: tl.y, ax: 1, ay: 1, cursor: 'nwse-resize' }, { id: 'ne', x: br.x, y: tl.y, ax: -1, ay: 1, cursor: 'nesw-resize' },
      { id: 'se', x: br.x, y: br.y, ax: -1, ay: -1, cursor: 'nwse-resize' }, { id: 'sw', x: tl.x, y: br.y, ax: 1, ay: -1, cursor: 'nesw-resize' },
      { id: 'n', x: cx, y: tl.y, ax: 0, ay: 1, cursor: 'ns-resize' }, { id: 's', x: cx, y: br.y, ax: 0, ay: -1, cursor: 'ns-resize' },
      { id: 'w', x: tl.x, y: cy, ax: 1, ay: 0, cursor: 'ew-resize' }, { id: 'e', x: br.x, y: cy, ax: -1, ay: 0, cursor: 'ew-resize' },
    ];
    if (this.sym.x) handles = handles.filter(h => h.ax !== 1);
    if (this.sym.y) handles = handles.filter(h => h.ay !== -1);
    return { b, tl, br, handles, rot: this.symOn ? null : { x: cx, y: tl.y - ROT_STEM }, center: { x: cx, y: cy } };
  }

  _hitVertex(px) {
    let best = -1, bestD = HIT_R * HIT_R;
    this.points.forEach((p, i) => {
      if (!this.inRegion(p)) return;
      const q = this.toPx(p);
      const d = (q.x - px.x) ** 2 + (q.y - px.y) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    });
    return best;
  }

  _hitHandle(px) {
    const p = this.selectedPoint;
    if (!p) return null;
    for (const which of ['in', 'out']) {
      if (!p[which]) continue;
      const q = this.toPx({ x: p.x + p[which].x, y: p.y + p[which].y });
      if ((q.x - px.x) ** 2 + (q.y - px.y) ** 2 <= HIT_R * HIT_R) return which;
    }
    return null;
  }

  _hitEdge(px) {
    // uses the flattened curve so inserting on a curved segment works; returns the control-point index to insert at
    const ctrl = this.points, n = ctrl.length;
    if (n < 2) return null;
    let best = null, bestD = HIT_R * HIT_R;
    const m = this.symOn ? n - 1 : n;
    for (let i = 0; i < m; i++) {
      const seg = flatten([ctrl[i], ctrl[(i + 1) % n]], false);
      for (let k = 0; k + 1 < seg.length; k++) {
        const a = this.toPx(seg[k]), b = this.toPx(seg[k + 1]);
        const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy || 1;
        let t = ((px.x - a.x) * dx + (px.y - a.y) * dy) / len2; t = Math.max(0, Math.min(1, t));
        const qx = a.x + t * dx, qy = a.y + t * dy;
        const d = (qx - px.x) ** 2 + (qy - px.y) ** 2;
        if (d < bestD) { bestD = d; best = { index: i + 1, point: this.toMm({ x: qx, y: qy }) }; }
      }
    }
    return best;
  }

  _hitGuide(px) {
    for (let i = 0; i < this.guides.length; i++) {
      const g = this.guides[i];
      const tab = g.axis === 'v' ? { x: this.toPx({ x: g.pos, y: 0 }).x, y: 14 } : { x: 24, y: this.toPx({ x: 0, y: g.pos }).y };
      if ((tab.x - px.x) ** 2 + (tab.y - px.y) ** 2 <= HIT_R * HIT_R) return i;
    }
    return -1;
  }

  _insideShape(mm) {
    return inPoly(this._display()[this.active], mm);
  }

  // Which shape is under the pointer, by its outline: the one being edited first — it is drawn
  // on top of the others — then the rest, topmost first. An outline still being placed is not a
  // shape yet and cannot be picked up.
  _layerAt(mm) {
    const order = [this.index];
    for (let i = this.layers.length - 1; i >= 0; i--) if (i !== this.index) order.push(i);
    for (const i of order) {
      const outer = this._displayOf(this.layers[i]).outer;
      if (outer.length >= 3 && inPoly(outer, mm)) return i;
    }
    return -1;
  }

  _affected() { return this.active === 'outer' ? ['outer', 'inner'] : ['inner']; }

  // Move / resize / rotate. The mirror origin goes through the same transform, so a symmetric
  // shape can be dragged anywhere and its mirror lines stay where its half meets them. A
  // transform that would run into another shape is simply not applied — the shape stops against
  // its neighbour instead of passing through it.
  _applyTransform(start, f) {
    const shape = copyShape(this.shape);
    for (const k of this._affected()) shape[k] = mapPts(start[k], f);
    const before = this.shape, origin = this.symOrigin;
    this.shape = shape;
    if (start.origin) this.symOrigin = f(start.origin);
    if (this._allowed()) return true;
    this.shape = before; this.symOrigin = origin; this.layer._disp = null;
    this._blockNote(BLOCK_MSG);
    return false;
  }

  // What a drag starts from: the contours and the mirror origin together, so both are
  // transformed from the same place however far the drag wanders.
  _startState() { return { ...copyShape(this.shape), origin: { ...this.symOrigin } }; }

  // What is under the pointer when nothing is being dragged; also picks the cursor.
  _hover(px) {
    if (this.panMode) return { kind: 'pan', cursor: this.drag ? 'grabbing' : 'grab' };
    const gi = this._hitGuide(px);
    if (gi >= 0) return { kind: 'guide', index: gi, cursor: this.guides[gi].axis === 'v' ? 'col-resize' : 'row-resize' };
    if (this.round) return { kind: 'none', cursor: 'default' };
    if (this.tool === 'draw') return { kind: 'draw', cursor: 'crosshair' };
    if (this.tool === 'points') {
      const h = this._hitHandle(px);
      if (h) return { kind: 'handle', which: h, cursor: 'pointer' };
      const vi = this._hitVertex(px);
      if (vi >= 0) return { kind: 'vertex', index: vi, cursor: 'pointer' };
      // While an outline is being placed every click is the next corner, so there is nothing to
      // insert into yet. Once it is closed, corners only go on the line itself — clicking the
      // canvas or the inside of the shape lets go of the point you had instead of adding one.
      // A symmetric half is never closed by the user, so it keeps taking corners forever.
      const drawing = !!this.open[this.active];
      const edge = drawing ? null : this._hitEdge(px);
      if (edge && this.points.length >= 3 && this.inRegion(edge.point)) return { kind: 'edge', edge, cursor: 'copy' };
      if (drawing || this.symOn || this.points.length < 3) return { kind: 'add', cursor: 'crosshair' };
      return { kind: 'none', cursor: 'default' };
    }
    const hb = this._bboxHandles();
    const near = (h) => h && (h.x - px.x) ** 2 + (h.y - px.y) ** 2 <= HIT_R * HIT_R;
    if (hb) {
      if (near(hb.rot)) return { kind: 'rotate', hb, cursor: ROTATE_CURSOR };
      const h = hb.handles.find(near);
      if (h) return { kind: 'scale', h, hb, cursor: h.cursor };
    }
    const mm = this.toMm(px);
    if (hb && this._insideShape(mm)) return { kind: 'move', hb, cursor: 'move' };
    // Any other shape under the pointer is what a click picks up. The shape already in hand
    // counts as one too — you can be over it without being over the wall you are moving (its
    // inner one) — and picking it up again does nothing, which is better than letting go of it.
    const i = this._layerAt(mm);
    if (i >= 0) return { kind: 'pick', layer: i, cursor: i === this.index && this.picked ? 'default' : 'pointer' };
    return { kind: 'none', cursor: 'default' };
  }

  // Plain hover: the cursor, and which shape is lit up as the one a click would pick up.
  _hoverAt(px) {
    const h = this._hover(px);
    this._setCursor(h.cursor);
    this._setHot(h.kind === 'pick' && h.layer !== this.index ? h.layer : -1);
    return h;
  }

  _setHot(i) {
    if (this.hot === i) return;
    this.hot = i;
    this.dirty = true;
  }

  // ----- pointer handling -----

  _down(e) {
    e.preventDefault();
    this.canvas.setPointerCapture(e.pointerId);
    const px = this._eventPos(e);
    this.pointers.set(e.pointerId, px);
    this._cancelPress();
    this._setHot(-1);   // the pointer is on its way down; nothing is merely being looked at

    // In pan mode two fingers pinch the view — on a phone there is no scroll wheel.
    if (this.pointers.size === 2 && this.panMode) {
      this.drag = null;
      const [a, b] = [...this.pointers.values()];
      this.viewGesture = {
        d0: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)),
        z0: this.view.zoom,
        c0: this.toMm({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }),
      };
      return;
    }
    // Nothing in hand, nothing to pinch: with the shape put down the two-finger gesture has no
    // more business reshaping it than the handles have being on screen.
    if (this.pointers.size === 2 && !this.panMode && this.picked && this.points.length >= 3 && !this.symOn) {
      this.stroke = null; this.drag = null;
      const [a, b] = [...this.pointers.values()];
      this.gesture = { start: this._startState(), d0: Math.hypot(b.x - a.x, b.y - a.y),
        a0: Math.atan2(b.y - a.y, b.x - a.x), c: this.toMm({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }) };
      this._record();
      return;
    }
    if (this.pointers.size > 1) return;

    // Pan mode, or the middle mouse button anywhere, drags the view instead of the shape.
    // The right button does too (same as the 3D preview), but a right-click that never moves
    // still opens the point menu, so that gesture is not lost.
    if (this.panMode || e.button === 1 || e.button === 2) {
      const vi = e.button === 2 && this.tool === 'points' ? this._hitVertex(px) : -1;
      this.drag = {
        kind: 'pan', p0: px, v0: { x: this.view.pan.x, y: this.view.pan.y },
        moved: false, menuIndex: vi, ev: e,
      };
      this._setCursor('grabbing');
      return;
    }

    // While the rounding tool is open the canvas is showing a preview, not the drawing. Panning,
    // zooming and the guides above still work; nothing that would edit the shape does.
    if (this.round) return;

    const hit = this._hover(px);
    const mm = this.toMm(px);
    const rightClick = e.button === 2;

    if (hit.kind === 'guide') {
      const now = performance.now(), key = `g${hit.index}`;
      if (this.lastTap.key === key && now - this.lastTap.t < 350) {
        this.guides.splice(hit.index, 1); this.onGuides(this.guides); this.lastTap = { t: 0, key: null }; this.dirty = true; return;
      }
      this.lastTap = { t: now, key };
      this.drag = { kind: 'guide', index: hit.index }; this._setCursor(hit.cursor); return;
    }

    if (this.tool === 'draw') {
      if (rightClick) return;
      this.stroke = [this._snapPoint(mm, { grid: false })];
    } else if (this.tool === 'points') {
      if (hit.kind === 'handle') {
        if (rightClick) return;
        this._record(); this.drag = { kind: 'handle', which: hit.which, index: this.selected }; this._setCursor('move'); return;
      }
      if (hit.kind === 'vertex') {
        const vi = hit.index;
        this._select(vi);
        if (rightClick) { this._openMenu(vi, e); return; }
        // The first point of an outline still being placed is how you close it: a click on it
        // makes the shape — on release, so dragging it still moves the point. While it is
        // wearing that hat it is not a double-tap-to-delete target either.
        const closes = this._closable() && vi === 0;
        if (!closes) {
          const now = performance.now(), key = `v${vi}`;
          if (this.lastTap.key === key && now - this.lastTap.t < 350) { this.lastTap = { t: 0, key: null }; this.deletePoint(vi); return; }
          this.lastTap = { t: now, key };
        }
        this._record(); this.drag = { kind: 'vertex', index: vi, moved: false, closes, px0: px, p0: { x: this.points[vi].x, y: this.points[vi].y } }; this._setCursor('move');
        if (e.pointerType !== 'mouse' && !closes) this._pressTimer = setTimeout(() => { this.drag = null; this.undoStack.pop(); this._openMenu(vi, e); }, LONG_PRESS);
        return;
      }
      if (rightClick) return;
      if (hit.kind === 'edge') {
        this._record();
        if (!this._guard(() => this.points.splice(hit.edge.index, 0, this._snapPoint(hit.edge.point)), BLOCK_MSG)) { this.undoStack.pop(); return; }
        this._select(hit.edge.index);
        // A corner put on the line is placed the same way as one put on the canvas, so holding
        // on and pulling draws its curve here too — see the 'pen' drag below.
        this.drag = { kind: 'pen', index: hit.edge.index, c0: { x: e.clientX, y: e.clientY }, pulled: false };
        this._changed(); return;
      }
      // A closed outline takes no corners from the canvas — only from its own lines. A click
      // beside the shape, or inside it, simply lets go of the point that was selected.
      if (hit.kind !== 'add') { this._select(-1); this.dirty = true; return; }
      if (!this.inRegion(mm)) return;
      this._record();
      // The first corner opens an outline: the points are joined from here on but not closed,
      // until this one is clicked again. A symmetric half is closed by its mirror lines instead.
      const opening = !this.points.length && !this.symOn;
      if (opening) this.open[this.active] = true;
      if (!this._guard(() => this.points.push(this._snapPoint(mm)), BLOCK_MSG)) {
        if (opening) this.open[this.active] = false;
        this.undoStack.pop(); return;
      }
      this._select(this.points.length - 1);
      // Keeping the button down and pulling away shapes the new corner's curve instead of
      // moving it: the corner belongs where it was put, and this is the one moment its curve
      // can be drawn in the same gesture. A click that never travels leaves a plain corner.
      // The same gesture places a corner on an existing line, above.
      // The threshold below is measured against where the button went down *on the screen*, not
      // on the canvas: placing the first corner brings the shape actions into the toolbar, and a
      // canvas that shifts under a still pointer must never be read as a drag.
      this.drag = { kind: 'pen', index: this.points.length - 1, c0: { x: e.clientX, y: e.clientY }, pulled: false };
      this._changed();
    } else if (this.tool === 'move') {
      if (rightClick) return;
      if (hit.kind === 'rotate') { this._record(); this.drag = { kind: 'rotate', start: this._startState(), c: hit.hb.b, a0: Math.atan2(px.y - hit.hb.center.y, px.x - hit.hb.center.x) }; this._setCursor(hit.cursor); return; }
      if (hit.kind === 'scale') { this._record(); this.drag = { kind: 'scale', h: hit.h, start: this._startState(), b: hit.hb.b, p0: mm }; this._setCursor(hit.cursor); return; }
      if (hit.kind === 'move') {
        this.drag = { kind: 'move', start: this._startState(), p0: mm, b0: bounds(this._display()[this.active]) }; this._setCursor('move');
      } else if (hit.kind === 'pick') {
        // A press on another shape picks it up, and the same press goes on to move it: laying
        // out a plate is then one gesture per shape, not a click and then a drag. Only while
        // the outer wall is the one being edited — that is the outline just pressed on.
        const picked = this.pickShape(hit.layer);
        if (picked && this.active === 'outer' && this._display().outer.length >= 3) {
          this.drag = { kind: 'move', start: this._startState(), p0: mm, b0: bounds(this._display().outer) }; this._setCursor('move');
        }
      } else if (hit.kind === 'none') {
        // Empty canvas: the shape is put down. Nothing is held until a shape is clicked again.
        if (this.dropShape()) this._setCursor('default');
      }
    }
    this.dirty = true;
  }

  _openMenu(index, e) {
    this._select(index);
    this.onMenu({ index, point: this.points[index], clientX: e.clientX, clientY: e.clientY });
  }

  _cancelPress() { if (this._pressTimer) { clearTimeout(this._pressTimer); this._pressTimer = null; } }

  _move(e) {
    const px = this._eventPos(e);
    if (!this.pointers.has(e.pointerId)) {
      // plain hover: pick a cursor
      if (!this.drag && !this.stroke) this._hoverAt(px);
      return;
    }
    e.preventDefault();
    const prev = this.pointers.get(e.pointerId);
    this.pointers.set(e.pointerId, px);
    if (this._pressTimer && Math.hypot(px.x - prev.x, px.y - prev.y) > 3) this._cancelPress();

    if (this.viewGesture && this.pointers.size >= 2) {
      const g = this.viewGesture, [a, b] = [...this.pointers.values()];
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      this.view.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, g.z0 * Math.hypot(b.x - a.x, b.y - a.y) / g.d0));
      // keep the mm point that was between the fingers under the midpoint
      const now = this.toMm(mid);
      this.view.pan.x += g.c0.x - now.x;
      this.view.pan.y += g.c0.y - now.y;
      this.view.manual = true;
      this.dirty = true;
      this.onView(this.view);
      return;
    }

    if (this.drag && this.drag.kind === 'pan') {
      const d = this.drag, s = this.scale;
      if (Math.hypot(px.x - d.p0.x, px.y - d.p0.y) > 3) { d.moved = true; this.view.manual = true; }
      this.view.pan.x = d.v0.x - (px.x - d.p0.x) / s;
      this.view.pan.y = d.v0.y - (px.y - d.p0.y) / s;
      this.dirty = true;
      return;
    }

    if (this.gesture && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(b.x - a.x, b.y - a.y);
      const s = Math.max(0.05, d / this.gesture.d0);
      const da = Math.atan2(b.y - a.y, b.x - a.x) - this.gesture.a0;
      const cos = Math.cos(da), sin = Math.sin(da), c = this.gesture.c;
      const mid = this.toMm({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
      this._applyTransform(this.gesture.start, p => {
        const x = (p.x - c.x) * s, y = (p.y - c.y) * s;
        return { x: mid.x + x * cos - y * sin, y: mid.y + x * sin + y * cos };
      });
      this._changed();
      return;
    }

    const mm = this.toMm(px);
    if (this.stroke) {
      const last = this.stroke[this.stroke.length - 1];
      const p = this._snapPoint(mm, { grid: false });
      if (Math.hypot(p.x - last.x, p.y - last.y) * this.scale > 1.5) this.stroke.push(p);
      this.dirty = true;
      return;
    }
    const d = this.drag;
    if (!d) return;
    if (d.kind === 'guide') {
      const g = this.guides[d.index];
      let v = g.axis === 'v' ? mm.x : mm.y;
      if (this.grid.snap) v = Math.round(v / this.grid.size) * this.grid.size;
      g.pos = Math.round(v * 10) / 10;
      this.onGuides(this.guides); this.dirty = true;
    } else if (d.kind === 'vertex') {
      // A press on the point that closes an unfinished outline stays a click until it clearly
      // becomes a drag: a hand that shifts a pixel while pressing must not lose the shape it
      // meant to make. Past the threshold it is an ordinary move, and the outline stays open.
      if (d.closes && Math.hypot(px.x - d.px0.x, px.y - d.px0.y) <= 3) return;
      const p = this.points[d.index];
      // Shift keeps the point on the horizontal or vertical line through where the drag started.
      const lock = e.shiftKey && d.p0 ? (Math.abs(mm.x - d.p0.x) >= Math.abs(mm.y - d.p0.y) ? 'y' : 'x') : null;
      const s = this._snapPoint(lock === 'y' ? { x: mm.x, y: d.p0.y } : lock === 'x' ? { x: d.p0.x, y: mm.y } : mm);
      if (lock === 'y') s.y = d.p0.y; else if (lock === 'x') s.x = d.p0.x;   // the snap may not break the lock
      this._guard(() => { const q = this.points[d.index]; q.x = s.x; q.y = s.y; }, BLOCK_MSG);
      d.moved = true; this._changed();
    } else if (d.kind === 'pen') {
      // A corner has just been placed — on the canvas or on the outline itself. It stays where
      // it was put; the drag pulls its handles out of it. They are kept exactly opposite and the
      // same length, so the outline runs smoothly through the corner — Sync handles on, which is
      // what the point bar will show.
      if (!d.pulled && Math.hypot(e.clientX - d.c0.x, e.clientY - d.c0.y) <= PEN_PULL) return;
      d.pulled = true;
      const p = this.points[d.index];
      const s = this._snapPoint(mm, { axis: false, guides: false, clamp: false });
      let h = { x: s.x - p.x, y: s.y - p.y };
      if (e.shiftKey) h = snapAngle45(h);   // Shift: horizontal, vertical or diagonal
      this._guard(() => {
        const q = this.points[d.index];
        q.out = h; q.in = { x: -h.x, y: -h.y }; q.smooth = true;
      }, BLOCK_MSG);
      this._changed();
    } else if (d.kind === 'handle') {
      const p = this.points[d.index];
      const s = this._snapPoint(mm, { axis: false, guides: false, clamp: false });
      let h = { x: s.x - p.x, y: s.y - p.y };
      if (e.shiftKey) h = snapAngle45(h);   // Shift: horizontal, vertical or diagonal
      this._guard(() => { const q = this.points[d.index]; q[d.which] = h; this._mirrorHandle(q, d.which); }, BLOCK_MSG);
      this._changed();
    } else if (d.kind === 'move') {
      let dx = mm.x - d.p0.x, dy = mm.y - d.p0.y;
      // Shift keeps the shape on one line through where the drag started: whichever way it has
      // travelled further is the way it may go, and the other stays where it was.
      const lock = e.shiftKey ? (Math.abs(dx) >= Math.abs(dy) ? 'y' : 'x') : null;
      if (lock === 'y') dy = 0; else if (lock === 'x') dx = 0;
      const b = d.b0;
      const adj = this._snapBox({ minX: b.minX + dx, maxX: b.maxX + dx, cx: b.cx + dx, minY: b.minY + dy, maxY: b.maxY + dy, cy: b.cy + dy });
      if (lock !== 'x') dx += adj.dx;   // the snap may not break the lock
      if (lock !== 'y') dy += adj.dy;
      // The undo step is taken the moment the shape actually travels, not when the button goes
      // down: a press is also how a shape is picked up, and picking one up changes nothing.
      // The drawing is still untouched here, so the snapshot is of where the drag started.
      if ((dx || dy) && !d.rec) { d.rec = true; this._record(); }
      this._applyTransform(d.start, p => ({ x: p.x + dx, y: p.y + dy })); this._changed();
    } else if (d.kind === 'rotate') {
      const c = this.toPx({ x: d.c.cx, y: d.c.cy });
      let ang = Math.atan2(px.y - c.y, px.x - c.x) - d.a0;
      const snap = Math.PI / 12;
      const snapped = Math.round(ang / snap) * snap;
      if (Math.abs(snapped - ang) < 0.05 || e.shiftKey) ang = snapped;
      const cos = Math.cos(ang), sin = Math.sin(ang);
      this._applyTransform(d.start, p => {
        const x = p.x - d.c.cx, y = p.y - d.c.cy;
        return { x: d.c.cx + x * cos - y * sin, y: d.c.cy + x * sin + y * cos };
      });
      this._changed();
    } else if (d.kind === 'scale') {
      const { h, b } = d;
      const s = this._snapPoint(mm, { axis: false });
      // Alt / Option anchors the resize on the middle of the shape as it was when the drag
      // started, instead of on the corner or edge opposite the handle: every side moves and
      // the shape stays where it is. A mirrored axis is left alone — there the box is only the
      // editable half, so its middle means nothing, and the anchor is already the mirror line,
      // which is what growing both ways from the middle means for a symmetric shape.
      const midX = e.altKey && !this.sym.x, midY = e.altKey && !this.sym.y;
      const ax = h.ax === 0 ? null : midX ? b.cx : h.ax === 1 ? b.maxX : b.minX;
      const ay = h.ay === 0 ? null : midY ? b.cy : h.ay === 1 ? b.maxY : b.minY;
      let sx = 1, sy = 1;
      if (ax !== null) sx = (s.x - ax) / (d.p0.x - ax);
      if (ay !== null) sy = (s.y - ay) / (d.p0.y - ay);
      const corner = ax !== null && ay !== null;
      if (corner && (this.lockAspect !== e.shiftKey)) { const v = Math.abs(sx) > Math.abs(sy) ? sx : sy; sx = v; sy = v; }
      if (!isFinite(sx) || !isFinite(sy)) return;
      sx = Math.max(0.05, Math.abs(sx)); sy = Math.max(0.05, Math.abs(sy));
      const ox = ax ?? b.cx, oy = ay ?? b.cy;
      this._applyTransform(d.start, p => ({ x: ox + (p.x - ox) * sx, y: oy + (p.y - oy) * sy }));
      this._changed();
    }
  }

  _up(e) {
    this._cancelPress();
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.delete(e.pointerId);
    try { this.canvas.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    const px = this._eventPos(e);

    if (this.viewGesture) {
      if (this.pointers.size < 2) { this.viewGesture = null; this.dirty = true; }
      return;
    }
    if (this.gesture) {
      if (this.pointers.size < 2) { this.gesture = null; this._autoFit(); this._changed(); }
      return;
    }
    if (this.stroke) {
      const raw = this.stroke; this.stroke = null;
      if (raw.length < 8) { this.dirty = true; return; }
      const poly = this.finalizeSketch(raw);
      if (!poly) { this.dirty = true; return; }
      // A stroke belongs where it was drawn, so one that runs into another shape is refused
      // rather than shuffled aside — moving a sketch away from the pen is the worse surprise.
      if (this.active === 'outer' && this._blocked(this._effectiveIn(this.layer, poly))) {
        this._blockNote('That runs into another shape — draw it clear of the others.');
        this.dirty = true; return;
      }
      // Only a drawing that stands alone is dropped in the middle of the canvas; with other
      // shapes about, where you drew it is where it stays.
      const alone = this.layers.every((l, i) => i === this.index || this._displayOf(l).outer.length < 3);
      this.setPoints(poly, { record: true, place: false, center: alone && this.active === 'outer' && !this.symOn && !this.hasInner });
      return;
    }
    if (this.drag) {
      const d = this.drag; this.drag = null;
      if (d.kind === 'pan') {
        this._setCursor(this._defaultCursor());
        if (!d.moved && d.menuIndex >= 0) this._openMenu(d.menuIndex, d.ev);
        this.dirty = true; return;
      }
      if (d.kind === 'guide') { this._hoverAt(px); this.dirty = true; return; }
      if (d.kind === 'vertex' && !d.moved) {
        this.undoStack.pop();
        // A press on the first point that never became a drag is the click that closes the outline.
        if (d.closes) { this.closeContour(); this._hoverAt(px); return; }
      }
      // A press that never moved the shape: it picked it up and nothing else, so there is
      // nothing to fit, to build or to report.
      if (d.kind === 'move' && !d.rec) { this._hoverAt(px); this.dirty = true; return; }
      this._hoverAt(px);
      if (d.kind !== 'vertex' && d.kind !== 'handle' && d.kind !== 'pen') this._autoFit();
      this._changed();
    }
  }

  // ----- rendering -----

  _loop() {
    // The first point of an outline that can be closed pulses — the only thing on this canvas
    // that moves on its own, so it is also the only reason to keep painting without an edit.
    if (this._closable()) this.dirty = true;
    if (this.dirty) { this.dirty = false; this._render(); }
    requestAnimationFrame(() => this._loop());
  }

  // Is the outline being placed far enough along to be closed? That is when its first point
  // becomes the button that finishes the shape.
  _closable(k = this.active) {
    return this.tool === 'points' && !!this.open[k] && this.shape[k].length >= 3;
  }

  _render() {
    const ctx = this.ctx, C = this.colors;
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.fillStyle = C.paper; ctx.fillRect(0, 0, this.w, this.h);

    this._renderGrid();
    // The mirror side is shaded before anything is drawn on it: it says where this shape may not
    // go, and a shape that is standing there — or is being mirrored across it — still has to read.
    this._renderSymmetryShade();

    // The shapes you are not editing stay on the canvas — you are laying out a plate, not one
    // cutter — but greyed back, because only one of them can be picked up.
    for (let i = 0; i < this.layers.length; i++) if (i !== this.index) this._renderOther(this.layers[i], i === this.hot);

    const disp = this._display();
    const rings = disp.outer.length >= 3 ? this._ringsFor(this.layer) : null;
    if (rings) {
      const band = (outerRing, innerRing, fill) => {
        if (!outerRing || !innerRing) return;
        ctx.beginPath(); this._path(outerRing); this._path(innerRing);
        ctx.fillStyle = fill; ctx.fill('evenodd');
      };
      // With both walls drawn they would look identical, so the one you are not editing
      // is faded back and the active one keeps full contrast.
      const bothWalls = disp.inner.length >= 3;
      ctx.globalAlpha = bothWalls && this.active !== 'outer' ? DIM_ALPHA : 1;
      band(rings.base, disp.outer, C.base);
      band(rings.ridge, disp.outer, C.base);
      band(rings.blade, disp.outer, C.blade);
      if (bothWalls) {
        ctx.globalAlpha = this.active !== 'inner' ? DIM_ALPHA : 1;
        band(disp.inner, rings.innerBase, C.base);
        band(disp.inner, rings.innerRidge, C.base);
        band(disp.inner, rings.innerBlade, C.blade);
      }
      ctx.globalAlpha = 1;
    }

    // Only fade a wall once the other one exists — a lone wall is always the subject.
    const dimmed = (k) => this.active !== k && disp.outer.length >= 2 && disp.inner.length >= 2;
    const strokeFor = (k) => dimmed(k) ? C.dimLine : C.doughLine;
    const widthFor = (k) => dimmed(k) ? 1 : 1.5;
    if (disp.outer.length >= 2) {
      ctx.beginPath(); this._path(disp.outer);
      if (disp.inner.length >= 3) this._path(disp.inner);
      if (disp.outer.length >= 3) { ctx.fillStyle = C.dough; ctx.fill('evenodd'); }
      ctx.beginPath(); this._path(disp.outer);
      ctx.lineWidth = widthFor('outer'); ctx.strokeStyle = strokeFor('outer');
      ctx.setLineDash(this.tool === 'points' && disp.outer.length < 3 ? [4, 4] : []); ctx.stroke(); ctx.setLineDash([]);
    }
    if (disp.inner.length >= 2) {
      ctx.beginPath(); this._path(disp.inner);
      ctx.lineWidth = widthFor('inner'); ctx.strokeStyle = strokeFor('inner');
      ctx.setLineDash(this.tool === 'points' && disp.inner.length < 3 ? [4, 4] : []); ctx.stroke(); ctx.setLineDash([]);
    }
    if (rings && rings.bridges && rings.bridges.length) {
      ctx.beginPath(); for (const b of rings.bridges) this._path(b);
      ctx.fillStyle = 'rgba(145,132,217,0.16)'; ctx.fill();
      ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(181,171,252,0.55)'; ctx.setLineDash([3, 3]); ctx.stroke(); ctx.setLineDash([]);
    }

    if (this.stroke && this.stroke.length > 1) {
      ctx.beginPath();
      const p0 = this.toPx(this.stroke[0]); ctx.moveTo(p0.x, p0.y);
      for (const p of this.stroke) { const q = this.toPx(p); ctx.lineTo(q.x, q.y); }
      ctx.lineWidth = 2.5; ctx.strokeStyle = C.accent; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.stroke();
    }

    // in symmetry mode also show the raw edited half of the active contour
    if (this.symOn && this.tool === 'points' && this.points.length >= 2) {
      const seg = flatten(this.points, false);
      ctx.beginPath();
      const p0 = this.toPx(seg[0]); ctx.moveTo(p0.x, p0.y);
      for (const p of seg) { const q = this.toPx(p); ctx.lineTo(q.x, q.y); }
      ctx.lineWidth = 1; ctx.strokeStyle = C.accent; ctx.setLineDash([3, 3]); ctx.stroke(); ctx.setLineDash([]);
    }
    this._renderDraft();
    this._renderSymmetry();
    this._renderGuides();
    if (this.tool === 'points') this._renderVertices();
    if (this.tool === 'move') this._renderBox();
    if (disp.outer.length >= 3) this._renderDims(disp.outer);
  }

  // An outline still being placed: its corners joined by a dashed line and nothing else — no
  // fill and no wall bands, because there is no cutter here until it is closed.
  _renderDraft() {
    for (const k of ['outer', 'inner']) {
      if (!this.open[k] || this.shape[k].length < 2) continue;
      this._polyline(flatten(this.shape[k], false), this.colors.doughLine, 1.5);
    }
  }

  _polyline(pts, stroke, width) {
    const ctx = this.ctx;
    ctx.beginPath();
    const p0 = this.toPx(pts[0]); ctx.moveTo(p0.x, p0.y);
    for (let i = 1; i < pts.length; i++) { const q = this.toPx(pts[i]); ctx.lineTo(q.x, q.y); }
    ctx.lineWidth = width; ctx.strokeStyle = stroke; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.setLineDash([5, 4]); ctx.stroke(); ctx.setLineDash([]);
  }

  // A layer that is not being edited: the same picture in grey, faint enough to read as
  // background, with its base band left in so you can see how close it is to the one you
  // are moving — which is what decides whether the move is allowed at all.
  _renderOther(layer, hot = false) {
    const disp = this._displayOf(layer);
    const ctx = this.ctx, C = this.colors;
    // Under the pointer it comes a step forward: this is the shape a click would pick up, and
    // seeing which one that is before pressing is the whole point of the lift.
    const line = hot ? C.hotLine : C.otherLine, fill = hot ? C.hotFill : C.otherFill;
    const baseFill = hot ? C.hotBase : C.otherBase, bladeFill = hot ? C.hotBlade : C.otherBlade;
    // An outline someone started and has not closed is still theirs: it stays on the canvas,
    // greyed back like the rest of the shape, instead of vanishing when you step away from it.
    for (const k of ['outer', 'inner']) {
      if (layer.open[k] && layer.shape[k].length >= 2) this._polyline(flatten(layer.shape[k], false), line, 1);
    }
    if (disp.outer.length < 3) return;
    const rings = this._ringsFor(layer);
    const hasInner = disp.inner.length >= 3;
    const band = (a, b, fill) => {
      if (!a || !b) return;
      ctx.beginPath(); this._path(a); this._path(b);
      ctx.fillStyle = fill; ctx.fill('evenodd');
    };
    ctx.beginPath(); this._path(disp.outer); if (hasInner) this._path(disp.inner);
    ctx.fillStyle = fill; ctx.fill('evenodd');
    if (rings) {
      band(rings.base, disp.outer, baseFill);
      band(rings.blade, disp.outer, bladeFill);
      if (hasInner) {
        band(disp.inner, rings.innerBase, baseFill);
        band(disp.inner, rings.innerBlade, bladeFill);
      }
      if (rings.bridges && rings.bridges.length) {
        ctx.beginPath(); for (const g of rings.bridges) this._path(g);
        ctx.fillStyle = baseFill; ctx.fill();
      }
    }
    ctx.lineWidth = hot ? 1.5 : 1; ctx.strokeStyle = line; ctx.lineJoin = 'round';
    ctx.beginPath(); this._path(disp.outer); ctx.stroke();
    if (hasInner) { ctx.beginPath(); this._path(disp.inner); ctx.stroke(); }
  }

  // The scale bar that used to be painted here now lives in the grid control at the canvas'
  // bottom left, so it can sit next to the grid size and snap toggle.
  get gridBar() {
    const s = this.scale;
    let px = this.grid.size * s, mm = this.grid.size;
    if (px < 6) { px *= 5; mm *= 5; }
    return { px, mm };
  }

  _renderGrid() {
    const ctx = this.ctx, C = this.colors, s = this.scale;
    let step = this.grid.size * s, every = 5;
    if (step < 6) { step *= 5; every = 2; }
    const origin = this.toPx({ x: 0, y: 0 });
    const ox = origin.x, oy = origin.y;
    ctx.lineWidth = 1;
    for (let k = Math.floor(-ox / step); k <= Math.ceil((this.w - ox) / step); k++) {
      const x = ox + k * step;
      ctx.strokeStyle = k % every === 0 ? C.gridMajor : C.grid;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, this.h); ctx.stroke();
    }
    for (let k = Math.floor(-oy / step); k <= Math.ceil((this.h - oy) / step); k++) {
      const y = oy + k * step;
      ctx.strokeStyle = k % every === 0 ? C.gridMajor : C.grid;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(this.w, y); ctx.stroke();
    }
  }

  _renderSymmetryShade() {
    if (!this.symOn) return;
    const ctx = this.ctx, C = this.colors;
    const o = this.toPx(this.symOrigin);
    ctx.fillStyle = C.inactive;
    if (this.sym.x) ctx.fillRect(0, 0, o.x, this.h);
    if (this.sym.y) ctx.fillRect(this.sym.x ? o.x : 0, o.y, this.w, this.h - o.y);
  }

  _renderSymmetry() {
    if (!this.symOn) return;
    const ctx = this.ctx, C = this.colors;
    const o = this.toPx(this.symOrigin);
    ctx.strokeStyle = C.accent; ctx.lineWidth = 1.5; ctx.setLineDash([10, 6]);
    if (this.sym.x) { ctx.beginPath(); ctx.moveTo(o.x, 0); ctx.lineTo(o.x, this.h); ctx.stroke(); }
    if (this.sym.y) { ctx.beginPath(); ctx.moveTo(0, o.y); ctx.lineTo(this.w, o.y); ctx.stroke(); }
    ctx.setLineDash([]);
    ctx.fillStyle = C.accent; ctx.font = '600 11px system-ui, sans-serif'; ctx.textBaseline = 'top'; ctx.textAlign = 'start';
    if (this.sym.x) ctx.fillText('mirror', o.x + 6, this.h - 34);
    if (this.sym.y) ctx.fillText('mirror', this.w - 46, o.y + 4);
  }

  _renderGuides() {
    const ctx = this.ctx, C = this.colors;
    for (const g of this.guides) {
      ctx.strokeStyle = C.guide; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
      ctx.fillStyle = C.guide; ctx.font = '600 11px system-ui, sans-serif';
      if (g.axis === 'v') {
        const x = this.toPx({ x: g.pos, y: 0 }).x;
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, this.h); ctx.stroke(); ctx.setLineDash([]);
        ctx.beginPath(); ctx.roundRect(x - 22, 4, 44, 20, 5); ctx.fill();
        ctx.fillStyle = C.paper; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(`${g.pos}`, x, 14);
      } else {
        const y = this.toPx({ x: 0, y: g.pos }).y;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(this.w, y); ctx.stroke(); ctx.setLineDash([]);
        ctx.beginPath(); ctx.roundRect(4, y - 10, 40, 20, 5); ctx.fill();
        ctx.fillStyle = C.paper; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(`${g.pos}`, 24, y);
      }
      ctx.textAlign = 'start';
    }
  }

  _path(pts) {
    const ctx = this.ctx;
    const p0 = this.toPx(pts[0]); ctx.moveTo(p0.x, p0.y);
    for (let i = 1; i < pts.length; i++) { const q = this.toPx(pts[i]); ctx.lineTo(q.x, q.y); }
    ctx.closePath();
  }

  _renderVertices() {
    const ctx = this.ctx, C = this.colors;
    // Bézier handles of the selected point
    const sp = this.selectedPoint;
    if (sp && (sp.in || sp.out)) {
      const a = this.toPx(sp);
      for (const which of ['in', 'out']) {
        if (!sp[which]) continue;
        const h = this.toPx({ x: sp.x + sp[which].x, y: sp.y + sp[which].y });
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(h.x, h.y);
        ctx.lineWidth = 1.5; ctx.strokeStyle = C.handle; ctx.stroke();
        // A small diamond: the corners are squares and the curved ones circles, so a handle
        // needs a shape of its own — and it is the smallest of the three, because it is the
        // thing you nudge rather than the thing the outline runs through.
        ctx.beginPath();
        ctx.moveTo(h.x, h.y - HANDLE_TIP); ctx.lineTo(h.x + HANDLE_TIP, h.y);
        ctx.lineTo(h.x, h.y + HANDLE_TIP); ctx.lineTo(h.x - HANDLE_TIP, h.y);
        ctx.closePath();
        ctx.fillStyle = C.paper; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = C.handle; ctx.lineJoin = 'miter'; ctx.stroke();
      }
    }
    const closable = this._closable();
    this.points.forEach((p, i) => {
      if (!this.inRegion(p)) return;
      const q = this.toPx(p);
      const sel = i === this.selected, curved = !!(p.in || p.out);
      // The point that closes the outline: a ring pulsing out of it, so the one thing you are
      // being asked to press is the one thing on the canvas that moves.
      const closer = closable && i === 0;
      if (closer) {
        const t = (performance.now() % 1500) / 1500;
        ctx.save();
        ctx.globalAlpha = 1 - t;
        ctx.beginPath(); ctx.arc(q.x, q.y, HANDLE_R + 2 + t * 11, 0, Math.PI * 2);
        ctx.lineWidth = 2; ctx.strokeStyle = C.accent; ctx.stroke();
        ctx.restore();
      }
      ctx.beginPath();
      if (curved) ctx.arc(q.x, q.y, sel ? HANDLE_R : HANDLE_R - 2, 0, Math.PI * 2);
      else { const r = sel || closer ? HANDLE_R - 1 : HANDLE_R - 3; ctx.rect(q.x - r, q.y - r, 2 * r, 2 * r); }
      ctx.fillStyle = sel || closer ? C.accent : i === 0 ? C.accentSoft : C.paper; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = C.accent; ctx.stroke();
    });
  }

  _renderBox() {
    const hb = this._bboxHandles(); if (!hb) return;
    const ctx = this.ctx, C = this.colors;
    ctx.setLineDash([6, 4]); ctx.lineWidth = 1.2; ctx.strokeStyle = C.accent;
    ctx.strokeRect(hb.tl.x, hb.tl.y, hb.br.x - hb.tl.x, hb.br.y - hb.tl.y);
    ctx.setLineDash([]);
    if (hb.rot) {
      ctx.beginPath(); ctx.moveTo(hb.rot.x, hb.tl.y); ctx.lineTo(hb.rot.x, hb.rot.y); ctx.stroke();
      ctx.beginPath(); ctx.arc(hb.rot.x, hb.rot.y, HANDLE_R, 0, Math.PI * 2);
      ctx.fillStyle = C.accent; ctx.fill();
      ctx.strokeStyle = C.paper; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(hb.rot.x, hb.rot.y, 4.5, -Math.PI * 0.2, Math.PI * 1.4); ctx.stroke();
    }
    for (const h of hb.handles) {
      const corner = h.ax !== 0 && h.ay !== 0;
      const r = corner ? HANDLE_R : HANDLE_R - 2;
      ctx.fillStyle = C.paper; ctx.strokeStyle = C.accent; ctx.lineWidth = 2;
      if (corner) { ctx.beginPath(); ctx.rect(h.x - r, h.y - r, 2 * r, 2 * r); ctx.fill(); ctx.stroke(); }
      else { ctx.beginPath(); ctx.arc(h.x, h.y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
    }
  }

  _renderDims(outer) {
    const ctx = this.ctx, C = this.colors;
    const b = bounds(outer);
    const br = this.toPx({ x: b.maxX, y: b.maxY });
    const text = `${b.width.toFixed(1)} × ${b.height.toFixed(1)} mm`;
    ctx.font = '600 13px system-ui, sans-serif'; ctx.textBaseline = 'top'; ctx.textAlign = 'start';
    const tw = ctx.measureText(text).width;
    let x = br.x - tw, y = br.y + 14;
    if (this.tool === 'move') y += 12;
    x = Math.max(8, Math.min(this.w - tw - 8, x)); y = Math.min(this.h - 30, y);
    ctx.fillStyle = 'rgba(35,37,50,0.9)'; ctx.fillRect(x - 6, y - 3, tw + 12, 20);
    ctx.fillStyle = C.ink; ctx.fillText(text, x, y);
  }
}
