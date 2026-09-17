// Geometry pipeline: 2D outline (mm) -> cleaned polygon -> stepped cutter mesh -> STL.
// Uses ClipperLib (global, loaded from vendor/clipper.js) for robust polygon
// cleanup and offsetting, and three's ShapeUtils (earcut) for ring triangulation.

import { ShapeUtils, Vector2 } from '../vendor/three.module.js';

const CL = () => globalThis.ClipperLib;
const SCALE = 1000; // Clipper works on integers: 1 unit = 0.001 mm

// ---------- helpers ----------

export function signedArea(pts) {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

export function bounds(pts) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY,
           cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
}

const toClip = (pts) => pts.map(p => ({ X: Math.round(p.x * SCALE), Y: Math.round(p.y * SCALE) }));
const fromClip = (path) => path.map(p => ({ x: p.X / SCALE, y: p.Y / SCALE }));

function largestPath(paths) {
  let best = null, bestArea = 0;
  for (const p of paths) {
    const a = Math.abs(CL().Clipper.Area(p));
    if (a > bestArea) { bestArea = a; best = p; }
  }
  return best;
}

// Ramer–Douglas–Peucker simplification for an open or closed polyline.
export function simplify(pts, tolerance) {
  if (pts.length < 3 || tolerance <= 0) return pts.slice();
  const sq = tolerance * tolerance;
  const keep = new Uint8Array(pts.length);
  keep[0] = 1; keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let maxD = 0, idx = -1;
    const a = pts[s], b = pts[e];
    const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
    for (let i = s + 1; i < e; i++) {
      const p = pts[i];
      let d;
      if (len2 === 0) d = (p.x - a.x) ** 2 + (p.y - a.y) ** 2;
      else {
        let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
        t = Math.max(0, Math.min(1, t));
        d = (p.x - (a.x + t * dx)) ** 2 + (p.y - (a.y + t * dy)) ** 2;
      }
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > sq && idx > 0) { keep[idx] = 1; stack.push([s, idx], [idx, e]); }
  }
  return pts.filter((_, i) => keep[i]);
}

// Chaikin corner cutting on a closed polygon — turns a jagged sketch into a smooth curve.
// `cut` is how far along each edge the two new points are placed. A quarter is the classic
// Chaikin corner cut; anything less cuts the corner less deeply, which is what lets a slider
// dial the rounding up and down smoothly instead of jumping a whole pass at a time.
export function chaikin(pts, passes = 1, closed = true, cut = 0.25) {
  let out = pts;
  const a = Math.min(0.5, Math.max(0, cut)), b = 1 - a;
  for (let k = 0; k < passes; k++) {
    const next = [];
    const n = out.length, m = closed ? n : n - 1;
    if (!closed) next.push(out[0]);
    for (let i = 0; i < m; i++) {
      const p = out[i], q = out[(i + 1) % n];
      next.push({ x: b * p.x + a * q.x, y: b * p.y + a * q.y });
      next.push({ x: a * p.x + b * q.x, y: a * p.y + b * q.y });
    }
    if (!closed) next.push(out[n - 1]);
    out = next;
  }
  return out;
}

// Round the corners of a contour: light simplification first (so dense outlines don't
// explode in vertex count), then Chaikin corner cutting.
export function roundCorners(pts, passes = 2, closed = true, cut = 0.25) {
  if (!pts || pts.length < 3) return pts;
  const base = simplify(closed ? pts.concat([pts[0]]) : pts, 0.05);
  if (closed) base.pop();
  return chaikin(base, passes, closed, cut);
}

// Resolve self-intersections, drop tiny slivers, keep the largest region.
// Returns null when there is no usable area.
export function cleanPolygon(pts, tolerance = 0.02) {
  if (!pts || pts.length < 3) return null;
  const C = CL();
  const solved = C.Clipper.SimplifyPolygon(toClip(pts), C.PolyFillType.pftNonZero);
  if (!solved.length) return null;
  const best = largestPath(solved);
  if (!best || Math.abs(C.Clipper.Area(best)) < 1 * SCALE * SCALE) return null; // < 1 mm²
  const cleaned = C.Clipper.CleanPolygon(best, tolerance * SCALE);
  if (cleaned.length < 3) return null;
  if (C.Clipper.Area(cleaned) < 0) cleaned.reverse();
  return fromClip(cleaned);
}

