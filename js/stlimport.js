// STL -> the cutter that made it.
//
// A cutter is a stack of prisms with vertical walls, so a horizontal cut through it hands the
// outline straight back. Slicing halfway up the blade gives a thin ring whose *inner* edge is
// the cut line, and — when the cutter has one — a second ring whose *outer* edge is the inner
// wall. Nothing is guessed from the triangles themselves; every number comes from a section:
//   heights   the z of the horizontal faces: the tops of the base, the step and the blade
//   widths    the distance from the cut line out to that tier's outer edge, less FAT
//   bars      what is left of the base section inside the channel between the two walls
//
// A file may hold several cutters side by side. They never touch, so the triangles fall into
// separate connected lumps; each lump is read on its own and becomes one shape, with its own
// wall settings, in the place the file puts it.
//
// What cannot come back: Bézier handles and symmetry (the STL only ever held the flattened
// outline) and the Mirror setting (both settings make the same solid from mirrored drawings,
// so the shape is read back with Mirror off, which reproduces this very STL).

import { simplify, bounds, signedArea, offsetPolygon, intersectPolygons, subtractPolygons, unionPolygons,
         closeGaps, FAT, DEFAULT_PARAMS } from './geometry.js';

const MIN_FACE_AREA = 0.5; // mm² — a smaller horizontal face is a CSG crumb, not the top of a tier
const LEVEL_MERGE = 0.05;  // mm — faces closer together than this are one level (tiers overlap by 0.02)
const MIN_BAR_AREA = 0.2;  // mm² — below this a "bar" is a rounding sliver along the cut line
const CHANNEL_BACK = 0.05; // mm the channel is held back from both cut lines, so the boolean that
                           // lifts the bars out never has to cut along an edge it already shares
const ON_END = 0.1;        // mm — an edge whose middle is this close to the side of the channel is
                           // the end of a bar, cut off by it, and not one of the bar's own sides
// How much thicker than the thinnest blade on the plate a wall may be and still count as a blade
// rather than as the edge of the plate. Blades are measured, not assumed; this is only the slack
// that keeps a 0.4 mm blade read as 0.41 on one side and 0.43 on the other on the same footing.
const BLADE_SLACK = 1.35;
// mm a contour may shift between two tiers and still count as standing still. A wall is a band:
// it stands on its cut line and grows away from it, so the cut-line edge is in the same place at
// every tier while the other edge moves by the difference between the two widths — millimetres.
const SAME_EDGE = 0.05;

// ---------- reading the file ----------

// Binary or ASCII STL -> a flat Float32Array of triangle corners (9 numbers per triangle).
export function parseSTL(buffer) {
  if (!buffer || buffer.byteLength < 84) throw new Error('This file is too small to be an STL.');
  const view = new DataView(buffer);
  const n = view.getUint32(80, true);
  if (n > 0 && buffer.byteLength === 84 + n * 50) {
    const pos = new Float32Array(n * 9);
    let off = 84;
    for (let t = 0; t < n; t++) {
      off += 12; // the stored normal; normals are recomputed from the corners wherever they matter
      for (let c = 0; c < 9; c++) { pos[t * 9 + c] = view.getFloat32(off, true); off += 4; }
      off += 2;  // attribute byte count
    }
    return pos;
  }
  const text = new TextDecoder().decode(new Uint8Array(buffer));
  if (!/^\s*solid/i.test(text.slice(0, 200))) throw new Error('This file is not an STL.');
  const out = [];
  const re = /vertex\s+(-?[\d.]+(?:[eE][+-]?\d+)?)\s+(-?[\d.]+(?:[eE][+-]?\d+)?)\s+(-?[\d.]+(?:[eE][+-]?\d+)?)/g;
  let m;
  while ((m = re.exec(text))) out.push(+m[1], +m[2], +m[3]);
  if (out.length < 9 || out.length % 9) throw new Error('This STL is damaged — its triangles are incomplete.');
  return new Float32Array(out);
}

// The footprint of a lump of triangles, and whether one sits inside another. Two cutters on a
// plate never overlap in plan, so nesting can only mean the two lumps are one cutter.
function xyBox(pos) {
  const b = box3(pos);
  return { minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY, area: b.width * b.height };
}
const boxInside = (a, b) => a.minX >= b.minX - 1e-4 && a.maxX <= b.maxX + 1e-4
  && a.minY >= b.minY - 1e-4 && a.maxY <= b.maxY + 1e-4 && a.area < b.area * 0.999;

