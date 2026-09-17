// Mesh integrity check — run with:  node tests/mesh-check.mjs [random-cases]
// Builds cutters with the real geometry pipeline (js/geometry.js + vendor libs) and verifies,
// the way a slicer does (by vertex coordinates), that every edge is shared by exactly two
// triangles with opposite direction. Exit code 1 if any fixed case fails.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// clipper.js is a browser global; load it the same way the page does
const clipperSrc = fs.readFileSync(path.join(root, 'vendor/clipper.js'), 'utf8');
const mod = { exports: {} };
new Function('module', 'exports', 'window', clipperSrc)(mod, mod.exports, undefined);
globalThis.ClipperLib = mod.exports;

const G = await import(path.join(root, 'js/geometry.js'));
await G.loadManifold();

function check(res) {
  const pos = res.positions, edges = new Map();
  const key = (i) => `${Math.fround(pos[i])},${Math.fround(pos[i + 1])},${Math.fround(pos[i + 2])}`;
  for (let i = 0; i < pos.length; i += 9) {
    const k = [key(i), key(i + 3), key(i + 6)];
    for (let e = 0; e < 3; e++) {
      const a = k[e], b = k[(e + 1) % 3];
      const id = a < b ? `${a}|${b}` : `${b}|${a}`, d = a < b ? 1 : -1;
      const c = edges.get(id) || { n: 0, s: 0 }; c.n++; c.s += d; edges.set(id, c);
    }
  }
  let open = 0, nonManifold = 0;
  for (const v of edges.values()) { if (v.n === 1) open++; else if (v.n !== 2 || v.s !== 0) nonManifold++; }
  return { open, nonManifold, triangles: res.triangles, volume: res.volumeMm3 };
}

const circ = (r, n = 120) => Array.from({ length: n }, (_, i) => ({ x: r * Math.cos(i / n * 2 * Math.PI), y: r * Math.sin(i / n * 2 * Math.PI) }));
const star = Array.from({ length: 10 }, (_, i) => { const r = i % 2 ? 17 : 36, a = i * Math.PI / 5 - Math.PI / 2; return { x: r * Math.cos(a), y: r * Math.sin(a) }; });
const fixed = [
  ['ring + 4 connections', { outer: circ(40), inner: circ(20) }, {}],
  ['ring, no connections', { outer: circ(40), inner: circ(20) }, { bridgeCount: 0 }],
  ['outer wall only', circ(40), {}],
  ['ring, no step', { outer: circ(40), inner: circ(20) }, { ridge: false }],
  ['ring, 7 connections rotated', { outer: circ(40), inner: circ(20) }, { bridgeCount: 7, bridgeAngle: 13 }],
  ['star + small hole', { outer: star, inner: circ(8) }, {}],
  ['mirrored', { outer: star, inner: circ(8) }, { mirror: true }],
];
// The starter shapes, flattened and cleaned exactly the way app.js does before building —
// at the size they are inserted at, which is the tight one (a 3 mm base on a 30 mm shape is
// a different problem from a 3 mm base on a 70 mm one), and at the size they are drawn.
const { PRESETS, PRESET_SIZE_MM } = await import(path.join(root, 'js/presets.js'));
const { flatten, mapPts, curveCorners } = await import(path.join(root, 'js/editor.js'));
for (const [key, p] of Object.entries(PRESETS)) {
  const pts = p.make(), b = G.bounds(flatten(pts)), s = PRESET_SIZE_MM / Math.max(b.width, b.height);
  const at = (k) => G.cleanPolygon(flatten(mapPts(pts, q => ({ x: q.x * k, y: q.y * k }))), 0.002);
  fixed.push([`starter shape: ${key} at ${PRESET_SIZE_MM} mm`, at(s), {}]);
  fixed.push([`starter shape: ${key} as drawn`, at(1), {}]);
}

// Rounding the corners of a point-drawn shape curves the anchors where they stand, so what
// reaches the builder is a handful of cubics rather than a traced polyline. The extreme of the
// slider is the one worth checking: the handles are half the way to the next corner, which is
// as far as a curve can bulge before it starts to fold back on itself.
{
  const square = [{ x: -25, y: -25 }, { x: 25, y: -25 }, { x: 25, y: 25 }, { x: -25, y: 25 }];
  const tri = [{ x: 0, y: -30 }, { x: 26, y: 15 }, { x: -26, y: 15 }];
  for (const [name, pts] of [['square', square], ['triangle', tri]]) {
    for (const strength of [0.2, 0.5]) {
      const rounded = G.cleanPolygon(flatten(curveCorners(pts, strength)), 0.002);
      fixed.push([`rounded corners: ${name} at ${strength}`, rounded, {}]);
    }
  }
}