// Union several closed loops into one region (for multi-path SVGs). Returns the
// list of resulting outer polygons, largest first.
export function unionPolygons(loops) {
  const C = CL();
  const clipper = new C.Clipper();
  for (const l of loops) if (l.length >= 3) clipper.AddPath(toClip(l), C.PolyType.ptSubject, true);
  const out = new C.Paths();
  clipper.Execute(C.ClipType.ctUnion, out, C.PolyFillType.pftNonZero, C.PolyFillType.pftNonZero);
  const outers = out.filter(p => C.Clipper.Area(p) > 0);
  outers.sort((a, b) => C.Clipper.Area(b) - C.Clipper.Area(a));
  return outers.map(fromClip);
}

// Offset a simple polygon outward (delta > 0) with rounded corners.
export function offsetPolygon(pts, delta, arcTolerance = 0.01) {
  const C = CL();
  if (Math.abs(delta) < 1e-6) return pts.slice();
  const co = new C.ClipperOffset(2, arcTolerance * SCALE);
  co.AddPath(toClip(pts), C.JoinType.jtRound, C.EndType.etClosedPolygon);
  const out = new C.Paths();
  co.Execute(out, delta * SCALE);
  const best = largestPath(out);
  if (!best) return null;
  if (C.Clipper.Area(best) < 0) best.reverse();
  return fromClip(best);
}

// ---------- Clipper helpers (integer space) ----------

function pathsOp(op, subject, clip, preserveCollinear = false) {
  const C = CL();
  const c = new C.Clipper();
  c.PreserveCollinear = preserveCollinear;
  if (subject.length) c.AddPaths(subject, C.PolyType.ptSubject, true);
  if (clip.length) c.AddPaths(clip, C.PolyType.ptClip, true);
  const out = new C.Paths();
  c.Execute(op, out, C.PolyFillType.pftNonZero, C.PolyFillType.pftNonZero);
  return out;
}
const unionI = (a, b = [], keep = false) => pathsOp(CL().ClipType.ctUnion, a, b, keep);
const diffI = (a, b) => pathsOp(CL().ClipType.ctDifference, a, b);
const interI = (a, b) => pathsOp(CL().ClipType.ctIntersection, a, b);

function offsetI(paths, delta, arcTolerance = 0.01) {
  const C = CL();
  const co = new C.ClipperOffset(2, arcTolerance * SCALE);
  co.AddPaths(paths, C.JoinType.jtRound, C.EndType.etClosedPolygon);
  const out = new C.Paths();
  co.Execute(out, delta * SCALE);
  return out;
}

// Band of material of width w outside (w > 0) or inside (w < 0) the contour.
function ringI(path, w) {
  if (w > 0) return diffI(offsetI([path], w), [path]);
  const inner = offsetI([path], w);
  return diffI([path], inner); // if the offset collapses, the whole area is filled
}

function pathsArea(paths) { return paths.reduce((a, p) => a + CL().Clipper.Area(p), 0) / (SCALE * SCALE); }

function pathsBounds(paths) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of paths) for (const q of p) {
    if (q.X < minX) minX = q.X; if (q.Y < minY) minY = q.Y;
    if (q.X > maxX) maxX = q.X; if (q.Y > maxY) maxY = q.Y;
  }
  minX /= SCALE; minY /= SCALE; maxX /= SCALE; maxY /= SCALE;
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
}

// The mirror lines of a shape cross at its own origin, so a shape that is not sitting on the
// canvas centre can still be drawn symmetrically. Both functions below work in that shape's
// local frame and hand the result back in canvas coordinates.
const ORIGIN = { x: 0, y: 0 };
const shiftPts = (pts, dx, dy) => pts.map(p => ({ x: p.x + dx, y: p.y + dy }));