// Triangles that share a corner belong to the same solid. Cutters on one plate are kept a
// nozzle width apart, so the lumps this finds are the shapes — biggest first. The one exception
// is a cutter whose inner wall has no connection bars: that wall is a lump of its own, standing
// inside the outer wall's footprint, and it is folded back into the cutter it belongs to.
export function splitSolids(pos) {
  const n = pos.length / 9;
  if (n < 2) return [pos];
  const key = (i) => `${Math.round(pos[i] * 1e4)},${Math.round(pos[i + 1] * 1e4)},${Math.round(pos[i + 2] * 1e4)}`;
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const seen = new Map();
  for (let t = 0; t < n; t++) {
    for (let c = 0; c < 3; c++) {
      const k = key(t * 9 + c * 3);
      const other = seen.get(k);
      if (other === undefined) seen.set(k, t);
      else { const a = find(other), b = find(t); if (a !== b) parent[b] = a; }
    }
  }
  const groups = new Map();
  for (let t = 0; t < n; t++) {
    const r = find(t);
    let g = groups.get(r);
    if (!g) { g = []; groups.set(r, g); }
    g.push(t);
  }
  if (groups.size < 2) return [pos];
  const lumps = [];
  for (const g of groups.values()) {
    const a = new Float32Array(g.length * 9);
    for (let i = 0; i < g.length; i++) a.set(pos.subarray(g[i] * 9, g[i] * 9 + 9), i * 9);
    lumps.push(a);
  }

  // Fold every lump into the smallest lump whose footprint contains it — an inner wall with no
  // bars into its cutter — following the chain up to the one that is inside nothing.
  const boxes = lumps.map(xyBox);
  const host = boxes.map((b, i) => {
    let best = -1;
    for (let j = 0; j < boxes.length; j++) {
      if (j !== i && boxInside(b, boxes[j]) && (best < 0 || boxes[j].area < boxes[best].area)) best = j;
    }
    return best;
  });
  const rootOf = (i) => { for (let g = 0; g < boxes.length && host[i] >= 0; g++) i = host[i]; return i; };
  const merged = new Map();
  for (let i = 0; i < lumps.length; i++) {
    const r = rootOf(i);
    let list = merged.get(r);
    if (!list) { list = []; merged.set(r, list); }
    list.push(lumps[i]);
  }
  const out = [];
  for (const list of merged.values()) {
    if (list.length === 1) { out.push(list[0]); continue; }
    const n = list.reduce((t, a) => t + a.length, 0);
    const joined = new Float32Array(n);
    let at = 0;
    for (const a of list) { joined.set(a, at); at += a.length; }
    out.push(joined);
  }
  if (out.length < 2) return [pos];
  out.sort((a, b) => b.length - a.length);
  return out;
}

function box3(pos) {
  const b = { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
  for (let i = 0; i < pos.length; i += 3) {
    if (pos[i] < b.minX) b.minX = pos[i]; if (pos[i] > b.maxX) b.maxX = pos[i];
    if (pos[i + 1] < b.minY) b.minY = pos[i + 1]; if (pos[i + 1] > b.maxY) b.maxY = pos[i + 1];
    if (pos[i + 2] < b.minZ) b.minZ = pos[i + 2]; if (pos[i + 2] > b.maxZ) b.maxZ = pos[i + 2];
  }
  b.width = b.maxX - b.minX; b.height = b.maxY - b.minY; b.depth = b.maxZ - b.minZ;
  return b;
}

// ---------- slicing ----------

// The z of every horizontal face that carries real area: the bottom, the top of each tier, the top.
function tierLevels(pos, bb) {
  const buckets = new Map();
  for (let i = 0; i < pos.length; i += 9) {
    const z = pos[i + 2];
    if (Math.abs(pos[i + 5] - z) > 1e-4 || Math.abs(pos[i + 8] - z) > 1e-4) continue;
    const area = Math.abs((pos[i + 3] - pos[i]) * (pos[i + 7] - pos[i + 1])
                        - (pos[i + 6] - pos[i]) * (pos[i + 4] - pos[i + 1])) / 2;
    const k = Math.round(z / LEVEL_MERGE);
    const b = buckets.get(k) || { area: 0, zw: 0 };
    b.area += area; b.zw += area * z; buckets.set(k, b);
  }
  const levels = [...buckets.values()].filter(b => b.area >= MIN_FACE_AREA).map(b => b.zw / b.area);
  // the bottom and the top are tier boundaries whether or not their faces made the cut
  for (const z of [bb.minZ, bb.maxZ]) if (!levels.some(l => Math.abs(l - z) < LEVEL_MERGE)) levels.push(z);
  return levels.sort((a, b) => a - b);
}

// Every closed contour where the plane z cuts the mesh, with its nesting depth (0 = outermost)
// and an orientation to match: outer contours run counter-clockwise, holes clockwise.
export function sliceRings(pos, z) {
  z = clearOfVertices(pos, z);
  const segs = [];
  for (let i = 0; i < pos.length; i += 9) {
    const d = [pos[i + 2] - z, pos[i + 5] - z, pos[i + 8] - z];
    if ((d[0] > 0 && d[1] > 0 && d[2] > 0) || (d[0] < 0 && d[1] < 0 && d[2] < 0)) continue;
    const hit = [];
    for (let e = 0; e < 3; e++) {
      const a = e, b = (e + 1) % 3;
      if ((d[a] < 0) === (d[b] < 0)) continue;
      const t = d[a] / (d[a] - d[b]);
      hit.push({ x: pos[i + a * 3] + t * (pos[i + b * 3] - pos[i + a * 3]),
                 y: pos[i + a * 3 + 1] + t * (pos[i + b * 3 + 1] - pos[i + a * 3 + 1]) });
    }
    if (hit.length === 2 && (hit[0].x !== hit[1].x || hit[0].y !== hit[1].y)) segs.push(hit);
  }
  const rings = [];
  for (const loop of chainLoops(segs)) {
    const pts = tidy(loop);
    if (pts) rings.push({ pts, area: signedArea(pts), depth: 0 });
  }
  for (const r of rings) r.depth = rings.filter(o => o !== r && inside(r.pts[0], o.pts)).length;
  for (const r of rings) {
    if ((r.depth % 2 === 0) !== (r.area > 0)) { r.pts.reverse(); r.area = -r.area; }
  }
  return rings;
}

// A plane through a vertex cuts a triangle in one point instead of two, which breaks the
// contours. Tiers are millimetres tall, so stepping a few microns off is harmless.
function clearOfVertices(pos, z) {
  for (let tries = 0; tries < 40; tries++) {
    let clear = true;
    for (let i = 2; i < pos.length; i += 3) if (Math.abs(pos[i] - z) < 1e-4) { clear = false; break; }
    if (clear) return z;
    z += 1e-3;
  }
  return z;
}

// Segments -> closed contours. The mesh is watertight, so segment ends meet exactly; they are
// keyed on a 0.00001 mm grid, and anything that does not close up is dropped.
function chainLoops(segs) {
  const K = (p) => `${Math.round(p.x * 1e5)},${Math.round(p.y * 1e5)}`;
  const at = new Map();
  segs.forEach((s, i) => {
    for (const e of [0, 1]) {
      const k = K(s[e]);
      if (!at.has(k)) at.set(k, []);
      at.get(k).push(i);
    }
  });
  const used = new Uint8Array(segs.length);
  const loops = [];
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const startKey = K(segs[i][0]);
    const loop = [segs[i][0], segs[i][1]];
    let cur = segs[i][1], closed = false;
    for (let guard = 0; guard <= segs.length; guard++) {
      if (K(cur) === startKey) { closed = true; break; }
      let next = -1;
      for (const j of at.get(K(cur)) || []) if (!used[j]) { next = j; break; }
      if (next < 0) break;
      used[next] = 1;
      const s = segs[next];
      cur = K(s[0]) === K(cur) ? s[1] : s[0];
      loop.push(cur);
    }
    if (closed && loop.length >= 4) { loop.pop(); loops.push(loop); }
  }
  return loops;
}

