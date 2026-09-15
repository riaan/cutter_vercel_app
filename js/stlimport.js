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
// What cannot come back: Bézier handles and symmetry (the STL only ever held the flattened
// outline) and the Mirror setting (both settings make the same solid from mirrored drawings,
// so the shape is read back with Mirror off, which reproduces this very STL).

import { simplify, bounds, signedArea, offsetPolygon, intersectPolygons, FAT, DEFAULT_PARAMS } from './geometry.js';

const MIN_FACE_AREA = 0.5; // mm² — a smaller horizontal face is a CSG crumb, not the top of a tier
const LEVEL_MERGE = 0.05;  // mm — faces closer together than this are one level (tiers overlap by 0.02)
const MIN_BAR_AREA = 0.2;  // mm² — below this a "bar" is a rounding sliver along the cut line
const CHANNEL_BACK = 0.05; // mm the channel is held back from both cut lines, so the boolean that
                           // lifts the bars out never has to cut along an edge it already shares

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

// The narrowest way across a bar, and the direction it runs in. A bar is a rectangle with its
// ends cut off by the two cut lines, so its narrowest span is exactly the thickness it was given.
function barAxis(poly) {
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

// The bars are whatever fills the channel between the two cut lines at base height.
function readBars(baseRings, outer, inner) {
  const chan = [orient(offsetPolygon(outer, -CHANNEL_BACK) || outer, true),
                orient(offsetPolygon(inner, CHANNEL_BACK) || inner, false)];
  const bars = intersectPolygons(baseRings.map(r => r.pts), chan).filter(p => signedArea(p) > MIN_BAR_AREA);
  if (!bars.length) return { count: 0, width: null, angle: 0, even: true };

  const ic = bounds(inner);
  const widths = [], angles = [];
  for (const b of bars) {
    const { width, dir } = barAxis(b);
    const c = centroid(b);
    const away = (c.x - ic.cx) * dir.x + (c.y - ic.cy) * dir.y >= 0 ? 1 : -1;
    widths.push(width);
    angles.push(Math.atan2(away * dir.y, away * dir.x));
  }
  const sorted = widths.slice().sort((a, b) => a - b);
  const width = sorted[sorted.length >> 1];

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

// buffer (an .stl file) -> the drawing and the settings that build it again.
// Returns { shape, params, size, footprint, tiers, notes, outlineOnly }, in screen space (y down).
export function importSTL(buffer) {
  const pos = parseSTL(buffer);
  if (pos.length < 4 * 9) throw new Error('This STL has no solid in it.');
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

  const top = tiers[tiers.length - 1];
  const params = { ...DEFAULT_PARAMS, mirror: false, height: round(bb.depth) };

  // The blade: a ring, so the cut line is the hole in it. Anything else is not a cutter, and the
  // best that can be done is to take the silhouette and leave the settings alone.
  const cutRing = atDepth(top.rings, 1);
  const outlineOnly = !cutRing;
  const outer = cutRing ? cutRing.pts : (atDepth(top.rings, 0)?.pts || null);
  if (!outer) throw new Error('Nothing was found at the top of this model — it does not look like a cutter.');
  if (outlineOnly) notes.push('No blade was found in this STL, so its outline at the top was used and the wall settings were left as they are.');

  let inner = null;
  if (!outlineOnly) {
    const innerRing = atDepth(top.rings, 2);
    if (innerRing && Math.abs(innerRing.area) > 1) inner = innerRing.pts;

    for (const t of tiers) {
      const edge = atDepth(t.rings, 0);
      t.w = edge ? wallWidth(outer, edge.pts) - FAT : null;
    }
    const wall = tiers.filter(t => t.w > 0);
    if (!wall.length) throw new Error('The walls of this cutter could not be measured.');

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
      const bars = base ? readBars(base.rings, outer, inner) : { count: 0, width: null, angle: 0, even: true };
      params.bridgeCount = Math.min(12, bars.count);
      if (bars.width) params.bridgeWidth = round(Math.max(0.5, bars.width));
      params.bridgeAngle = round(bars.angle, 1);
      if (bars.count > 12) notes.push(`${bars.count} connections were found; Cutter makes at most 12.`);
      if (!bars.even) notes.push('The connections are not all the same thickness; the middle one was used for all of them.');
    }
  }

  // Model space is y up, screen space y down. With Mirror off the two are one flip apart, which
  // is exactly the drawing whose top view is this STL.
  const toScreen = (pts) => {
    const s = pts.map(q => ({ x: q.x, y: -q.y }));
    return signedArea(s) < 0 ? s.reverse() : s;
  };
  const shape = { outer: toScreen(outer), inner: inner ? toScreen(inner) : [] };
  const size = bounds(shape.outer);
  return {
    shape,
    params,
    size: { width: size.width, height: size.height },
    footprint: { width: bb.width, height: bb.height, height3d: bb.depth },
    tiers: tiers.length,
    points: shape.outer.length + shape.inner.length,
    outlineOnly,
    notes,
  };
}