// Clip a polygon (mm) to a half-plane / quadrant and mirror it back — used by the
// editor's symmetry mode. sym = { x: bool, y: bool }; editable region is x >= 0 / y <= 0,
// measured from `origin`.
export function symmetrize(pts, sym, origin = ORIGIN) {
  if (!pts || pts.length < 3 || (!sym.x && !sym.y)) return pts;
  const local = shiftPts(pts, -origin.x, -origin.y);
  const BIG = 100000;
  const rect = (x0, y0, x1, y1) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
  const region = rect(sym.x ? 0 : -BIG, -BIG, BIG, sym.y ? 0 : BIG);
  let paths = interI([toClip(local)], [toClip(region)]);
  if (!paths.length) return null;
  const mirror = (ps, mx, my) => ps.map(p => p.map(q => ({ X: mx ? -q.X : q.X, Y: my ? -q.Y : q.Y })).reverse());
  if (sym.x) paths = unionI(paths, mirror(paths, true, false), false);
  if (sym.y) paths = unionI(paths, mirror(paths, false, true), false);
  const best = largestPath(paths);
  if (!best) return null;
  if (CL().Clipper.Area(best) < 0) best.reverse();
  return shiftPts(fromClip(CL().Clipper.CleanPolygon(best, 0.002 * SCALE)), origin.x, origin.y);
}

// The editable part of a polygon in symmetry mode (x >= 0 / y <= 0 from `origin`), as one
// polygon that starts and ends on the mirror line so it can be closed along the axes again.
export function clipToRegion(pts, sym, origin = ORIGIN) {
  if (!pts || pts.length < 3 || (!sym.x && !sym.y)) return pts;
  const local = shiftPts(pts, -origin.x, -origin.y);
  const BIG = 100000;
  const region = [{ x: sym.x ? 0 : -BIG, y: -BIG }, { x: BIG, y: -BIG }, { x: BIG, y: sym.y ? 0 : BIG }, { x: sym.x ? 0 : -BIG, y: sym.y ? 0 : BIG }];
  const best = largestPath(interI([toClip(local)], [toClip(region)]));
  if (!best) return null;
  if (CL().Clipper.Area(best) < 0) best.reverse();
  const out = shiftPts(fromClip(CL().Clipper.CleanPolygon(best, 0.002 * SCALE)), origin.x, origin.y);
  const onAxis = (p) => (sym.x && Math.abs(p.x - origin.x) < 1e-6) || (sym.y && Math.abs(p.y - origin.y) < 1e-6);
  // rotate so the polygon starts at the last mirror-line vertex before the free part
  const n = out.length;
  for (let i = 0; i < n; i++) {
    if (onAxis(out[i]) && !onAxis(out[(i + 1) % n])) return out.slice(i).concat(out.slice(0, i));
  }
  return out;
}

// Intersection of two polygon sets given in mm. A ring wound the other way is a hole, so
// [outline, hole] describes a region with a hole in it. Used by the STL importer to lift the
// connection bars out of a cross-section.
export function intersectPolygons(a, b) {
  return interI(a.map(toClip), b.map(toClip)).map(fromClip);
}

// `a` minus `b`, both given in mm. The result may be several contours with holes among them;
// a canvas even-odd fill draws it as it stands.
export function subtractPolygons(a, b) {
  return diffI(a.map(toClip), b.map(toClip)).map(fromClip);
}

// Union of polygons with everything narrower than `gap` bridged over and then taken back off —
// a morphological closing. Convex corners survive it exactly; concave ones tighter than the gap
// are rounded off by it, which is the price of joining the pieces at all. Used by the STL
// importer to put a cut region back together across the blades that cross it.
export function closeGaps(polys, gap) {
  const grown = offsetI(polys.map(toClip), gap);
  const back = offsetI(grown, -gap);
  return back.filter(p => CL().Clipper.Area(p) > 0).map(fromClip);
}

// Does polygon `a` sit entirely inside polygon `b`?
export function isInside(a, b) {
  const rest = diffI([toClip(a)], [toClip(b)]);
  return Math.abs(pathsArea(rest)) < 0.05;
}

// ---------- mesh building ----------


// ---------- solid modelling (Manifold, WebAssembly) ----------
// The cutter is built as a CSG solid so the result is guaranteed watertight:
//   outer wall = (stepped body of outward offsets) minus (prism of the cut line)
//   inner wall = (prism of the inner line) minus (stepped body of inward offsets)
//   connections = bars, kept clear of coincident faces by ending inside the base rings
// Volumes only ever overlap or are separated; they never merely touch face-to-face, which is
// the one configuration a CSG kernel cannot represent as a single clean surface.

let M = null; // { Manifold, CrossSection }
export async function loadManifold() {
  if (M) return M;
  const { default: Module } = await import('../vendor/manifold.js');
  const wasm = await Module();
  wasm.setup();
  M = { Manifold: wasm.Manifold, CrossSection: wasm.CrossSection };
  return M;
}
export const manifoldReady = () => !!M;