// Drop repeated points, and the extra point every wall face gets from being two triangles:
// it sits exactly on the line between its neighbours, so 0.001 mm of RDP takes it out.
function tidy(loop) {
  const out = [];
  for (const p of loop) {
    const q = out[out.length - 1];
    if (!q || Math.hypot(p.x - q.x, p.y - q.y) > 1e-6) out.push(p);
  }
  while (out.length > 1 && Math.hypot(out[0].x - out[out.length - 1].x, out[0].y - out[out.length - 1].y) < 1e-6) out.pop();
  if (out.length < 3) return null;
  const s = simplify(out.concat([out[0]]), 0.001);
  s.pop();
  // RDP always keeps the point the contour happens to start at; when that is itself only a seam
  // in the middle of a wall face it lies on the line between its neighbours, so it goes too.
  if (s.length > 3 && distToSeg(s[0], s[s.length - 1], s[1]) < 0.001) s.shift();
  return s.length >= 3 ? s : null;
}

function inside(p, poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}

const atDepth = (rings, depth) => rings.filter(r => r.depth === depth)
  .sort((a, b) => Math.abs(b.area) - Math.abs(a.area))[0] || null;

// ---------- measuring ----------

// How far the cut line sits inside `edge`. An offset never runs closer than the width it was
// given, but it does run wider — around the pinch in a notch, or at a spike of a corner — so the
// answer is read near the bottom of the spread rather than in the middle of it. Points are taken
// evenly along the outline, not at its corners, or a star (half of whose corners are notches)
// would answer with its notches.
const WIDTH_SAMPLES = 800;
function wallWidth(cut, edge) {
  const n = cut.length;
  let per = 0;
  for (let i = 0; i < n; i++) per += Math.hypot(cut[(i + 1) % n].x - cut[i].x, cut[(i + 1) % n].y - cut[i].y);
  const step = Math.max(per / WIDTH_SAMPLES, 0.02);
  const ds = [];
  for (let i = 0; i < n; i++) {
    const a = cut[i], b = cut[(i + 1) % n];
    const k = Math.max(1, Math.round(Math.hypot(b.x - a.x, b.y - a.y) / step));
    for (let j = 0; j < k; j++) {
      const t = j / k;
      ds.push(distToPolygon({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, edge));
    }
  }
  ds.sort((a, b) => a - b);
  return ds[Math.floor(ds.length * 0.02)];
}

function distToSeg(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
  let t = len2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function distToPolygon(p, poly) {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const d = distToSeg(p, poly[j], poly[i]);
    if (d < best) best = d;
  }
  return best;
}

function convexHull(pts) {
  const p = pts.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const half = (src) => {
    const h = [];
    for (const q of src) {
      while (h.length >= 2 && cross(h[h.length - 2], h[h.length - 1], q) <= 0) h.pop();
      h.push(q);
    }
    h.pop();
    return h;
  };
  return half(p).concat(half(p.reverse()));
}

// The narrowest way across a shape, and the direction that span is measured along.
function narrowest(poly) {
  const h = convexHull(poly);
  let width = Infinity, dir = { x: 1, y: 0 };
  for (let i = 0; i < h.length; i++) {
    const a = h[i], b = h[(i + 1) % h.length];
    const ex = b.x - a.x, ey = b.y - a.y, len = Math.hypot(ex, ey);
    if (len < 1e-9) continue;
    const nx = -ey / len, ny = ex / len;
    let lo = Infinity, hi = -Infinity;
    for (const q of h) {
      const d = (q.x - a.x) * nx + (q.y - a.y) * ny;
      if (d < lo) lo = d; if (d > hi) hi = d;
    }
    if (hi - lo < width) { width = hi - lo; dir = { x: ex / len, y: ey / len }; }
  }
  return { width, dir };
}

// The thickness of a bar, and the direction it runs in. A bar is a rectangle with its ends cut
// off by the two sides of the channel: its own sides are the edges that lie on neither, they are
// straight and parallel, and the distance between them is the thickness it was given. Taking the
// narrowest span of the piece instead is that same distance only while a bar is longer than it is
// thick — a 12 mm bar across a 9 mm channel answers with the channel. So the sides are picked out
// first, by the one thing that tells them apart from the ends, and the span is taken across them.
function barAxis(poly, ends) {
  let dir = null, longest = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const ex = b.x - a.x, ey = b.y - a.y, len = Math.hypot(ex, ey);
    if (len <= longest) continue;
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    if (ends.some(e => distToPolygon(m, e) < ON_END)) continue;
    longest = len; dir = { x: ex / len, y: ey / len };
  }
  if (!dir) return narrowest(poly); // a channel too shallow to have sides worth the name
  const nx = -dir.y, ny = dir.x;
  let lo = Infinity, hi = -Infinity;
  for (const q of poly) {
    const d = q.x * nx + q.y * ny;
    if (d < lo) lo = d; if (d > hi) hi = d;
  }
  return { width: hi - lo, dir };
}

