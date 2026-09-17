// Project round-trip check — run with:  node tests/project-roundtrip.mjs
// Writes a .cutter file in memory, reads it back and verifies that the restored state builds
// a byte-identical mesh. This is what "open it later and get the same cutter" rests on.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const clipperSrc = fs.readFileSync(path.join(root, 'vendor/clipper.js'), 'utf8');
const mod = { exports: {} };
new Function('module', 'exports', 'window', clipperSrc)(mod, mod.exports, undefined);
globalThis.ClipperLib = mod.exports;

const G = await import(path.join(root, 'js/geometry.js'));
const P = await import(path.join(root, 'js/project.js'));
await G.loadManifold();

const circ = (r, n = 120) => Array.from({ length: n }, (_, i) => ({ x: r * Math.cos(i / n * 2 * Math.PI), y: r * Math.sin(i / n * 2 * Math.PI) }));
const star = Array.from({ length: 10 }, (_, i) => { const r = i % 2 ? 17 : 36, a = i * Math.PI / 5 - Math.PI / 2; return { x: r * Math.cos(a), y: r * Math.sin(a) }; });
// a Bézier-handled contour: the handles must survive the file, or curves reopen as corners
const curved = [
  { x: -30, y: -30, out: { x: 14, y: 0 }, smooth: true },
  { x: 30, y: -30, in: { x: -14, y: 0 }, out: { x: 0, y: 14 }, smooth: true },
  { x: 30, y: 30, in: { x: 0, y: -14 } },
  { x: -30, y: 30 },
];

const at = (pts, dx, dy) => pts.map(p => ({ x: p.x + dx, y: p.y + dy }));

// Each case is a whole plate: a list of shapes, every one with its own mirror and settings.
const cases = [
  ['ring + connections', [
    { shape: { outer: circ(40), inner: circ(20) }, sym: { x: false, y: false }, params: {} },
  ]],
  ['star, tall blade', [
    { shape: { outer: star, inner: [] }, sym: { x: false, y: false }, params: { height: 22, bladeWidth: 0.6, ridge: false } },
  ]],
  ['curved outline, mirrored model', [
    { shape: { outer: curved, inner: [] }, sym: { x: true, y: false }, params: { mirror: true, bridgeAngle: 30 } },
  ]],
  ['both mirrors, no ridge', [
    { shape: { outer: circ(25), inner: circ(12) }, sym: { x: true, y: true }, params: { ridge: false, bridgeCount: 6, bridgeWidth: 3 } },
  ]],
  // Two shapes with different settings: the whole point is that one does not leak into the other.
  ['plate of two, different settings', [
    { shape: { outer: at(circ(20), -40, 0), inner: at(circ(10), -40, 0) }, sym: { x: false, y: false }, params: { height: 12, bridgeCount: 3 } },
    { shape: { outer: at(star, 45, 5), inner: [] }, sym: { x: false, y: false }, params: { height: 25, bladeWidth: 0.7, ridge: false } },
  ]],
  // A shape mirrored about its own centre, sitting away from the canvas origin.
  ['plate of two, one mirrored off-centre', [
    { shape: { outer: at(circ(18), -50, 0), inner: [] }, sym: { x: false, y: false }, params: {} },
    { shape: { outer: at(circ(18), 50, 0), inner: [] }, sym: { x: true, y: false }, symOrigin: { x: 50, y: 0 }, params: { height: 18 } },
  ]],
];

const effective = (l) => (l.sym.x || l.sym.y
  ? { outer: G.symmetrize(l.shape.outer, l.sym, l.symOrigin || { x: 0, y: 0 }) || [], inner: [] }
  : l.shape);
const buildPlate = (layers) => G.buildAll(layers.map(l => ({
  shape: effective(l), params: { ...G.DEFAULT_PARAMS, ...l.params },
}))).positions;