const OV = 0.02; // mm of deliberate overlap between stacked tiers
const SEGMENTS = 64; // segments per full circle for rounded offset corners
export const FAT = 0.005; // mm added to every offset so a self-touching offset outline overlaps instead of pinching
                          // (exported so the STL importer can take it back off a measured wall)

export const DEFAULT_PARAMS = {
  height: 15,        // total cutter height (mm)
  bladeWidth: 0.4,   // cutting wall thickness (mm)
  baseWidth: 3,      // flange width, measured from the cutting edge (mm)
  baseHeight: 3,     // flange thickness (mm)
  ridge: true,       // intermediate support step
  ridgeWidth: 0.8,
  ridgeHeight: 7,
  bridgeCount: 4,    // connections between an inner wall and the outer wall
  bridgeWidth: 2,    // connection thickness (mm); height = base thickness
  bridgeAngle: 0,    // rotation of the connection pattern (degrees)
  mirror: false,     // off: the model's top view matches the drawing. on: mirrored, so the cut piece
                     // matches the drawing when the cutter is used upside-down
};

// One cutter as a Manifold solid, in model space. shape = { outer, inner } in mm, y pointing
// DOWN (screen space); model space is y-up, so by default (no mirror) the top view equals the
// drawing. Everything made along the way is pushed onto `trash`, which the caller empties —
// WASM memory is not garbage collected. Returns the solid and the cut line it was built from.
function cutterSolid(shape, params, trash) {
  const p = { ...DEFAULT_PARAMS, ...params };
  const outerPts = Array.isArray(shape) ? shape : shape.outer;
  const innerPts = Array.isArray(shape) ? null : shape.inner;
  if (!outerPts || outerPts.length < 3) throw new Error('Draw a closed shape first.');

  const toModel = (pts) => {
    const m = pts.map(q => ({ x: q.x, y: p.mirror ? q.y : -q.y }));
    if (signedArea(m) < 0) m.reverse();
    return m;
  };
  const outer = toModel(outerPts);
  const inner = innerPts && innerPts.length >= 3 ? toModel(innerPts) : null;
  if (inner && !isInside(inner, outer)) throw new Error('The inner shape must sit completely inside the outer shape.');

  // tiers, bottom to top: { w: wall width measured from the cut line, z0, z1 }
  const bladeW = Math.max(0.3, p.bladeWidth);
  const baseH = Math.max(0, p.baseHeight);
  const baseW = Math.max(bladeW, p.baseWidth);
  const tiers = [];
  let z = 0;
  if (baseH > 0 && baseW > bladeW) { tiers.push({ w: baseW, z0: 0, z1: baseH, base: true }); z = baseH; }
  if (p.ridge) {
    const rw = Math.min(baseW, Math.max(bladeW, p.ridgeWidth)), rh = Math.max(0, p.ridgeHeight);
    if (rw > bladeW && rh > 0 && z + rh < p.height) { tiers.push({ w: rw, z0: z, z1: z + rh }); z += rh; }
  }
  if (p.height <= z + 0.5) throw new Error('Cutter height must be taller than the base and the step together.');
  tiers.push({ w: bladeW, z0: z, z1: p.height });
  for (let i = tiers.length - 2; i >= 0; i--) {
    if (Math.abs(tiers[i].w - tiers[i + 1].w) < 1e-6) { tiers[i].z1 = tiers[i + 1].z1; tiers.splice(i + 1, 1); }
  }

  const { Manifold, CrossSection } = M;
  const keep = (o) => { trash.push(o); return o; };
  const H = p.height;
  const xs = (pts) => keep(CrossSection.ofPolygons([pts.map(q => [q.x, q.y])], 'Positive'));
  // rounded offsets can emit repeated vertices; simplify() removes them (0.001 mm)
  const off = (cs, d) => keep(keep(cs.offset(d, 'Round', 2, SEGMENTS)).simplify(0.001));
  const prism = (cs, z0, z1) => keep(keep(Manifold.extrude(cs, z1 - z0)).translate([0, 0, z0]));
  const unionAll = (list) => list.reduce((a, b) => keep(a.add(b)));

  const O = xs(outer);
  // stepped outer body: each tier reaches OV into the tier below (it is narrower, so hidden)
  const body = unionAll(tiers.map((t, i) => prism(off(O, t.w + FAT), i ? t.z0 - OV : 0, t.z1)));
  if (body.isEmpty()) throw new Error('The shape is too small for these wall settings.');
  let solid = keep(body.subtract(prism(O, -1, H + 1)));

  if (inner) {
    const I = xs(inner);
    // stepped hole: wider going up, so each tier reaches OV up into the (wider) tier above
    const hole = unionAll(tiers.map((t, i) => {
      const cs = off(I, -(t.w - FAT));
      return cs.isEmpty() ? null : prism(cs, i ? t.z0 : -1, i === tiers.length - 1 ? H + 1 : t.z1 + OV);
    }).filter(Boolean));
    const innerWall = hole ? keep(prism(I, 0, H).subtract(hole)) : prism(I, 0, H);
    solid = keep(solid.add(innerWall));

    const base = tiers.find(t => t.base);
    if (base && p.bridgeCount > 0 && p.bridgeWidth > 0) {
      // bars end 0.05 mm inside the base rings so they overlap the walls instead of touching them
      const region = keep(off(O, base.w - 0.05).subtract(off(I, -(base.w - 0.05))));
      const bars = barShapes(bounds(outer), bounds(inner), p, p.mirror ? 1 : -1).map(b => xs(b));
      const barsCS = keep(unionAll(bars).intersect(region));
      if (!barsCS.isEmpty()) solid = keep(solid.add(prism(barsCS, 0, base.z1)));
    }
  }
  return { solid, outer };
}