function centroid(poly) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const f = poly[j].x * poly[i].y - poly[i].x * poly[j].y;
    a += f; cx += (poly[j].x + poly[i].x) * f; cy += (poly[j].y + poly[i].y) * f;
  }
  if (Math.abs(a) < 1e-12) return bounds(poly);
  return { x: cx / (3 * a), y: cy / (3 * a) };
}

const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

// ---------- the connection bars ----------

const overlaps = (a, b) => a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;

// Is this void one of the pockets the bars divide the channel into? Tested at the vertex standing
// clearest of both cut lines: a pocket's boundary runs along them, and on the line itself inside
// and outside are a coin toss.
function inChannel(pts, outer, inner) {
  let best = pts[0], far = -1;
  for (const p of pts) {
    const d = Math.min(distToPolygon(p, outer), distToPolygon(p, inner));
    if (d > far) { far = d; best = p; }
  }
  return inside(best, outer) && !inside(best, inner);
}

// How far a wall's base reaches past its cut line into the channel. The pockets stop where that
// flange starts, so the distance from a pocket to the cut line is the overhang — the one thing
// about the channel the cut lines themselves cannot say. The middle pocket answers, so that a
// void which is no pocket of this channel at all cannot decide it.
function flangeReach(pockets, line) {
  if (!pockets.length) return 0;
  const ds = pockets.map(p => gapBetween(p.pts, line)).sort((a, b) => a - b);
  return ds[ds.length >> 1];
}

