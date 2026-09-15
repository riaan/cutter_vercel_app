// 2D shape editor on a <canvas>. Works with mouse, pen and touch (pointer events).
// All coordinates are millimetres with y pointing down (screen convention).
// The shape has an outer contour and an optional inner contour (a hole in the cut piece).
// Contour points may carry Bézier handles: { x, y, in?: {x,y}, out?: {x,y}, smooth? }
// where in/out are offsets from the anchor.

import { simplify, chaikin, cleanPolygon, bounds, signedArea, symmetrize, clipToRegion, roundCorners } from './geometry.js';

const HANDLE_R = 9;    // drawn radius (css px)
const HIT_R = 20;      // touch-friendly hit radius (css px)
const SNAP_PX = 10;    // magnet distance for guides, mirror lines and grid (css px)
const ROT_STEM = 34;   // distance of the rotation handle above the box
const LONG_PRESS = 550; // ms, opens the point menu on touch
const DIM_ALPHA = 0.4;  // how far the wall you are not editing fades back
const MIN_ZOOM = 0.25; // 25 % — any further out and the grid stops being readable
const MAX_ZOOM = 8;    // 800 % — enough to place a point on a 0.1 mm feature
const ZOOM_STEP = 1.25; // one press of zoom in / out

const ROTATE_CURSOR = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'%3E%3Cpath d='M12 4a8 8 0 1 1-7.5 5' fill='none' stroke='white' stroke-width='4.5' stroke-linecap='round'/%3E%3Cpath d='M12 4a8 8 0 1 1-7.5 5' fill='none' stroke='%2314202B' stroke-width='2' stroke-linecap='round'/%3E%3Cpath d='M3 4.5v5h5' fill='none' stroke='white' stroke-width='4.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3Cpath d='M3 4.5v5h5' fill='none' stroke='%2314202B' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") 12 12, auto`;

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
function mapPts(pts, f) {
  return pts.map(p => {
    const q = f(p), r = { x: q.x, y: q.y };
    if (p.in) { const a = f({ x: p.x + p.in.x, y: p.y + p.in.y }); r.in = { x: a.x - q.x, y: a.y - q.y }; }
    if (p.out) { const a = f({ x: p.x + p.out.x, y: p.y + p.out.y }); r.out = { x: a.x - q.x, y: a.y - q.y }; }
    if (p.smooth !== undefined) r.smooth = p.smooth;
    return r;
  });
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

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

export class ShapeEditor {
  constructor(canvas, { onChange = () => {}, onGuides = () => {}, onSelect = () => {}, onMenu = () => {}, onView = () => {}, rings = () => null, colors = {} } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onChange = onChange;
    this.onGuides = onGuides;
    this.onSelect = onSelect;
    this.onMenu = onMenu;
    this.onView = onView;
    this.ringsProvider = rings;
    this.colors = Object.assign({
      grid: '#232532', gridMajor: '#2E3140', ink: '#E9E9ED', muted: '#9397AB',
      dough: 'rgba(145,132,217,0.10)', doughLine: '#9184D9', base: 'rgba(233,233,237,0.06)', blade: '#9184D9',
      accent: '#9184D9', accentSoft: 'rgba(145,132,217,0.18)', paper: '#161826',
      inactive: 'rgba(22,24,38,0.55)', guide: '#B5ABFC', handle: '#B5ABFC',
      dimLine: 'rgba(145,132,217,0.38)',   // the wall you are not editing

    }, colors);

    this.shape = { outer: [], inner: [] };
    this.active = 'outer';
    this.tool = 'draw';
    this.smoothing = 0.4;
    this.lockAspect = true;
    this.sym = { x: false, y: false };
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
    this._displayCache = { key: null };
    this.version = 0;
    this.selected = -1;
    this._pressTimer = null;

    this._bind();
    this._resize();
    this.ro = new ResizeObserver(() => { this._resize(); this.requestRender(); });
    this.ro.observe(canvas);
    this._loop();
  }

  // ---------- public API ----------

  setTool(tool) { this.tool = tool; this.stroke = null; this.drag = null; this._select(-1); this._setCursor(this._defaultCursor()); this.requestRender(); }
  setActive(which) { this.active = which; this.stroke = null; this.drag = null; this._select(-1); this.requestRender(); }

  // ----- view (zoom / pan) -----
  // Zoom is a multiplier on the auto-fitted size, so 100 % always means "the whole shape fits".
  getZoom() { return this.view.zoom; }
  get zoomLimits() { return { min: MIN_ZOOM, max: MAX_ZOOM }; }

  // The middle of the drawing, which is what zoom centres on. Falls back to the origin
  // while there is nothing drawn yet.
  _shapeCenter() {
    const o = this._display().outer;
    if (o.length < 2) return { x: 0, y: 0 };
    const b = bounds(o);
    return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
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
  get hasInner() { return this.shape.inner.length >= 3; }
  get hasOuter() { return this.shape.outer.length >= 3; }

  setShape(shape, { record = true, center = false, fit = true } = {}) {
    if (record) this._record();
    this.shape = { outer: copy(shape.outer || []), inner: copy(shape.inner || []) };
    if (this.symOn) this._toSeeds();
    if (center && this.shape.outer.length) this._centerShape();
    this._select(-1);
    if (fit) this._autoFit();
    this._changed();
  }

  // Replace the active contour only.
  setPoints(pts, opts = {}) {
    const s = copyShape(this.shape);
    s[this.active] = pts || [];
    if (this.active === 'outer' && opts.dropInner) s.inner = [];
    this.setShape(s, opts);
  }

  clear() {
    if (this.active === 'outer') { if (!this.shape.outer.length && !this.shape.inner.length) return; this.setShape({ outer: [], inner: [] }); }
    else { if (!this.shape.inner.length) return; this.setPoints([]); }
  }

  undo() {
    if (!this.undoStack.length) return;
    this.redoStack.push(copyShape(this.shape));
    this.shape = this.undoStack.pop();
    this._select(-1); this._autoFit(); this._changed();
  }

  redo() {
    if (!this.redoStack.length) return;
    this.undoStack.push(copyShape(this.shape));
    this.shape = this.redoStack.pop();
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
    if (this.shape.outer.length < 3) return;
    const b = bounds(this._display().outer);
    let sx = width ? width / b.width : null;
    let sy = height ? height / b.height : null;
    if (this.lockAspect) { const s = sx ?? sy; sx = s; sy = s; }
    sx = sx ?? 1; sy = sy ?? 1;
    if (!isFinite(sx) || !isFinite(sy) || sx <= 0 || sy <= 0) return;
    if (record) this._record();
    const f = p => ({ x: b.cx + (p.x - b.cx) * sx, y: b.cy + (p.y - b.cy) * sy });
    this.shape = { outer: mapPts(this.shape.outer, f), inner: mapPts(this.shape.inner, f) };
    this._autoFit(); this._changed();
  }

  center() {
    if (!this.shape.outer.length) return;
    this._record(); this._centerShape(); this._changed();
  }

  // Flipping follows the wall you are editing: the outer wall carries the inner one with it,
  // the inner wall flips on its own inside the shape.
  flip(axis) {
    const keys = this._affected();
    if (this._display()[this.active].length < 3) return;
    if ((axis === 'x' && this.sym.x) || (axis === 'y' && this.sym.y)) return; // already symmetric that way
    this._record();
    const b = bounds(this._display()[this.active]);
    const f = p => axis === 'x' ? { x: 2 * b.cx - p.x, y: p.y } : { x: p.x, y: 2 * b.cy - p.y };
    const fix = (pts) => {
      let r = mapPts(pts, f);
      if (!this.symOn && r.length >= 3 && signedArea(r) < 0) r = this._reverse(r);
      if (this.symOn) r = this._reverse(r); // keep the seed's start/end on the mirror line
      return r;
    };
    for (const k of keys) this.shape[k] = fix(this.shape[k]);
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

  // Round the corners of the active contour (works on imports and point-drawn shapes too).
  roundCorners() {
    const pts = flatten(this.points, !this.symOn);
    if (pts.length < 3) return;
    this._record();
    const passes = this.smoothing < 0.35 ? 1 : this.smoothing < 0.7 ? 2 : 3;
    if (this.symOn) this.points = roundCorners(pts, passes, false);
    else this.points = cleanPolygon(roundCorners(pts, passes, true), 0.002) || pts;
    this._select(-1);
    this._changed();
  }

  // Switching symmetry: bake the current full shape, then keep only the editable part as the seed.
  setSymmetry(sym) {
    const next = { x: !!sym.x, y: !!sym.y };
    if (next.x === this.sym.x && next.y === this.sym.y) return;
    if (this.shape.outer.length >= 3) this._record();
    const full = this._display();
    this.shape = copyShape(full);
    this.sym = next;
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
    const min = this.symOn ? 2 : 3;
    if (this.points.length <= min) return;
    this._record();
    this.points.splice(i, 1);
    this._select(-1);
    this._changed();
  }

  // mode: 'add' (curve handles from the neighbours), 'reset' (same, recomputed), 'remove'
  setCurve(i = this.selected, mode = 'add') {
    const pts = this.points;
    if (i < 0 || i >= pts.length) return;
    this._record();
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
    this._changed();
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

  _select(i) {
    if (i === this.selected) return;
    this.selected = i;
    this.onSelect(i >= 0 ? { index: i, point: this.points[i] } : null);
    this.dirty = true;
  }

  _record() {
    this.undoStack.push(copyShape(this.shape));
    if (this.undoStack.length > 60) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  _changed() {
    this.version++; this.dirty = true;
    if (this.selected >= this.points.length) this._select(-1);
    else if (this.selected >= 0) this.onSelect({ index: this.selected, point: this.points[this.selected] });
    this.onChange(this.getShape());
  }

  // Reverse a contour, swapping in/out handles.
  _reverse(pts) {
    return pts.slice().reverse().map(p => { const q = copyPt(p); const t = q.in; q.in = q.out; q.out = t; if (!q.in) delete q.in; if (!q.out) delete q.out; return q; });
  }

  _centerShape() {
    const b = bounds(this._display().outer);
    const f = p => ({ x: p.x - b.cx, y: p.y - b.cy });
    this.shape = { outer: mapPts(this.shape.outer, f), inner: mapPts(this.shape.inner, f) };
  }

  // Reduce full contours to their editable part (seed) for symmetry mode.
  _toSeeds() {
    for (const k of ['outer', 'inner']) {
      if (this.shape[k].length < 3) continue;
      this.shape[k] = clipToRegion(flatten(this.shape[k]), this.sym) || [];
    }
  }

  // Close an open half along the mirror lines: last point → axis → (origin) → axis → first point.
  _closeViaAxes(pts) {
    const proj = (p) => {
      if (this.sym.x && this.sym.y) return p.x < -p.y ? { x: 0, y: p.y } : { x: p.x, y: 0 };
      return this.sym.x ? { x: 0, y: p.y } : { x: p.x, y: 0 };
    };
    const first = pts[0], last = pts[pts.length - 1];
    const detour = [proj(last)];
    if (this.sym.x && this.sym.y) detour.push({ x: 0, y: 0 });
    detour.push(proj(first));
    return pts.concat(detour);
  }

  // The full contour for a seed: curves flattened, closed along the mirror lines, cleaned and mirrored.
  _effective(pts) {
    if (!this.symOn) return flatten(pts, true);
    if (pts.length < 2) return [];
    return symmetrize(this._closeViaAxes(flatten(pts, false)), this.sym) || [];
  }

  // What is drawn and exported: the effective version of each contour (cached per edit).
  _display() {
    const c = this._displayCache;
    const key = `${this.version}|${this.sym.x}|${this.sym.y}`;
    if (c.key === key && c.outerRef === this.shape.outer && c.innerRef === this.shape.inner) return c.shape;
    const s = { outer: this._effective(this.shape.outer), inner: this._effective(this.shape.inner) };
    this._displayCache = { key, shape: s, outerRef: this.shape.outer, innerRef: this.shape.inner };
    return s;
  }

  _autoFit() {
    // Once the view has been zoomed or panned by hand it belongs to the user; re-fitting
    // under them would move the drawing out from under the cursor.
    if (this.view.manual) return;
    const o = this._display().outer;
    if (o.length < 3) { this.view.size = 160; return; }
    const b = bounds(o);
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
    c.addEventListener('pointerleave', () => { if (!this.drag && !this.stroke) this._setCursor(this._defaultCursor()); });
    c.addEventListener('wheel', (e) => {
      // Zoom towards the cursor. preventDefault stops the page scrolling under the canvas.
      e.preventDefault();
      this.zoomBy(Math.exp(-e.deltaY * 0.0015), this._eventPos(e));
    }, { passive: false });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  _setCursor(c) { if (this.canvas.style.cursor !== c) this.canvas.style.cursor = c; }

  // ----- snapping -----

  inRegion(p) { return (!this.sym.x || p.x >= -1e-9) && (!this.sym.y || p.y <= 1e-9); }

  _clamp(p) {
    return { x: this.sym.x ? Math.max(0, p.x) : p.x, y: this.sym.y ? Math.min(0, p.y) : p.y };
  }

  _snapPoint(p, { grid = true, axis = true, guides = true } = {}) {
    const t = this.snapMm;
    let x = p.x, y = p.y, sx = false, sy = false;
    if (guides) for (const g of this.guides) {
      if (g.axis === 'v' && !sx && Math.abs(x - g.pos) < t) { x = g.pos; sx = true; }
      if (g.axis === 'h' && !sy && Math.abs(y - g.pos) < t) { y = g.pos; sy = true; }
    }
    if (axis) {
      if (this.sym.x && !sx && Math.abs(x) < t) { x = 0; sx = true; }
      if (this.sym.y && !sy && Math.abs(y) < t) { y = 0; sy = true; }
    }
    if (grid && this.grid.snap) {
      const g = this.grid.size;
      if (!sx) x = Math.round(x / g) * g;
      if (!sy) y = Math.round(y / g) * g;
    }
    return this._clamp({ x, y });
  }

  _snapBox(b) {
    const t = this.snapMm;
    const targetsX = this.guides.filter(g => g.axis === 'v').map(g => g.pos);
    const targetsY = this.guides.filter(g => g.axis === 'h').map(g => g.pos);
    if (this.sym.x) targetsX.push(0);
    if (this.sym.y) targetsY.push(0);
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
    if (this.sym.x) b.minX = Math.max(b.minX, 0);
    if (this.sym.y) b.maxY = Math.min(b.maxY, 0);
    b.width = b.maxX - b.minX; b.height = b.maxY - b.minY; b.cx = (b.minX + b.maxX) / 2; b.cy = (b.minY + b.maxY) / 2;
    return b;
  }

  _bboxHandles() {
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
    const pts = this._display()[this.active]; let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const pi = pts[i], pj = pts[j];
      if ((pi.y > mm.y) !== (pj.y > mm.y) && mm.x < (pj.x - pi.x) * (mm.y - pi.y) / (pj.y - pi.y) + pi.x) inside = !inside;
    }
    return inside;
  }

  _affected() { return this.active === 'outer' ? ['outer', 'inner'] : ['inner']; }
  _applyTransform(start, f) {
    for (const k of this._affected()) this.shape[k] = mapPts(start[k], f);
  }

  // What is under the pointer when nothing is being dragged; also picks the cursor.
  _hover(px) {
    if (this.panMode) return { kind: 'pan', cursor: this.drag ? 'grabbing' : 'grab' };
    const gi = this._hitGuide(px);
    if (gi >= 0) return { kind: 'guide', index: gi, cursor: this.guides[gi].axis === 'v' ? 'col-resize' : 'row-resize' };
    if (this.tool === 'draw') return { kind: 'draw', cursor: 'crosshair' };
    if (this.tool === 'points') {
      const h = this._hitHandle(px);
      if (h) return { kind: 'handle', which: h, cursor: 'pointer' };
      const vi = this._hitVertex(px);
      if (vi >= 0) return { kind: 'vertex', index: vi, cursor: 'pointer' };
      const edge = this._hitEdge(px);
      if (edge && this.points.length >= 3 && this.inRegion(edge.point)) return { kind: 'edge', edge, cursor: 'copy' };
      return { kind: 'add', cursor: 'crosshair' };
    }
    const hb = this._bboxHandles();
    if (!hb) return { kind: 'none', cursor: 'default' };
    const near = (h) => h && (h.x - px.x) ** 2 + (h.y - px.y) ** 2 <= HIT_R * HIT_R;
    if (near(hb.rot)) return { kind: 'rotate', hb, cursor: ROTATE_CURSOR };
    const h = hb.handles.find(near);
    if (h) return { kind: 'scale', h, hb, cursor: h.cursor };
    const mm = this.toMm(px);
    if (this._insideShape(mm)) return { kind: 'move', hb, cursor: 'move' };
    return { kind: 'none', cursor: 'default' };
  }

  // ----- pointer handling -----

  _down(e) {
    e.preventDefault();
    this.canvas.setPointerCapture(e.pointerId);
    const px = this._eventPos(e);
    this.pointers.set(e.pointerId, px);
    this._cancelPress();

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
    if (this.pointers.size === 2 && !this.panMode && this.points.length >= 3 && !this.symOn) {
      this.stroke = null; this.drag = null;
      const [a, b] = [...this.pointers.values()];
      this.gesture = { start: copyShape(this.shape), d0: Math.hypot(b.x - a.x, b.y - a.y),
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
        const now = performance.now(), key = `v${vi}`;
        if (this.lastTap.key === key && now - this.lastTap.t < 350) { this.lastTap = { t: 0, key: null }; this.deletePoint(vi); return; }
        this.lastTap = { t: now, key };
        this._record(); this.drag = { kind: 'vertex', index: vi, moved: false }; this._setCursor('move');
        if (e.pointerType !== 'mouse') this._pressTimer = setTimeout(() => { this.drag = null; this.undoStack.pop(); this._openMenu(vi, e); }, LONG_PRESS);
        return;
      }
      if (rightClick) return;
      if (hit.kind === 'edge') {
        this._record(); this.points.splice(hit.edge.index, 0, this._snapPoint(hit.edge.point));
        this._select(hit.edge.index);
        this.drag = { kind: 'vertex', index: hit.edge.index, moved: true }; this._setCursor('move'); this._changed(); return;
      }
      if (!this.inRegion(mm)) return;
      this._record(); this.points.push(this._snapPoint(mm));
      this._select(this.points.length - 1);
      this.drag = { kind: 'vertex', index: this.points.length - 1, moved: true }; this._setCursor('move');
      this._changed();
    } else if (this.tool === 'move') {
      if (rightClick) return;
      if (hit.kind === 'rotate') { this._record(); this.drag = { kind: 'rotate', start: copyShape(this.shape), c: hit.hb.b, a0: Math.atan2(px.y - hit.hb.center.y, px.x - hit.hb.center.x) }; this._setCursor(hit.cursor); return; }
      if (hit.kind === 'scale') { this._record(); this.drag = { kind: 'scale', h: hit.h, start: copyShape(this.shape), b: hit.hb.b, p0: mm }; this._setCursor(hit.cursor); return; }
      if (hit.kind === 'move') {
        this._record(); this.drag = { kind: 'move', start: copyShape(this.shape), p0: mm, b0: bounds(this._display()[this.active]) }; this._setCursor('move');
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
      if (!this.drag && !this.stroke) this._setCursor(this._hover(px).cursor);
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
      const p = this.points[d.index];
      const s = this._snapPoint(mm);
      p.x = s.x; p.y = s.y; d.moved = true; this._changed();
    } else if (d.kind === 'handle') {
      const p = this.points[d.index];
      const s = this._snapPoint(mm, { grid: false, axis: false, guides: false });
      const h = { x: s.x - p.x, y: s.y - p.y };
      p[d.which] = h;
      if (p.smooth !== false) {
        const other = d.which === 'in' ? 'out' : 'in';
        const l = Math.hypot(h.x, h.y) || 1;
        const lo = p[other] ? Math.hypot(p[other].x, p[other].y) : l;
        p[other] = { x: -h.x / l * lo, y: -h.y / l * lo };
      }
      this._changed();
    } else if (d.kind === 'move') {
      let dx = mm.x - d.p0.x, dy = mm.y - d.p0.y;
      if (this.sym.x) dx = 0;
      if (this.sym.y) dy = 0;
      const b = d.b0;
      const adj = this._snapBox({ minX: b.minX + dx, maxX: b.maxX + dx, cx: b.cx + dx, minY: b.minY + dy, maxY: b.maxY + dy, cy: b.cy + dy });
      if (!this.sym.x) dx += adj.dx;
      if (!this.sym.y) dy += adj.dy;
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
      const ax = h.ax === 1 ? b.maxX : h.ax === -1 ? b.minX : null;
      const ay = h.ay === 1 ? b.maxY : h.ay === -1 ? b.minY : null;
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
      if (poly) this.setPoints(poly, { record: true, center: this.active === 'outer' && !this.symOn && !this.hasInner });
      else this.dirty = true;
      return;
    }
    if (this.drag) {
      const d = this.drag; this.drag = null;
      if (d.kind === 'pan') {
        this._setCursor(this._defaultCursor());
        if (!d.moved && d.menuIndex >= 0) this._openMenu(d.menuIndex, d.ev);
        this.dirty = true; return;
      }
      this._setCursor(this._hover(px).cursor);
      if (d.kind === 'guide') { this.dirty = true; return; }
      if (d.kind === 'vertex' && !d.moved) { this.undoStack.pop(); }
      if (d.kind !== 'vertex' && d.kind !== 'handle') this._autoFit();
      this._changed();
    }
  }

  // ----- rendering -----

  _loop() {
    if (this.dirty) { this.dirty = false; this._render(); }
    requestAnimationFrame(() => this._loop());
  }

  _render() {
    const ctx = this.ctx, C = this.colors;
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.fillStyle = C.paper; ctx.fillRect(0, 0, this.w, this.h);

    this._renderGrid();

    const disp = this._display();
    const rings = disp.outer.length >= 3 ? this.ringsProvider(disp) : null;
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
    this._renderSymmetry();
    this._renderGuides();
    if (this.tool === 'points') this._renderVertices();
    if (this.tool === 'move') this._renderBox();
    if (disp.outer.length >= 3) this._renderDims(disp.outer);
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

  _renderSymmetry() {
    if (!this.symOn) return;
    const ctx = this.ctx, C = this.colors;
    const o = this.toPx({ x: 0, y: 0 });
    ctx.fillStyle = C.inactive;
    if (this.sym.x) ctx.fillRect(0, 0, o.x, this.h);
    if (this.sym.y) ctx.fillRect(this.sym.x ? o.x : 0, o.y, this.w, this.h - o.y);
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
        ctx.beginPath(); ctx.arc(h.x, h.y, 6, 0, Math.PI * 2);
        ctx.fillStyle = C.paper; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = C.handle; ctx.stroke();
      }
    }
    this.points.forEach((p, i) => {
      if (!this.inRegion(p)) return;
      const q = this.toPx(p);
      const sel = i === this.selected, curved = !!(p.in || p.out);
      ctx.beginPath();
      if (curved) ctx.arc(q.x, q.y, sel ? HANDLE_R : HANDLE_R - 2, 0, Math.PI * 2);
      else { const r = sel ? HANDLE_R - 1 : HANDLE_R - 3; ctx.rect(q.x - r, q.y - r, 2 * r, 2 * r); }
      ctx.fillStyle = sel ? C.accent : i === 0 ? C.accentSoft : C.paper; ctx.fill();
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