// A Manifold solid as the triangle soup and the numbers the app shows.
function meshOf(solid) {
  const mesh = solid.getMesh();
  const positions = new Float32Array(mesh.numTri * 9);
  const vp = mesh.vertProperties, tv = mesh.triVerts, np = mesh.numProp;
  for (let t = 0; t < mesh.numTri; t++) {
    for (let c = 0; c < 3; c++) {
      const v = tv[3 * t + c] * np;
      positions[t * 9 + c * 3] = vp[v]; positions[t * 9 + c * 3 + 1] = vp[v + 1]; positions[t * 9 + c * 3 + 2] = vp[v + 2];
    }
  }
  const bb = solid.boundingBox();
  return { positions, triangles: mesh.numTri, bounds: boxOf(bb), volumeMm3: solid.volume() };
}

// A Manifold bounding box in the shape the rest of the app reads bounds in.
function boxOf(bb) {
  const b = { minX: bb.min[0], minY: bb.min[1], minZ: bb.min[2], maxX: bb.max[0], maxY: bb.max[1], maxZ: bb.max[2] };
  b.width = b.maxX - b.minX; b.height = b.maxY - b.minY;
  b.cx = (b.minX + b.maxX) / 2; b.cy = (b.minY + b.maxY) / 2;
  return b;
}

const emptyTrash = (trash) => { for (const o of trash) { try { o.delete(); } catch { /* already gone */ } } };

// Builds the cutter. shape = { outer, inner } in mm, y pointing DOWN (screen space).
// Model space is y-up, so by default (no mirror) the top view equals the drawing.
// Requires loadManifold() to have completed.
export function buildCutter(shape, params) {
  if (!M) throw new Error('The 3D engine is still loading — one moment.');
  const trash = [];
  try {
    const { solid, outer } = cutterSolid(shape, params, trash);
    const m = meshOf(solid);
    const shapeB = bounds(outer);
    return {
      ...m,
      piece: { width: shapeB.width, height: shapeB.height },
      footprint: { width: m.bounds.width, height: m.bounds.height, height3d: m.bounds.maxZ },
    };
  } finally {
    emptyTrash(trash);
  }
}

// mm of slack on a footprint when deciding whether two cutters run into each other. Bases that
// merely touch are as much one piece of plastic as bases that overlap.
const MERGE_TOUCH = 0.01;

// How wide a shape's base reaches out from its cut line — the same clamps buildCutter applies.
function footWidthOf(params) {
  const p = { ...DEFAULT_PARAMS, ...params };
  return Math.max(Math.max(0.3, p.bladeWidth), p.baseWidth);
}