// The bars are whatever fills the channel between the two cut lines at base height.
//
// Cutter's own walls grow away from the cut piece, so the channel starts at the cut lines and
// holding it back a hair from each is enough. Plenty of cutters are not built that way: a base
// flange that overhangs its cut line towards the cut piece runs right round the channel and joins
// every bar into a single ring — one bar as wide as the shape, at whatever angle a hull happens
// to answer with. The pockets say where each flange ends, so the channel is held back to them.
function readBars(baseRings, outer, inner) {
  // On a merged lump every other shape's voids are in here too; their boxes rule them out for
  // the price of a bounds(), before anything is measured against a contour point by point.
  const ob = bounds(outer);
  const pockets = baseRings.filter(r => r.depth % 2 === 1 && r.pts.length > 2
    && overlaps(bounds(r.pts), ob) && inChannel(r.pts, outer, inner));
  const back = (line, sign) => offsetPolygon(line, sign * (CHANNEL_BACK + flangeReach(pockets, line))) || line;
  const chan = [orient(back(outer, -1), true), orient(back(inner, 1), false)];
  const bars = intersectPolygons(baseRings.map(r => r.pts), chan).filter(p => signedArea(p) > MIN_BAR_AREA);
  if (!bars.length) return { count: 0, width: null, angle: 0, even: true };

  const ic = bounds(inner);
  const widths = [], angles = [];
  for (const b of bars) {
    const { width, dir } = barAxis(b, chan);
    const c = centroid(b);
    const away = (c.x - ic.cx) * dir.x + (c.y - ic.cy) * dir.y >= 0 ? 1 : -1;
    widths.push(width);
    angles.push(Math.atan2(away * dir.y, away * dir.x));
  }
  // Cutter makes every connection the same thickness, so a model whose bars differ has to be
  // answered with one of them: the middle one, and of an even pair the thinner, which is the one
  // that fits the channel wherever the other would.
  const sorted = widths.slice().sort((a, b) => a - b);
  const width = sorted[(sorted.length - 1) >> 1];

  // Bars sit every 360/count degrees, so count times the angle is the same for all of them;
  // averaging there and dividing back gives the rotation of the whole pattern.
  const n = bars.length;
  let sx = 0, sy = 0;
  for (const a of angles) { sx += Math.cos(a * n); sy += Math.sin(a * n); }
  const step = (2 * Math.PI) / n;
  // buildCutter lays the bars out at -(angle + k * step) when Mirror is off, which is how it
  // is read back, so the angle in the drawing is the negative of the one measured in the model.
  let angle = -Math.atan2(sy, sx) / n;
  angle = ((angle % step) + step) % step;
  if (angle > Math.PI) angle -= 2 * Math.PI;
  return { count: n, width, angle: (angle * 180) / Math.PI, even: sorted[n - 1] - sorted[0] < 0.15 * width + 0.02 };
}

const orient = (pts, ccw) => (signedArea(pts) > 0) === ccw ? pts : pts.slice().reverse();

// ---------- the whole job ----------

// Are these two contours the same piece of the plate? A cut line met again a tier lower is, and
// so is one of the pockets the connection bars divide a channel into — neither is a new cutter.
// They are never the tidy same polygon: a neighbour's base eats into a cut region a tier down,
// and a pocket is a slice of one. Half of the smaller is the line between "this again" and "a
// shape of its own", which is nowhere near anything a plate can produce.
function sameRegion(a, b) {
  const small = Math.min(Math.abs(signedArea(a)), Math.abs(signedArea(b)));
  if (small < 1e-6) return false;
  let over = 0;
  try { for (const p of intersectPolygons([orient(a, true)], [orient(b, true)])) over += Math.abs(signedArea(p)); }
  catch { return false; }
  return over > small * 0.5;
}

// The outer edge of the tier a cut line stands in: the smallest outermost contour around it.
// A solid can hold more than one — shapes welded together lower down but standing apart up here.
function edgeAround(rings, cut) {
  return rings.filter(r => r.depth === 0 && inside(cut[0], r.pts))
    .sort((a, b) => Math.abs(a.area) - Math.abs(b.area))[0] || null;
}

// How thick the material between two voids is: the closest the two contours come to each other.
function gapBetween(a, b) {
  let best = Infinity;
  for (const p of a) { const d = distToPolygon(p, b); if (d < best) best = d; }
  for (const p of b) { const d = distToPolygon(p, a); if (d < best) best = d; }
  return best;
}