let failed = 0;
for (const [label, shape, params] of fixed) {
  const t0 = Date.now();
  const r = check(G.buildCutter(shape, params));
  const ok = r.open === 0 && r.nonManifold === 0;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: ${r.triangles} triangles, ${r.open} open, ${r.nonManifold} non-manifold, ${r.volume.toFixed(0)} mm³, ${Date.now() - t0} ms`);
}

// Several shapes on one plate. They never touch, so each one keeps its own edges and the whole
// soup has to come out as watertight as its parts — with each shape built from its own settings.
const at = (pts, dx, dy) => pts.map(p => ({ x: p.x + dx, y: p.y + dy }));
const plates = [
  ['plate: two rings side by side', [
    { shape: { outer: at(circ(20), -40, 0), inner: at(circ(10), -40, 0) }, params: {} },
    { shape: { outer: at(circ(20), 40, 0), inner: at(circ(10), 40, 0) }, params: {} },
  ]],
  ['plate: three shapes, each its own settings', [
    { shape: { outer: at(circ(18), -50, 0), inner: null }, params: { height: 12, bladeWidth: 0.5 } },
    { shape: { outer: at(star, 0, 0), inner: at(circ(8), 0, 0) }, params: { height: 20, ridge: false, bridgeCount: 5 } },
    { shape: { outer: at(circ(15), 55, 10), inner: null }, params: { height: 15, baseWidth: 4, baseHeight: 2 } },
  ]],
  ['plate: mirrored, two shapes', [
    { shape: { outer: at(star, -45, 0), inner: at(circ(8), -45, 0) }, params: { mirror: true } },
    { shape: { outer: at(circ(20), 45, 0), inner: null }, params: { mirror: true } },
  ]],
];
for (const [label, parts] of plates) {
  const res = G.buildAll(parts.map(p => ({ ...p, params: { ...G.DEFAULT_PARAMS, ...p.params } })));
  const r = check(res);
  const ok = r.open === 0 && r.nonManifold === 0 && res.parts.length === parts.length;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: ${res.parts.length} shapes, ${r.triangles} triangles, ${r.open} open, ${r.nonManifold} non-manifold, ${r.volume.toFixed(0)} mm³`);
}

// A shape that cannot be built says which one it is, so the message points at a shape in the list.
{
  let msg = '';
  try {
    G.buildAll([
      { label: 'Shape 1', shape: { outer: circ(20), inner: null }, params: { ...G.DEFAULT_PARAMS } },
      { label: 'Shape 2', shape: { outer: circ(20), inner: at(circ(10), 100, 0) }, params: { ...G.DEFAULT_PARAMS } },
    ]);
  } catch (e) { msg = e.message; }
  const ok = /^Shape 2: /.test(msg);
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} plate: a bad shape is named ("${msg}")`);
}

// optional random stress: node tests/mesh-check.mjs 100
const N = parseInt(process.argv[2] || '0', 10);
if (N > 0) {
  let seed = 987; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const blob = (r, n, wob) => Array.from({ length: n }, (_, i) => { const a = i / n * 2 * Math.PI; const rr = r * (1 + wob * Math.sin(3 * a + 1) + wob * 0.5 * Math.cos(5 * a)); return { x: rr * Math.cos(a), y: rr * Math.sin(a) }; });
  let bad = 0, errors = 0;
  for (let k = 0; k < N; k++) {
    const outer = G.cleanPolygon(blob(30 + rnd() * 30, 60 + Math.floor(rnd() * 300), rnd() * 0.3), 0.002);
    const inner = rnd() < 0.7 ? G.cleanPolygon(blob(8 + rnd() * 10, 40 + Math.floor(rnd() * 200), rnd() * 0.3), 0.002) : null;
    const params = { bladeWidth: 0.4 + rnd() * 0.6, baseWidth: 2 + rnd() * 4, baseHeight: 1 + rnd() * 3, ridge: rnd() < 0.7, ridgeWidth: 0.6 + rnd(), ridgeHeight: 2 + rnd() * 6, bridgeCount: Math.floor(rnd() * 7), bridgeWidth: 1 + rnd() * 6, bridgeAngle: rnd() * 90, mirror: rnd() < 0.5 };
    try {
      const r = check(G.buildCutter({ outer, inner }, params));
      if (r.open || r.nonManifold) { bad++; console.log(`  random case ${k}: ${r.open} open, ${r.nonManifold} non-manifold`, JSON.stringify(params)); }
    } catch (e) { errors++; }
  }
  console.log(`random: ${N} cases, ${bad} with bad edges, ${errors} rejected by validation`);
}
process.exit(failed ? 1 : 0);