// Which shapes on a plate have to be built as one object. Two cutters whose bases run into each
// other are one piece of plastic; laying their triangles side by side would leave two surfaces
// crossing inside the print, which is the one thing a slicer cannot make sense of. Shapes that
// merely sit near one another are left alone — a union costs time and gains nothing.
// Returns a list of groups, each a list of indices into `parts`, in the order the shapes come.
function overlapGroups(parts) {
  if (parts.length < 2) return parts.map((_, i) => [i]);
  const outers = parts.map(part => (Array.isArray(part.shape) ? part.shape : part.shape.outer));
  const widths = parts.map(part => footWidthOf(part.params) + MERGE_TOUCH);
  // The boxes are the cheap test and come first: on a plate where nothing is near anything,
  // no outline is ever grown.
  const boxes = outers.map((o, i) => {
    if (!o || o.length < 3) return null;
    const b = bounds(o);
    return { minX: b.minX - widths[i], maxX: b.maxX + widths[i], minY: b.minY - widths[i], maxY: b.maxY + widths[i] };
  });
  const feet = new Array(parts.length).fill(undefined);
  const footOf = (i) => {
    if (feet[i] === undefined) {
      try { feet[i] = offsetPolygon(outers[i], widths[i]); }
      catch { feet[i] = null; }   // an outline Clipper cannot grow is the builder's problem
    }
    return feet[i];
  };
  const parent = parts.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const apart = (a, b) => a.maxX < b.minX || b.maxX < a.minX || a.maxY < b.minY || b.maxY < a.minY;
  for (let a = 0; a < parts.length; a++) {
    for (let b = a + 1; b < parts.length; b++) {
      if (!boxes[a] || !boxes[b] || find(a) === find(b)) continue;
      if (apart(boxes[a], boxes[b])) continue;
      const fa = footOf(a), fb = footOf(b);
      if (!fa || !fb) continue;
      let hit = false;
      try { hit = intersectPolygons([fa], [fb]).some(r => Math.abs(signedArea(r)) > 1e-4); }
      catch { hit = false; }
      if (hit) parent[find(a)] = find(b);
    }
  }
  const groups = new Map();
  for (let i = 0; i < parts.length; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(i);
  }
  return [...groups.values()];
}

// Several cutters on one plate. Each shape is built on its own; shapes that run into each other
// are unioned into a single watertight solid, and the rest simply follow one another in the
// triangle soup. The shapes keep their places on the canvas, so the plate comes out arranged
// the way it is drawn.
export function buildAll(parts) {
  if (!M) throw new Error('The 3D engine is still loading — one moment.');
  if (!parts.length) throw new Error('Draw a closed shape first.');
  const trash = [];
  try {
    const built = parts.map((part, i) => {
      try {
        return cutterSolid(part.shape, part.params, trash);
      } catch (e) {
        // With one shape on the plate the message is about the only thing there is; with several
        // it has to say which one, so it can be found in the shapes list.
        throw new Error(parts.length > 1 ? `${part.label || `Shape ${i + 1}`}: ${e.message}` : e.message);
      }
    });
    const groups = overlapGroups(parts);
    const info = built.map((b, i) => {
      const sb = bounds(b.outer);
      return { label: parts[i].label || `Shape ${i + 1}`, bounds: boxOf(b.solid.boundingBox()),
               piece: { width: sb.width, height: sb.height } };
    });
    const meshes = groups.map(g => {
      let solid = built[g[0]].solid;
      for (let k = 1; k < g.length; k++) { solid = solid.add(built[g[k]].solid); trash.push(solid); }
      return meshOf(solid);
    });

    let n = 0;
    for (const m of meshes) n += m.positions.length;
    const positions = new Float32Array(n);
    let at = 0;
    for (const m of meshes) { positions.set(m.positions, at); at += m.positions.length; }

    const bb = boxOf({
      min: [Math.min(...meshes.map(m => m.bounds.minX)), Math.min(...meshes.map(m => m.bounds.minY)), 0],
      max: [Math.max(...meshes.map(m => m.bounds.maxX)), Math.max(...meshes.map(m => m.bounds.maxY)),
            Math.max(...meshes.map(m => m.bounds.maxZ))],
    });
    const pieceB = bounds(built.map(b => b.outer).flat());
    return {
      positions,
      parts: info,          // one entry per shape on the plate — where it sits, and the piece it cuts
      objects: groups.length, // separate solids in the result; fewer than shapes means some were joined
      triangles: meshes.reduce((t, m) => t + m.triangles, 0),
      bounds: bb,
      piece: { width: pieceB.width, height: pieceB.height },
      footprint: { width: bb.width, height: bb.height, height3d: bb.maxZ },
      volumeMm3: meshes.reduce((v, m) => v + m.volumeMm3, 0),
    };
  } finally {
    emptyTrash(trash);
  }
}