// The cut regions in one section.
//
// A void in the material is usually a cut region — the hole a blade leaves in the section. But
// shapes that were allowed to overlap have blades running through each other's regions, and every
// crossing cuts the region it passes through into pieces. The pieces are not shapes: the wall
// between two of them is a blade, not the edge of the plate.
//
// Which shape a wall belongs to is readable, and not by guessing. A wall is a band: it stands on
// its cut line and grows away from it, so at a tier whose walls are a different width the
// cut-line edge is in exactly the same place and the other edge has moved. Take the face on the
// far side of a wall away from the region, wall and all, and what is left is the shape that wall
// belongs to — with its own cut line running through where the pieces met.
//
// `ref` is the rings of a tier whose walls are a different width; without one (a solid of a single
// tier) nothing can be told apart and the pieces come back joined, which `merged` says.
function regionsOf(rings, ref, bridge) {
  const faces = rings.filter(r => r.depth === 1);
  const one = (pts, merged = 1) => ({ pts, merged });
  if (faces.length < 2) return faces.map(f => one(f.pts));

  // Voids no further apart than a blade are pieces of one region; anything further apart is
  // another cutter on the plate, and a void standing on its own is a cut line as it was drawn.
  const parent = faces.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const walls = [];
  for (let a = 0; a < faces.length; a++) {
    for (let b = a + 1; b < faces.length; b++) {
      const t = gapBetween(faces[a].pts, faces[b].pts);
      if (t > bridge) continue;
      walls.push({ a: faces[a], b: faces[b], t });
      if (find(a) !== find(b)) parent[find(a)] = find(b);
    }
  }
  const groups = new Map();
  faces.forEach((f, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(f);
  });

  const mates = ref ? mateFaces(faces, ref.filter(r => r.depth === 1)) : new Map();
  const out = [];
  for (const g of groups.values()) {
    if (g.length === 1) { out.push(one(g[0].pts)); continue; }
    const mine = walls.filter(w => g.includes(w.a) && g.includes(w.b));
    // A closing radius of one wall bridges it from both sides with room to spare. Tighter than
    // that and the rounding at the crossings costs more than the bridging saves.
    const widest = mine.reduce((t, w) => Math.max(t, w.t), 0);
    let U = [];
    try { U = closeGaps(g.map(f => f.pts), widest); } catch { U = []; }
    // Pieces that will not close into one region are past reading; hand back what is there.
    if (!U.length) { out.push(...g.map(f => one(f.pts))); continue; }
    if (U.length > 1) { out.push(...U.map(p => one(p, g.length))); continue; }

    const shapes = [];
    for (const w of mine) {
      const cut = cutSideOf(w, mates);
      if (!cut) continue;                       // both edges moved: two bands meeting, not one wall
      const off = cut === w.a ? w.b : w.a;
      let grown = null;
      try { grown = offsetPolygon(off.pts, w.t); } catch { grown = null; }
      if (!grown) continue;
      let left = [];
      try { left = subtractPolygons(U, [grown]).filter(p => signedArea(p) > 1); } catch { continue; }
      for (const r of left) if (!shapes.some(s => sameShape(s, r))) shapes.push(r);
    }
    // Every piece has to end up inside one of the shapes, and together they have to be the whole
    // region — otherwise the reading does not account for what is in the file, and saying so is
    // worth more than handing back shapes nobody drew.
    const whole = Math.abs(signedArea(U[0]));
    const covered = shapes.length > 1 && g.every(f => shapes.some(s => covers(s, f.pts)));
    const ok = covered && Math.abs(polysArea(unionPolygons(shapes.map(orientCCW))) - whole) < whole * 0.02;
    if (ok) out.push(...shapes.map(s => one(s)));
    else out.push(...U.map(p => one(p, g.length)));
  }
  return out.sort((a, b) => Math.abs(signedArea(b.pts)) - Math.abs(signedArea(a.pts)));
}

const orientCCW = (pts) => orient(pts, true);
const polysArea = (list) => list.reduce((t, p) => t + Math.abs(signedArea(p)), 0);

// Does `s` hold all of `f`? Used to check that every piece of a region ended up in a shape.
function covers(s, f) {
  try { return polysArea(subtractPolygons([orientCCW(f)], [orientCCW(s)])) < Math.abs(signedArea(f)) * 0.02; }
  catch { return false; }
}

// Two readings of the same shape — the same wall met from both ends gives one region twice over.
function sameShape(a, b) {
  const big = Math.max(Math.abs(signedArea(a)), Math.abs(signedArea(b)));
  if (!big) return false;
  let over = 0;
  try { for (const p of intersectPolygons([orientCCW(a)], [orientCCW(b)])) over += Math.abs(signedArea(p)); }
  catch { return false; }
  return over > big * 0.97;
}

// The same void seen at another tier: the one it overlaps most. A face is eaten into by its
// neighbours' walls as those get wider, so it is never quite the same polygon — but it is always
// the one in the same place.
function mateFaces(here, there) {
  const map = new Map();
  for (const f of here) {
    let best = null, most = 0;
    for (const g of there) {
      let over = 0;
      try { for (const p of intersectPolygons([f.pts], [g.pts])) over += Math.abs(signedArea(p)); }
      catch { over = 0; }
      if (over > most) { most = over; best = g; }
    }
    if (best) map.set(f, best);
  }
  return map;
}

// Which edge of a wall is a cut line: the one that is in the same place at the other tier.
// Returns the face on that side, or null when neither edge stood still (the two bands of two
// different shapes meeting) or when the wall could not be found again.
function cutSideOf(w, mates) {
  const moved = (face, other) => {
    const mate = mates.get(face);
    if (!mate) return Infinity;
    const along = face.pts.filter(p => distToPolygon(p, other.pts) < w.t * 1.8);
    if (along.length < 3) return Infinity;
    const ds = along.map(p => distToPolygon(p, mate.pts)).sort((x, y) => x - y);
    return ds[ds.length >> 1];
  };
  const da = moved(w.a, w.b), db = moved(w.b, w.a);
  if (da < SAME_EDGE && db >= SAME_EDGE) return w.a;
  if (db < SAME_EDGE && da >= SAME_EDGE) return w.b;
  return null;
}