let failed = 0;
for (const [name, layers] of cases) {
  const state = {
    layers: layers.map(l => ({ ...l, symOrigin: l.symOrigin || { x: 0, y: 0 }, bridgeAuto: false })),
    index: 0, active: 'outer', tool: 'move', smoothing: 0.4, lockAspect: true,
    grid: { size: 5, snap: true }, name: 'cutter-test',
  };
  const bytes = P.packProject(state, { stl: G.toBinarySTL(buildPlate(state.layers), 'cutter-test') });
  const back = await P.unpackProject(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));

  const a = buildPlate(state.layers);
  const b = buildPlate(back.layers);

  const same = a.length === b.length && a.every((v, i) => v === b[i]);
  const first = back.layers[0], want = layers[0];
  const stateKept = back.layers.length === layers.length
    && first.sym.x === want.sym.x && first.sym.y === want.sym.y
    && back.grid.size === 5 && back.grid.snap === true && back.name === 'cutter-test'
    && back.layers.every((l, i) => l.params.height === (layers[i].params.height ?? G.DEFAULT_PARAMS.height))
    && back.layers.every((l, i) => l.symOrigin.x === (layers[i].symOrigin?.x ?? 0));
  const handlesKept = name !== 'curved outline, mirrored model'
    || (first.shape.outer[0].out?.x === 14 && first.shape.outer[0].smooth === true && first.shape.outer[1].in?.x === -14);

  const ok = same && stateKept && handlesKept;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}` + (ok ? ` (${layers.length} shape(s), ${a.length / 9} triangles, ${(bytes.length / 1024).toFixed(0)} kB file)`
    : `  mesh:${same} settings:${stateKept} handles:${handlesKept}`));
}

// A file written before shapes were a list must still open, as a plate with one shape on it.
{
  const legacy = {
    format: P.PROJECT_FORMAT, schema: 1, app: 'Cutter', name: 'old-one',
    shape: { outer: circ(30), inner: circ(14) }, sym: { x: false, y: false },
    active: 'outer', tool: 'move', smoothing: 0.4, lockAspect: true, grid: { size: 10, snap: false },
    params: { ...G.DEFAULT_PARAMS, height: 19, bridgeCount: 5 }, bridgeAuto: false, stats: null,
  };
  const back = P.deserializeProject(legacy);
  const ok = back.layers.length === 1 && back.layers[0].params.height === 19
    && back.layers[0].params.bridgeCount === 5 && back.layers[0].shape.inner.length === 120
    && back.name === 'old-one';
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  a schema-1 file opens as a plate of one`);
}

// An outline still being placed is not a shape yet, and the file has to remember that — or a
// plate would reopen with a closed cutter nobody drew on it.
{
  const line = [{ x: -10, y: -10 }, { x: 14, y: -6 }, { x: 4, y: 12 }];
  const state = {
    layers: [
      { shape: { outer: circ(30), inner: [] }, sym: { x: false, y: false }, symOrigin: { x: 0, y: 0 }, params: {}, bridgeAuto: false },
      { shape: { outer: at(line, 70, 0), inner: [] }, sym: { x: false, y: false }, symOrigin: { x: 0, y: 0 },
        params: {}, bridgeAuto: false, open: { outer: true, inner: false } },
    ],
    index: 1, active: 'outer', tool: 'points', smoothing: 0.4, lockAspect: true,
    grid: { size: 10, snap: false }, name: 'half-drawn',
  };
  const bytes = P.packProject(state);
  const back = await P.unpackProject(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const ok = back.layers.length === 2
    && back.layers[0].open.outer === false && back.layers[0].open.inner === false
    && back.layers[1].open.outer === true && back.layers[1].shape.outer.length === 3
    && back.layers[1].shape.outer[1].x === 84 && back.tool === 'points';
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  an unfinished outline comes back unfinished`);
}

// The zip must also be a zip: entry names and the STL come back intact.
const { zipRead } = await import(path.join(root, 'js/zip.js'));
const probe = P.packProject({ layers: [{ shape: { outer: circ(20), inner: [] }, sym: { x: false, y: false }, params: {} }], name: 'probe' },
  { stl: G.toBinarySTL(G.buildCutter(circ(20), {}).positions, 'probe'), png2d: new Uint8Array([137, 80, 78, 71]) });
const files = await zipRead(probe.buffer.slice(probe.byteOffset, probe.byteOffset + probe.byteLength));
const names = [...files.keys()].join(', ');
const zipOk = files.has('project.json') && files.has('model.stl') && files.has('preview-2d.png')
  && files.get('model.stl').length === G.toBinarySTL(G.buildCutter(circ(20), {}).positions, 'probe').byteLength;
if (!zipOk) failed++;
console.log(`${zipOk ? 'PASS' : 'FAIL'}  zip container (${names})`);

console.log(failed ? `\n${failed} case(s) failed.` : '\nAll project round-trips passed.');
process.exit(failed ? 1 : 0);