// Bar rectangles (mm polygons, CCW) radiating from the inner shape's centre.
function barShapes(ob, ib, p, angleSign) {
  const L = Math.max(ob.width, ob.height) * 2;
  const bars = [];
  for (let k = 0; k < p.bridgeCount; k++) {
    const a = angleSign * ((p.bridgeAngle * Math.PI) / 180 + (k * 2 * Math.PI) / p.bridgeCount);
    const dx = Math.cos(a), dy = Math.sin(a), nx = -dy * p.bridgeWidth / 2, ny = dx * p.bridgeWidth / 2;
    const r = [
      { x: ib.cx + nx, y: ib.cy + ny }, { x: ib.cx + dx * L + nx, y: ib.cy + dy * L + ny },
      { x: ib.cx + dx * L - nx, y: ib.cy + dy * L - ny }, { x: ib.cx - nx, y: ib.cy - ny },
    ];
    if (signedArea(r) < 0) r.reverse();
    bars.push(r);
  }
  return bars;
}

// Bars from the inner base to the outer base, spread evenly around the inner shape.
function bridgesI(O, I, baseW, p, angleSign = 1) {
  const ib = pathsBounds([I]);
  const ob = pathsBounds([O]);
  const L = Math.max(ob.width, ob.height) * 2;
  const bars = [];
  for (let k = 0; k < p.bridgeCount; k++) {
    const a = angleSign * ((p.bridgeAngle * Math.PI) / 180 + (k * 2 * Math.PI) / p.bridgeCount);
    const dx = Math.cos(a), dy = Math.sin(a), nx = -dy * p.bridgeWidth / 2, ny = dx * p.bridgeWidth / 2;
    bars.push(toClip([
      { x: ib.cx + nx, y: ib.cy + ny }, { x: ib.cx + dx * L + nx, y: ib.cy + dy * L + ny },
      { x: ib.cx + dx * L - nx, y: ib.cy + dy * L - ny }, { x: ib.cx - nx, y: ib.cy - ny },
    ]));
  }
  const region = diffI(offsetI([O], baseW), offsetI([I], -baseW));
  return interI(unionI(bars), region);
}

// 2D preview of the connection bars, in the same (screen) space as the input polygons.
export function bridgeShapes(outerPts, innerPts, params) {
  const p = { ...DEFAULT_PARAMS, ...params };
  if (!innerPts || innerPts.length < 3 || p.bridgeCount <= 0 || p.bridgeWidth <= 0) return [];
  const baseW = Math.max(p.bladeWidth, p.baseWidth);
  try {
    return bridgesI(toClip(outerPts), toClip(innerPts), baseW, p, 1).map(fromClip);
  } catch { return []; }
}


// Binary STL. Coordinates are shifted so the model is centred on X/Y with Z starting at 0.
export function toBinarySTL(positions, name = 'cutter') {
  const triCount = positions.length / 9;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    minX = Math.min(minX, positions[i]); maxX = Math.max(maxX, positions[i]);
    minY = Math.min(minY, positions[i + 1]); maxY = Math.max(maxY, positions[i + 1]);
  }
  const ox = (minX + maxX) / 2, oy = (minY + maxY) / 2;

  const buf = new ArrayBuffer(84 + triCount * 50);
  const view = new DataView(buf);
  const header = new TextEncoder().encode(`Cutter: ${name}`.slice(0, 79));
  new Uint8Array(buf, 0, 80).set(header);
  view.setUint32(80, triCount, true);
  let off = 84;
  for (let i = 0; i < positions.length; i += 9) {
    const ax = positions[i] - ox, ay = positions[i + 1] - oy, az = positions[i + 2];
    const bx = positions[i + 3] - ox, by = positions[i + 4] - oy, bz = positions[i + 5];
    const cx = positions[i + 6] - ox, cy = positions[i + 7] - oy, cz = positions[i + 8];
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    const vals = [nx, ny, nz, ax, ay, az, bx, by, bz, cx, cy, cz];
    for (const v of vals) { view.setFloat32(off, v, true); off += 4; }
    view.setUint16(off, 0, true); off += 2;
  }
  return buf;
}