// One cutter out of a solid that may hold several: the cut line, the tiers it stands in, and the
// settings measured off them. `tiers` are the solid's, `top` the index of the highest one this
// cut line reaches — its blade.
function readOne(cut, tiers, top, bb, notes) {
  const params = { ...DEFAULT_PARAMS, mirror: false, height: round(tiers[top].z1 - bb.minZ) };
  const stack = tiers.slice(0, top + 1).map(t => ({ ...t, edge: edgeAround(t.rings, cut) }));

  // The inner wall is the next contour in: inside this cut line, with nothing between.
  const innerRing = tiers[top].rings
    .filter(r => r.depth === 2 && inside(r.pts[0], cut))
    .sort((a, b) => Math.abs(b.area) - Math.abs(a.area))[0];
  const inner = innerRing && Math.abs(innerRing.area) > 1 ? innerRing.pts : null;

  for (const t of stack) t.w = t.edge ? wallWidth(cut, t.edge.pts) - FAT : null;
  const wall = stack.filter(t => t.w > 0);
  if (!wall.length) throw new Error('The walls of this cutter could not be measured.');
  // Tiers of the same width are one tier — buildCutter merges them on the way out, and a plate
  // whose shapes are not all the same height puts a level through a wall that does not change
  // there at all. Putting them back together is what keeps such a shape's step where it was.
  for (let i = wall.length - 2; i >= 0; i--) {
    if (Math.abs(wall[i].w - wall[i + 1].w) < 0.02) { wall[i].z1 = wall[i + 1].z1; wall.splice(i + 1, 1); }
  }

  params.bladeWidth = round(Math.max(0.3, wall[wall.length - 1].w));
  if (wall.length === 1) {
    params.baseHeight = 0; params.baseWidth = params.bladeWidth; params.ridge = false;
    notes.push('This cutter has no base flange.');
  } else {
    params.baseHeight = round(wall[0].z1 - bb.minZ);
    params.baseWidth = round(wall[0].w);
    params.ridge = wall.length >= 3;
    if (params.ridge) {
      const step = wall[wall.length - 2];
      params.ridgeWidth = round(step.w);
      params.ridgeHeight = round(step.z1 - wall[0].z1);
    }
    if (wall.length > 3) notes.push(`This cutter is stepped ${wall.length} times; Cutter builds three tiers, so the middle ones came back as one.`);
  }

  if (inner) {
    const base = wall.length > 1 ? wall[0] : null;
    const bars = base ? readBars(base.rings, cut, inner) : { count: 0, width: null, angle: 0, even: true };
    params.bridgeCount = Math.min(12, bars.count);
    if (bars.width) params.bridgeWidth = round(Math.max(0.5, bars.width));
    params.bridgeAngle = round(bars.angle, 1);
    if (bars.count > 12) notes.push(`${bars.count} connections were found; Cutter makes at most 12.`);
    if (!bars.even) notes.push('The connections are not all the same thickness; the middle one was used for all of them.');
  }
  return { cut, inner, params, tiers: wall.length };
}

// Model space is y up, screen space y down. With Mirror off the two are one flip apart, which
// is exactly the drawing whose top view is this STL.
const toScreen = (pts) => {
  const s = pts.map(q => ({ x: q.x, y: -q.y }));
  return signedArea(s) < 0 ? s.reverse() : s;
};

// One solid -> the cutter, or the cutters, in it.
//
// A solid is usually one cutter. Shapes that were allowed to overlap were unioned into a single
// watertight object, though, so one solid can hold several cut lines — one per cutter — and each
// of them has to be measured on its own: its own height, its own walls, its own connections.
// Returns { parts, tiers, footprint, notes }; every part is in screen space (y down).
export function readSolid(pos) {
  const bb = box3(pos);
  if (bb.depth < 1) throw new Error('This model is flat — a cutter has to stand up.');
  if (bb.width < 2 || bb.height < 2) throw new Error('This model is too small to be a cutter.');

  const notes = [];

  const levels = tierLevels(pos, bb);
  const tiers = [];
  for (let i = 0; i < levels.length - 1; i++) {
    if (levels[i + 1] - levels[i] < 0.2) continue; // a rim too thin to be a tier of its own
    tiers.push({ z0: levels[i], z1: levels[i + 1] });
  }
  if (!tiers.length) tiers.push({ z0: bb.minZ, z1: bb.maxZ });
  for (const t of tiers) t.rings = sliceRings(pos, (t.z0 + t.z1) / 2);

  // How thin a wall between two voids has to be to be a blade rather than the edge of the plate.
  // Every blade on the plate stands between its cut line and the open air, so the closest any cut
  // region comes to the outline around it is the thinnest blade there is — measured, not assumed.
  const top = tiers[tiers.length - 1];
  let bridge = 0;
  for (const r of top.rings.filter(r => r.depth === 1)) {
    const edge = edgeAround(top.rings, r.pts);
    if (edge) bridge = bridge ? Math.min(bridge, gapBetween(r.pts, edge.pts)) : gapBetween(r.pts, edge.pts);
  }
  bridge = Math.min(Math.max(bridge * BLADE_SLACK, 0.1), 5);

  // Every cut region in the solid, working down from the top: one that no cutter found so far
  // already covers is a cutter of its own, and the tier it first shows up in is its blade. Coming
  // down rather than up is what gives a shorter shape beside a taller one its own height, and what
  // keeps the pockets between connection bars from being read as shapes of their own.
  const found = [];
  for (let i = tiers.length - 1; i >= 0; i--) {
    // the tier to read the walls against: any other one, because what matters is only that its
    // walls are a different width. The base is the widest, so everything above is read against it
    // and it is read against the blade.
    const ref = tiers.length > 1 ? tiers[i === 0 ? tiers.length - 1 : 0] : null;
    for (const r of regionsOf(tiers[i].rings, ref && ref.rings, bridge)) {
      if (found.some(c => sameRegion(c.cut, r.pts))) continue;
      found.push({ cut: r.pts, top: i, merged: r.merged });
    }
  }
  // Where the walls could not be read — a solid of a single tier has no second width to read them
  // against, and a reading that does not account for every piece is not a reading — the pieces come
  // back joined, as the outline around them. Handing back a shape per piece would give each one a
  // wall and a base of its own, which is the one answer that is certainly wrong.
  const pieces = found.reduce((n, c) => n + (c.merged > 1 ? c.merged : 0), 0);
  if (pieces) {
    notes.push(`This model was printed as one object with blades running through it, and which shape each blade belonged to could not be read off the model; the ${pieces} pieces they cut came back as the ${found.filter(c => c.merged > 1).length === 1 ? 'outline' : 'outlines'} around them. Saving a project file keeps the shapes themselves.`);
  }

  // Nothing with a blade in it is not a cutter; the best that can be done is to take the
  // silhouette at the top and leave the wall settings alone.
  if (!found.length) {
    const outline = atDepth(top.rings, 0);
    if (!outline) throw new Error('Nothing was found at the top of this model — it does not look like a cutter.');
    notes.push('No blade was found in this STL, so its outline at the top was used and the wall settings were left as they are.');
    const shape = { outer: toScreen(outline.pts), inner: [] };
    const size = bounds(shape.outer);
    return {
      parts: [{ shape, params: { ...DEFAULT_PARAMS, mirror: false, height: round(bb.depth) },
                size: { width: size.width, height: size.height }, tiers: tiers.length,
                points: shape.outer.length, outlineOnly: true, notes }],
      tiers: tiers.length, notes,
      footprint: { width: bb.width, height: bb.height, height3d: bb.depth },
    };
  }

  const parts = [];
  for (const c of found) {
    const own = [];
    let one;
    try { one = readOne(c.cut, tiers, c.top, bb, own); }
    catch { continue; }   // a cut line whose walls make no sense is not a shape; the others still are
    for (const n of own) if (!notes.includes(n)) notes.push(n);
    const shape = { outer: toScreen(one.cut), inner: one.inner ? toScreen(one.inner) : [] };
    const size = bounds(shape.outer);
    parts.push({
      shape,
      params: one.params,
      size: { width: size.width, height: size.height },
      tiers: one.tiers,
      points: shape.outer.length + shape.inner.length,
      outlineOnly: false,
      notes: own,
    });
  }
  if (!parts.length) throw new Error('The walls of this cutter could not be measured.');
  return {
    parts,
    tiers: tiers.length,
    notes,
    footprint: { width: bb.width, height: bb.height, height3d: bb.depth },
  };
}

// buffer (an .stl file) -> one entry per cutter in it, and the size of the whole plate.
export function importSTL(buffer) {
  const pos = parseSTL(buffer);
  if (pos.length < 4 * 9) throw new Error('This STL has no solid in it.');
  const solids = splitSolids(pos);
  const parts = [];
  const notes = [];
  let skipped = 0, firstError = null;
  for (const sp of solids) {
    try {
      const read = readSolid(sp);
      parts.push(...read.parts);
      for (const n of read.notes) if (!notes.includes(n)) notes.push(n);
    } catch (e) { firstError = firstError || e; skipped++; }
  }
  // Nothing usable: let the lump that failed first say why, in its own words.
  if (!parts.length) throw firstError || new Error('Nothing in this file looks like a cutter.');
  parts.sort((a, b) => b.size.width * b.size.height - a.size.width * a.size.height);
  if (parts.length > 1) {
    notes.unshift(`${parts.length} shapes were found in this file; each came back with its own settings.`);
  }
  if (skipped) notes.push(`${skipped} piece${skipped === 1 ? '' : 's'} too small to be a cutter ${skipped === 1 ? 'was' : 'were'} left out.`);

  const bb = box3(pos);
  const all = parts.map(p => p.shape.outer).flat();
  const size = bounds(all);
  return {
    parts,
    notes,
    size: { width: size.width, height: size.height },
    footprint: { width: bb.width, height: bb.height, height3d: bb.depth },
    points: parts.reduce((t, p) => t + p.points, 0),
  };
}
